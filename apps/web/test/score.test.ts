/**
 * `scoreline`, and the four ways a model-composed soundtrack goes wrong quietly.
 *
 * 1. **A pattern that expands to the wrong place.** Bar ranges, repeated step strings
 *    and ties are three multiplications between what the model wrote and what the
 *    sequencer plays, and every one of them is off-by-one country. A lane that lands one
 *    sixteenth late still renders, still draws and still exports — it is simply wrong,
 *    and nothing in the interface can say so.
 * 2. **A rule that does not fire.** The whole claim of this file's design is that a
 *    score is checkable: unknown lanes, degrees outside a register, budgets the render
 *    cache cannot hold. A rule that silently passes is worse than one that does not
 *    exist, because the fallback never runs and the failure arrives as silence.
 * 3. **A note the voices cannot play.** Every note becomes soundline text through the
 *    same templates a seeded lane uses. If a model's pitch or length produces a recipe
 *    that does not parse, the lane is silently silent.
 * 4. **A hint that is not an instruction.** Every rejection goes back to a model in a
 *    repair loop. A rule id with no imperative fix costs a whole trip.
 */

import { describe, expect, it } from 'vitest';
import { parseWithDiagnostics } from '@txt2sfx/core';
import {
  DRUM,
  LANES,
  STEPS_PER_BAR,
  stepSeconds,
  type LoopTrack,
} from '../src/lib/loop.js';
import { voiceFor } from '../src/lib/loop-voice.js';
import {
  SCORE_RULES,
  extractScore,
  laneFromScore,
  parseScore,
  scoreDocument,
  trackFromScore,
  validateScore,
  type ScoreContext,
} from '../src/lib/score.js';
import { laneTable, repairMessage, scoreSystemPrompt } from '../src/lib/loop-agent.js';

const BOSS = `loop "molten throne" 150bpm D min 16 bars

lane drums "toms marching on the floor"
  kick  1-15  X......x..X.....
  kick  16    X......x..X..x.x
  snare 1-16  ....X.......X...
  hat   1-16  x.x.x.x.x.x.x.x.

lane bass "eighth-note grind that lifts to the fifth"
  1-8   X=x=X=x=X=x=X=x=  0 0 0 4 0 0 -3 4
  9-16  X=x=X=x=X=x=X=x=  3 3 3 4 3 3 0 4

lane lead "a siren that climbs into the wrap"
  13-16  X===x===X===x===  7 8 9 11
`;

const NEW: ScoreContext = { mode: 'new', bars: 16, existing: [] };

function parse(text: string) {
  const result = parseScore(text);
  return { ...result, all: [...result.issues, ...validateScore(result.score, NEW)] };
}

describe('reading a score', () => {
  it('reads the header, the lanes and their captions', () => {
    const { score, all } = parse(BOSS);
    expect(all.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(score.header).toMatchObject({ name: 'molten throne', bpm: 150, key: 'D min', bars: 16 });
    expect(score.lanes.map((lane) => lane.name)).toEqual(['drums', 'bass', 'lead']);
    expect(score.lanes[0]?.caption).toBe('toms marching on the floor');
  });

  /* The fenced block is what the prompt asks for; a bare score is a model that got the
     music right and the formatting wrong, and spending a repair trip on punctuation
     would be the loop wasting the user's time on our own convention. */
  it('takes the score out of a fence, or out of a bare reply', () => {
    expect(extractScore('here you go:\n```scoreline\nloop "x" 90bpm A min 8 bars\n```\nenjoy')).toBe(
      'loop "x" 90bpm A min 8 bars',
    );
    expect(extractScore('loop "x" 90bpm A min 8 bars')).toBe('loop "x" 90bpm A min 8 bars');
  });
});

describe('expanding a pattern', () => {
  const track = trackFromScore(parse(BOSS).score, { id: 't', preset: 'boss-fight', prompt: 'p', salt: '1' });
  const lane = (name: string) => track.lanes.find((entry) => entry.name === name);

  it('names the track what the model named it, and keeps who composed it', () => {
    expect(track.name).toBe('molten throne');
    expect(track.composedBy).toBe('model');
    expect(track.bpm).toBe(150);
  });

  /* One row per fifteen bars plus one for the sixteenth: the fill is the bar that
     differs, and a range that quietly covered it twice would double the kick. */
  it('repeats a one-bar pattern across its range and lets the last bar differ', () => {
    const kicks = lane('drums')?.notes.filter((note) => note.midi === DRUM.kick) ?? [];
    /* Three per bar for fifteen bars, five in the fill. */
    expect(kicks.length).toBe(15 * 3 + 5);
    expect(kicks.filter((note) => note.step === 0)).toHaveLength(1);
    /* The fill's extra hits are in the last bar and nowhere else. */
    const last = kicks.filter((note) => note.step >= 15 * STEPS_PER_BAR);
    expect(last.map((note) => note.step % STEPS_PER_BAR)).toEqual([0, 7, 10, 13, 15]);
  });

  it('turns a run of ties into one held note', () => {
    const first = lane('lead')?.notes[0];
    expect(first?.length).toBe(4);
    /* Bar 13 is the entrance: nothing before it. */
    expect(first?.step).toBe(12 * STEPS_PER_BAR);
    expect(lane('lead')?.notes.every((note) => note.step >= 12 * STEPS_PER_BAR)).toBe(true);
  });

  /* Degrees are consumed across the whole row and wrap, which is what lets a two-bar
     riff be one line. Getting the wrap wrong transposes half the bass line. */
  it('consumes degrees across the row and wraps them', () => {
    const notes = lane('bass')?.notes ?? [];
    const bar1 = notes.filter((note) => note.step < STEPS_PER_BAR);
    /* Eight hits a bar, eight degrees: the second bar starts the list again. */
    expect(bar1).toHaveLength(8);
    const bar2 = notes.filter((note) => note.step >= STEPS_PER_BAR && note.step < 2 * STEPS_PER_BAR);
    expect(bar2.map((note) => note.midi)).toEqual(bar1.map((note) => note.midi));
    /* And the second row transposed the whole thing up a third. */
    const bar9 = notes.filter((note) => note.step >= 8 * STEPS_PER_BAR && note.step < 9 * STEPS_PER_BAR);
    expect(bar9[0]?.midi).toBeGreaterThan(bar1[0]?.midi ?? 0);
  });

  it('accents are three velocities and nothing between them', () => {
    const gains = new Set((lane('drums')?.notes ?? []).map((note) => note.gain));
    for (const gain of gains) expect([0.9, 0.6, 0.35]).toContain(Number(gain.toFixed(2)));
  });

  /* The join between this file and everything that already existed. A note that cannot
     become a recipe is a lane that is silently silent — the same failure `loop.test.ts`
     guards for the seeded composer. */
  it('produces notes every voice template can turn into a recipe that parses', () => {
    const context = { stepSeconds: stepSeconds(track), brightness: 0 };
    for (const entry of track.lanes) {
      for (const note of entry.notes) {
        const text = voiceFor(entry.name, note, context);
        expect(parseWithDiagnostics(text).ast, `${entry.name} ${String(note.midi)}`).not.toBeNull();
      }
    }
  });

  it('drops a lane the sequencer has no instrument for rather than playing silence', () => {
    const written = parseScore('lane theremin "nope"\n  1-4  X...  0\n').score;
    expect(trackFromScore(written, { id: 't', preset: 'p', prompt: '', salt: '1' }).lanes).toEqual([]);
  });
});

describe('the rules', () => {
  const errors = (text: string, context: ScoreContext = NEW): string[] => {
    const result = parseScore(text);
    return [...result.issues, ...validateScore(result.score, context)]
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.rule);
  };

  it('demands a header on a new track and refuses one on an added lane', () => {
    expect(errors('lane bass "x"\n  1-4  X...  0\n')).toContain('score.no-header');
    expect(errors(BOSS, { mode: 'add', bars: 16, existing: ['pads'] })).toContain('score.header-in-add');
  });

  it('holds the header to what the sequencer can play', () => {
    expect(errors('loop "x" 40bpm D min 16 bars\nlane bass "b"\n  1-4  X...  0\n')).toContain('score.bpm-range');
    expect(errors('loop "x" 120bpm D min 12 bars\nlane bass "b"\n  1-4  X...  0\n')).toContain('score.bars');
    expect(errors('loop "" 120bpm D min 16 bars\nlane bass "b"\n  1-4  X...  0\n')).toContain('score.name-length');
  });

  it('refuses a lane that is not an instrument, and one that is already playing', () => {
    expect(errors('loop "x" 120bpm D min 8 bars\nlane guitar "g"\n  1-4  X...  0\n')).toContain('lane.unknown');
    expect(errors('lane bass "b"\n  1-4  X...  0\n', { mode: 'add', bars: 8, existing: ['bass'] })).toContain(
      'lane.exists',
    );
  });

  /* A bar written twice is the failure a repeat count would have made unlocatable: the
     range grammar exists so the fill can be named, and this is the rule that makes it
     mean something. */
  it('catches two rows of the same part covering one bar', () => {
    expect(
      errors('loop "x" 120bpm D min 8 bars\nlane drums "d"\n  kick 1-8  X...............\n  kick 4  X...x...........\n'),
    ).toContain('row.overlap');
  });

  it('catches a pattern that does not fit its bars', () => {
    expect(errors('loop "x" 120bpm D min 8 bars\nlane bass "b"\n  1-4  X..x..x  0\n')).toContain('pattern.length');
    /* Three bars of pattern across four bars of range divides into nothing. */
    expect(errors(`loop "x" 120bpm D min 8 bars\nlane bass "b"\n  1-4  ${'X...............'.repeat(3)}  0\n`)).toContain(
      'pattern.length',
    );
  });

  it('catches a tie with nothing to tie to, and a row of rests', () => {
    expect(errors('loop "x" 120bpm D min 8 bars\nlane bass "b"\n  1-4  ==..X...........  0\n')).toContain(
      'pattern.orphan-tie',
    );
    expect(errors('loop "x" 120bpm D min 8 bars\nlane bass "b"\n  1-4  ................  0\n')).toContain(
      'pattern.all-rest',
    );
  });

  it('keeps degrees inside a register the lane can sound', () => {
    expect(errors('loop "x" 120bpm D min 8 bars\nlane bass "b"\n  1-4  X...............  40\n')).toContain(
      'pattern.degree-range',
    );
    expect(errors('loop "x" 120bpm D min 8 bars\nlane bass "b"\n  1-4  X...............\n')).toContain(
      'pattern.no-degrees',
    );
    expect(errors('loop "x" 120bpm D min 8 bars\nlane drums "d"\n  kick 1-4  X...............  0\n')).toContain(
      'row.degrees-on-kit',
    );
    expect(errors('loop "x" 120bpm D min 8 bars\nlane drums "d"\n  1-4  X...............\n')).toContain(
      'row.piece-missing',
    );
  });

  /* Every event is a scheduled render and every distinct voice is a cached one. The
     budgets are what stop a score from turning one press into a minute of CPU. */
  it('refuses a score the mixdown cannot afford', () => {
    const dense = Object.keys(LANES)
      .slice(0, 5)
      .map((name, index) => {
        const row = LANES[name]?.drum === true ? '  kick 1-16  XXXXXXXXXXXXXXXX\n' : `  1-16  XXXXXXXXXXXXXXXX  ${String(index)}\n`;
        return `lane ${name} "x"\n${row}`;
      })
      .join('');
    expect(errors(`loop "x" 120bpm D min 16 bars\n${dense}`)).toContain('score.note-budget');
  });

  it('warns rather than blocks when two lanes play the same part', () => {
    const twins = 'lane bass "a"\n  1-8  X...............  0\nlane lead "b"\n  1-8  X...............  0\n';
    const result = parseScore(`loop "x" 120bpm D min 8 bars\n${twins}`);
    const issues = validateScore(result.score, NEW);
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(issues.map((issue) => issue.rule)).toContain('score.monotony');
  });

  /* Both readers of an issue, tested as one: a human needs to know what broke, and the
     model in the repair loop needs an instruction it can act on. */
  it('gives every rule an imperative hint and a stable id', () => {
    for (const entry of SCORE_RULES) {
      expect(entry.rule, entry.rule).toMatch(/^[a-z]+\.[a-z-]+$/);
      expect(entry.hint.trim(), entry.rule).not.toBe('');
      expect(entry.hint, entry.rule).toMatch(/^[A-Z]/);
    }
  });

  it('sends back the failures and nothing else', () => {
    const result = parseScore('loop "x" 40bpm D min 12 bars\nlane bass "b"\n  1-4  X..x  0\n');
    const message = repairMessage([...result.issues, ...validateScore(result.score, NEW)]);
    expect(message).toContain('score.bpm-range');
    expect(message).toContain('score.bars');
    expect(message).toContain('Set the tempo between');
  });
});

describe('what the model is told', () => {
  /* The lane table is generated from `LANES` itself. A table typed into a prompt is a
     table that goes stale the first time somebody adds a lane, and the failure is
     silent: the model keeps writing an instrument the sequencer no longer has. */
  it('teaches every lane the sequencer actually has', () => {
    const table = laneTable();
    for (const name of Object.keys(LANES)) expect(table, name).toContain(name);
    const prompt = scoreSystemPrompt();
    for (const name of Object.keys(LANES)) expect(prompt, name).toContain(name);
    expect(prompt).toContain('X` accent');
  });

  /* What the next request shows the model. A lane the seeded composer wrote has no
     block, and claiming it does — or omitting it entirely — is how a model ends up
     doubling a part that is already playing. */
  it('describes the current arrangement, including the lanes it did not write', () => {
    const written = parse(BOSS);
    const track: LoopTrack = {
      ...trackFromScore(written.score, { id: 't', preset: 'boss-fight', prompt: 'p', salt: '1' }),
    };
    const mixed: LoopTrack = {
      ...track,
      lanes: [...track.lanes, { name: 'pads', hue: 195, notes: [], salt: 'seed' }],
    };
    const document = scoreDocument(mixed);
    expect(document).toContain('loop "molten throne" 150bpm D min 16 bars');
    expect(document).toContain('lane drums');
    expect(document).toContain('built-in composer: pads');
  });
});

describe('one lane on its own', () => {
  it('places an added lane at its own hue and keeps the block it came from', () => {
    const { score } = parseScore('lane arp "circling the triad"\n  1-8  x.x.x.x.x.x.X...  0 2 4 7\n');
    const lane = laneFromScore(score.lanes[0]!, { key: 'A min', bars: 8, index: 3, salt: 'add-3' });
    expect(lane.name).toBe('arp');
    expect(lane.caption).toBe('circling the triad');
    expect(lane.score).toContain('lane arp');
    expect(lane.notes.length).toBe(8 * 7);
    expect(lane.notes.every((note) => note.step < 8 * STEPS_PER_BAR)).toBe(true);
  });
});
