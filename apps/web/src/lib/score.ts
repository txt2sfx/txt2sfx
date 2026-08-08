/**
 * `scoreline`: the arrangement a model writes, and the rules it is held to.
 *
 * ## What this reverses, and what it leaves alone
 *
 * `lib/loop.ts` used to open with "the composer is a function, not a model", and gave an
 * honest reason: a melody cannot be validated the way a soundline can, because there is
 * no physics of a chord progression for a validator to check.
 *
 * Half of that is still true and nothing here pretends otherwise — there is no validator
 * for taste. What the argument missed is that a *score* has plenty of physics short of
 * taste: a closed lane table, a sixteenth-note grid, a register each voice family can
 * actually sound, a note budget the mixdown can afford, a bar count the wrap can fold.
 * All of that is exactly as checkable as `pop.max-duration`. So the reversal is narrow:
 * **the model replaces the six pattern generators and the preset's four numbers, and
 * nothing else.** It decides when a voice fires and at what pitch — which is precisely
 * the two things `loop.ts` says it owns — and the voices, the mixdown, the seamless wrap
 * and the exports below it never learn who composed.
 *
 * ## Why a text DSL and not JSON
 *
 * The case for JSON is real: models emit it reliably, Gemini can enforce a schema
 * server-side, and there is no parser to write. It buys less than it looks like.
 *
 * - **A schema enforces shape, and shape was never the hard part.** Overlapping bar
 *   ranges, ties that begin a note, two lanes playing the same thing, a note budget the
 *   render cache cannot hold — every rule below needs a hand-written checker whichever
 *   container the data arrives in. And this project already knows that a parser with a
 *   line number repairs better than a schema rejection: `line 4: step string is 15
 *   characters, a bar is 16` is an instruction, where a JSON pointer into a 200-element
 *   array is archaeology.
 * - **The score is the storage format.** `useLoop.ts` persists nothing because preset
 *   plus prompt plus salt reproduce a seeded arrangement for free. A model-composed one
 *   is reproducible by nothing and cost a model call, so it has to be written down — and
 *   the playground's rule for work that exists nowhere else is to keep it. A few hundred
 *   bytes of readable text is a thing to keep; a note array is a schema to migrate.
 * - **The score is also the model's *reading* format.** Add tracks and retry only work
 *   if the model can see what is already playing, and a format that reads well is the
 *   one that writes well: patterns as strings, not four fields per sixteenth.
 * - **It is in character.** The unit of exchange here is a text DSL a model writes and a
 *   deterministic checker judges. A sibling DSL reuses that whole habit.
 *
 * ## The grammar
 *
 * ```text
 * loop "molten throne" 150bpm D min 16 bars
 *
 * lane drums "toms marching on the floor"
 *   kick  1-15  X......x..X.....
 *   kick  16    X......x..X..x.x
 *   snare 1-16  ....X.......X...
 *
 * lane bass "eighth-note grind that lifts to the fifth"
 *   1-8   X=x=X=x=X=x=X=x=  0 0 0 4 0 0 -3 4
 *   9-16  X=x=X=x=X=x=X=x=  3 3 3 4 3 3 0 4
 * ```
 *
 * Four decisions in that, each of which could have gone another way:
 *
 * - **One character per sixteenth.** `X` accent, `x` normal, `-` ghost, `.` rest, `=`
 *   tie. Three velocities rather than a number per note, because {@link VELOCITY_STEP}
 *   already argues that a listener does not resolve more than a few levels on a
 *   percussive hit, and because a per-note number is the model reaching into the part of
 *   the system where structure and numbers are kept apart. The model writes accents,
 *   which are structure; the lane's `level` and the voice's envelopes stay numbers it
 *   never touches.
 * - **Bar ranges, not repeat counts.** A row covers `1-15` or `16`. A repeat count has
 *   to *sum* to the bar total — arithmetic a model fumbles and a checker can only reject,
 *   never locate — while a range only has to lie inside it. Sixteen bars of hats is one
 *   line, and the bar that differs is its own line, which is the diff.
 * - **Scale degrees, not MIDI.** `0` is the key's root in the lane's own register, `7`
 *   the octave above, `-3` the sixth below; `degreeToMidi` already runs past the ends of
 *   the scale in both directions for exactly this. A model that never sees a MIDI number
 *   cannot write an out-of-key one.
 * - **Silence is unwritten.** Bars no row covers do not sound, so a lead entering at bar
 *   13 is one line rather than twelve bars of dots.
 *
 * ## The rules are a table, and each one is an instruction
 *
 * Same shape and same reason as `INVARIANTS` in `packages/core`: a stable id so a
 * failure can be counted across runs, what was written, what is required, and an
 * imperative fix — because the second reader of every one of these is a model in a
 * repair loop. {@link SCORE_RULES} is the whole contract and is what the repair message
 * quotes verbatim.
 *
 * @packageDocumentation
 */

import {
  DRUM,
  LANES,
  LANE_HUES,
  STEPS_PER_BAR,
  VELOCITY_STEP,
  degreeToMidi,
  parseKey,
  type LoopLane,
  type LoopNote,
  type LoopTrack,
} from './loop.js';

/* ------------------------------------------------------------------------- *
 * Bounds
 * ------------------------------------------------------------------------- */

/**
 * Tempo bounds.
 *
 * The floor keeps a sixteen-bar loop under a minute of audio — at 60 bpm that is 64 s,
 * which is already 2.8 M samples of mixdown per audition. The ceiling keeps a sixteenth
 * (75 ms at 200 bpm) above `loop-voice.ts`'s `MIN_VOICE_MS`, past which every note is
 * clamped to the same length and the grid stops meaning anything.
 */
export const BPM_RANGE = { min: 60, max: 200 } as const;

/** Bar counts a game loop phrases in. Anything else fights the four-bar progression. */
export const BAR_COUNTS: readonly number[] = [4, 8, 16];

/**
 * How many note events a score may carry.
 *
 * Roughly four times what the seeded composer writes for its densest preset, which is
 * the honest ceiling: every event is a scheduled render in `mixLoop`, and past this the
 * mixdown stops feeling like a keypress.
 */
export const MAX_EVENTS = 800;

/**
 * How many *distinct* voices it may need.
 *
 * A voice is one soundline recipe — pitch, velocity and length together — and each is
 * rendered once and cached. Velocity quantization is what keeps a sixteen-bar hat lane
 * at three or four of them; a score that needs more than this is writing a different
 * note every time rather than a part.
 */
export const MAX_VOICES = 160;

/** Lanes in one track. One past the largest preset; past that the ceiling arranges. */
export const MAX_LANES = 6;

/** Degrees a lane's register can actually sound: two octaves up, one down. */
export const DEGREE_RANGE = { min: -7, max: 14 } as const;

/** Notes in one chord. Each is a separate render, and a five-note pad is mud anyway. */
export const MAX_CHORD = 4;

/** A caption is one line under a composing indicator, not a paragraph. */
export const MAX_CAPTION = 60;

/** A track name is a row in the rail. */
export const MAX_NAME = 40;

/**
 * What each step character means, as a velocity.
 *
 * Already on the {@link VELOCITY_STEP} grid, so the render cache collapses them without
 * a rounding step that could quietly move them.
 */
export const STEP_VELOCITY: Readonly<Record<string, number>> = { X: 0.9, x: 0.6, '-': 0.35 };

/** The percussion pieces a drum row may name, and the GM note each becomes. */
export const PIECES: Readonly<Record<string, number>> = {
  kick: DRUM.kick,
  snare: DRUM.snare,
  clap: DRUM.clap,
  rim: DRUM.rim,
  hat: DRUM.hatClosed,
  ohat: DRUM.hatOpen,
};

/* ------------------------------------------------------------------------- *
 * The parsed shape
 * ------------------------------------------------------------------------- */

/** The `loop` line. Absent in an add reply, where the track is already settled. */
export interface ScoreHeader {
  readonly name: string;
  readonly bpm: number;
  /** `"D min"` — the same string {@link parseKey} reads. */
  readonly key: string;
  readonly bars: number;
  readonly line: number;
}

/** One row of a lane: a span of bars, a pattern, and what pitches it plays. */
export interface ScoreRow {
  /** The kit piece, on a drum lane. `null` on a pitched one. */
  readonly piece: string | null;
  /** 1-based, inclusive. */
  readonly from: number;
  readonly to: number;
  readonly steps: string;
  /** Degrees in the order hits consume them; each entry is one chord. */
  readonly chords: readonly (readonly number[])[];
  readonly line: number;
}

/** One instrument's part, as written. */
export interface ScoreLane {
  readonly name: string;
  /** The model's own one-line description, shown while the lane is being built. */
  readonly caption: string | null;
  readonly rows: readonly ScoreRow[];
  readonly line: number;
  /** The block verbatim, kept so the next request can show the model what is playing. */
  readonly text: string;
}

/** A whole score, or the lanes half of one. */
export interface Score {
  readonly header: ScoreHeader | null;
  readonly lanes: readonly ScoreLane[];
}

/**
 * One thing wrong with a score.
 *
 * Deliberately *not* `ValidationIssue` from `@txt2sfx/shared`: that type's `loc` carries
 * a byte offset and a span into a soundline, and inventing those for a different grammar
 * would be a lie in a field a reader is entitled to trust. Same four parts otherwise,
 * for the same reason — the second reader is a model in a repair loop.
 */
export interface ScoreIssue {
  readonly severity: 'error' | 'warning';
  /** Stable machine-readable rule id, e.g. `pattern.length`. */
  readonly rule: string;
  /** What the score actually says. */
  readonly got: string;
  /** What the rule demands. */
  readonly expected: string;
  /** Imperative fix, phrased as an instruction to the model. */
  readonly hint: string;
  /** 1-based line in the score, when the failure has one. */
  readonly line?: number;
}

/* ------------------------------------------------------------------------- *
 * The rule table
 * ------------------------------------------------------------------------- */

/**
 * Every rule, with the sentence that goes back to the model.
 *
 * An array of ids and hints rather than a set of `throw`s scattered through the parser,
 * for the reason `INVARIANTS` is one: the contract is a thing you can read in one place,
 * count failures of, and add to without touching what enforces it. `{...}` placeholders
 * are filled at the point of failure.
 */
export const SCORE_RULES: readonly { readonly rule: string; readonly hint: string }[] = [
  { rule: 'score.no-header', hint: 'Start the score with `loop "<name>" <bpm>bpm <key> <bars> bars`.' },
  {
    rule: 'score.header-in-add',
    hint: 'Remove the `loop` header — this track already has a tempo, key and length. Reply with `lane` blocks only.',
  },
  { rule: 'score.name-length', hint: `Give the track a short name, 1–${String(MAX_NAME)} characters.` },
  {
    rule: 'score.bpm-range',
    hint: `Set the tempo between ${String(BPM_RANGE.min)} and ${String(BPM_RANGE.max)} bpm.`,
  },
  { rule: 'score.bars', hint: `Use ${BAR_COUNTS.join(', ')} bars — a game loop phrases in powers of two.` },
  { rule: 'score.key', hint: 'Write the key as a root and a mode, like `D min` or `G maj`.' },
  { rule: 'score.no-lanes', hint: 'Write at least one `lane` block — a score with no lanes is silence.' },
  {
    rule: 'score.note-budget',
    hint: `Cut the arrangement below ${String(MAX_EVENTS)} note events — thin the densest lanes or drop a doubling.`,
  },
  {
    rule: 'score.voice-budget',
    hint: `Reuse pitches, accents and lengths across bars — this score needs more than ${String(MAX_VOICES)} distinct renders.`,
  },
  {
    rule: 'score.monotony',
    hint: 'Differentiate the two lanes — the same rhythm on the same degrees is one part played twice. Change one register, one rhythm, or drop it.',
  },
  { rule: 'lane.unknown', hint: 'Use a lane from the table — there are no other instruments.' },
  { rule: 'lane.duplicate', hint: 'Merge the two blocks into one — a lane is declared once.' },
  { rule: 'lane.exists', hint: 'That lane is already playing. Propose one the track does not have.' },
  { rule: 'lane.count', hint: `Keep to at most ${String(MAX_LANES)} lanes — the mix has finite headroom.` },
  { rule: 'lane.empty', hint: 'Give the lane at least one note, or remove it.' },
  { rule: 'lane.caption-length', hint: `Shorten the caption to at most ${String(MAX_CAPTION)} characters.` },
  { rule: 'row.unreadable', hint: 'Write a row as `[piece] <bars> <steps> [degrees]`, e.g. `1-8  X...x...  0 4`.' },
  { rule: 'row.piece-unknown', hint: `Name one of: ${Object.keys(PIECES).join(', ')}.` },
  { rule: 'row.piece-missing', hint: 'Name the kit piece first on a drum row: `kick 1-16 X...`.' },
  { rule: 'row.degrees-on-kit', hint: 'Remove the degrees — this lane is percussion and takes none.' },
  { rule: 'row.bar-range', hint: 'Keep bar ranges inside the track, first bar no later than the last.' },
  { rule: 'row.overlap', hint: 'Split the ranges so each bar of this part is written once.' },
  {
    rule: 'pattern.length',
    hint: `Make the step string a multiple of ${String(STEPS_PER_BAR)} characters that divides its bar range evenly.`,
  },
  { rule: 'pattern.symbols', hint: 'Use only `X x - . =` in a step string.' },
  { rule: 'pattern.orphan-tie', hint: 'Start the tie after a hit — `=` extends a sounding note, it cannot begin one.' },
  { rule: 'pattern.all-rest', hint: 'Delete the silent row, or put notes in it.' },
  { rule: 'pattern.degree-range', hint: `Keep degrees between ${String(DEGREE_RANGE.min)} and ${String(DEGREE_RANGE.max)}.` },
  { rule: 'pattern.no-degrees', hint: 'List at least one degree after the steps; hits consume them in order and wrap.' },
  { rule: 'pattern.chord-size', hint: `Voice the chord with at most ${String(MAX_CHORD)} notes.` },
  { rule: 'mix.silent', hint: 'Raise the accents — the score renders nearly silent. Use `X` and `x` where `-` carries the part.' },
];

const HINTS: Readonly<Record<string, string>> = Object.fromEntries(
  SCORE_RULES.map((entry) => [entry.rule, entry.hint]),
);

/** Build an issue from the table, so a rule id can never arrive without its instruction. */
function issue(
  rule: string,
  parts: { severity?: 'error' | 'warning'; got: string; expected: string; line?: number; hint?: string },
): ScoreIssue {
  return {
    severity: parts.severity ?? 'error',
    rule,
    got: parts.got,
    expected: parts.expected,
    hint: parts.hint ?? HINTS[rule] ?? 'Fix the score.',
    ...(parts.line === undefined ? {} : { line: parts.line }),
  };
}

/* ------------------------------------------------------------------------- *
 * Parsing
 * ------------------------------------------------------------------------- */

/**
 * Pull the score out of whatever the model actually replied with.
 *
 * The prompt asks for one fenced block and nothing else, and models mostly comply — but
 * "mostly" is not a parser. A fenced block wins; failing that, the reply is taken whole,
 * because a model that answered with a bare score is right about the music and wrong
 * about the formatting, and rejecting it would spend a repair trip on punctuation.
 */
export function extractScore(reply: string): string {
  const fenced = /```(?:scoreline|score|text)?\s*\n([\s\S]*?)```/.exec(reply);
  return (fenced?.[1] ?? reply).trim();
}

const HEADER = /^loop\s+"([^"]*)"\s+(\d+(?:\.\d+)?)\s*bpm\s+([A-Ga-g][#b]?)\s*(min|maj)[a-z]*\s+(\d+)\s*bars?\s*$/;
const LANE = /^lane\s+([A-Za-z]+)\s*(?:"([^"]*)")?\s*$/;
const RANGE = /^(\d+)(?:-(\d+))?$/;
const STEPS = /^[Xx\-.=]+$/;
const CHORD = /^-?\d+(?:\+-?\d+)*$/;

/**
 * Read a score.
 *
 * Never throws and never stops at the first problem: a reply with one unreadable row and
 * four good lanes should come back as four lanes plus one located complaint, so the
 * repair message can name the line instead of "the score did not parse".
 */
export function parseScore(text: string): { readonly score: Score; readonly issues: readonly ScoreIssue[] } {
  const issues: ScoreIssue[] = [];
  const lines = text.split(/\r?\n/);

  let header: ScoreHeader | null = null;
  /** A lane under construction: rows arrive line by line, so this one is mutable. */
  interface Draft {
    name: string;
    caption: string | null;
    rows: ScoreRow[];
    line: number;
    text: string;
  }
  const lanes: Draft[] = [];
  let current: Draft | null = null;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? '';
    const line = index + 1;
    const trimmed = raw.trim();
    /* `#` is not in the grammar; it is here because a model that annotates its own score
       has done nothing wrong, and a comment is cheaper to ignore than to repair. */
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const asHeader = HEADER.exec(trimmed);
    if (asHeader !== null) {
      header = {
        name: (asHeader[1] ?? '').trim(),
        bpm: Math.round(Number(asHeader[2] ?? '0')),
        key: `${(asHeader[3] ?? 'A').toUpperCase()} ${asHeader[4] ?? 'min'}`,
        bars: Number(asHeader[5] ?? '0'),
        line,
      };
      current = null;
      continue;
    }

    const asLane = LANE.exec(trimmed);
    if (asLane !== null) {
      current = {
        name: (asLane[1] ?? '').toLowerCase(),
        caption: (asLane[2] ?? '').trim() === '' ? null : (asLane[2] ?? '').trim(),
        rows: [],
        line,
        text: trimmed,
      };
      lanes.push(current);
      continue;
    }

    if (current === null) {
      /* A line before any lane and not a header. Reported once rather than per line, so
         a paragraph of prose above the score costs one complaint. */
      if (!issues.some((entry) => entry.rule === 'row.unreadable')) {
        issues.push(
          issue('row.unreadable', {
            got: trimmed.slice(0, 60),
            expected: 'a `loop` header or a `lane` block',
            line,
          }),
        );
      }
      continue;
    }

    const row = parseRow(trimmed, line, issues);
    if (row !== null) {
      current.rows.push(row);
      current.text = `${current.text}\n  ${trimmed}`;
    }
  }

  return { score: { header, lanes }, issues };
}

/** One row, or `null` with the reason recorded. */
function parseRow(text: string, line: number, issues: ScoreIssue[]): ScoreRow | null {
  const tokens = text.split(/\s+/);
  let at = 0;

  let piece: string | null = null;
  const first = tokens[at] ?? '';
  if (RANGE.exec(first) === null) {
    piece = first.toLowerCase();
    at++;
    if (!(piece in PIECES)) {
      issues.push(
        issue('row.piece-unknown', { got: piece, expected: Object.keys(PIECES).join(' | '), line }),
      );
      return null;
    }
  }

  const range = RANGE.exec(tokens[at] ?? '');
  if (range === null) {
    issues.push(
      issue('row.unreadable', { got: text.slice(0, 60), expected: '[piece] <bars> <steps> [degrees]', line }),
    );
    return null;
  }
  at++;
  const from = Number(range[1] ?? '1');
  const to = range[2] === undefined ? from : Number(range[2]);

  const steps = tokens[at] ?? '';
  if (!STEPS.test(steps)) {
    issues.push(
      issue(steps === '' ? 'row.unreadable' : 'pattern.symbols', {
        got: steps === '' ? text.slice(0, 60) : steps,
        expected: 'characters from `X x - . =`',
        line,
      }),
    );
    return null;
  }
  at++;

  const chords: number[][] = [];
  for (; at < tokens.length; at++) {
    const token = tokens[at] ?? '';
    if (token === '') continue;
    if (!CHORD.test(token)) {
      issues.push(issue('row.unreadable', { got: token, expected: 'a degree like `0`, `-3` or `0+2+4`', line }));
      return null;
    }
    chords.push(token.split('+').map(Number));
  }

  return { piece, from, to, steps, chords, line };
}

/* ------------------------------------------------------------------------- *
 * Validation
 * ------------------------------------------------------------------------- */

/** What the score is answering, which decides half the rules. */
export interface ScoreContext {
  /** `new` expects a header and a whole track; `add` expects lane blocks only. */
  readonly mode: 'new' | 'add';
  /** Bars of the track being added to. Ignored in `new`, where the header says. */
  readonly bars: number;
  /** Lanes already playing, which an add reply may not re-declare. */
  readonly existing: readonly string[];
}

/**
 * Everything wrong with a score, in one pass.
 *
 * All of it, not the first failure: the repair message decides how much to send back
 * (one class at a time — see `lib/loop-agent.ts`), and that decision needs the full list
 * to choose from. Warnings are returned alongside and never block.
 */
export function validateScore(score: Score, context: ScoreContext): readonly ScoreIssue[] {
  const issues: ScoreIssue[] = [];
  const header = score.header;

  if (context.mode === 'new') {
    if (header === null) {
      issues.push(issue('score.no-header', { got: 'no `loop` line', expected: 'a `loop` header' }));
    } else {
      if (header.name === '' || header.name.length > MAX_NAME) {
        issues.push(
          issue('score.name-length', {
            got: header.name === '' ? '(empty)' : `${String(header.name.length)} characters`,
            expected: `1–${String(MAX_NAME)} characters`,
            line: header.line,
          }),
        );
      }
      if (!Number.isFinite(header.bpm) || header.bpm < BPM_RANGE.min || header.bpm > BPM_RANGE.max) {
        issues.push(
          issue('score.bpm-range', {
            got: `${String(header.bpm)} bpm`,
            expected: `${String(BPM_RANGE.min)}–${String(BPM_RANGE.max)} bpm`,
            line: header.line,
          }),
        );
      }
      if (!BAR_COUNTS.includes(header.bars)) {
        issues.push(
          issue('score.bars', {
            got: `${String(header.bars)} bars`,
            expected: BAR_COUNTS.join(' | '),
            line: header.line,
          }),
        );
      }
      /* `parseKey` falls back to A minor rather than throwing, so an unreadable key would
         otherwise become a silent transposition of the whole track. */
      if (!/^[A-G]#?\s+(min|maj)$/.test(header.key)) {
        issues.push(
          issue('score.key', { got: header.key, expected: '`<root> min` or `<root> maj`', line: header.line }),
        );
      }
    }
  } else if (header !== null) {
    issues.push(
      issue('score.header-in-add', { got: 'a `loop` header', expected: 'lane blocks only', line: header.line }),
    );
  }

  const bars = context.mode === 'new' ? (header?.bars ?? context.bars) : context.bars;

  if (score.lanes.length === 0) {
    issues.push(issue('score.no-lanes', { got: 'no lanes', expected: 'at least one `lane` block' }));
  }
  const total = score.lanes.length + (context.mode === 'add' ? context.existing.length : 0);
  if (total > MAX_LANES) {
    issues.push(
      issue('lane.count', { got: `${String(total)} lanes`, expected: `at most ${String(MAX_LANES)}` }),
    );
  }

  const seen = new Set<string>();
  let events = 0;
  const voices = new Set<string>();
  /* Keyed on rhythm *and* pitches, so the monotony check compares parts rather than
     patterns: two lanes on the same rhythm at different registers is an arrangement. */
  const fingerprints = new Map<string, string>();

  for (const lane of score.lanes) {
    const spec = LANES[lane.name];
    if (spec === undefined) {
      issues.push(
        issue('lane.unknown', {
          got: lane.name,
          expected: Object.keys(LANES).join(' | '),
          line: lane.line,
          hint: `Use a lane from the table: ${Object.keys(LANES).join(', ')} — there are no other instruments.`,
        }),
      );
      continue;
    }
    if (seen.has(lane.name)) {
      issues.push(issue('lane.duplicate', { got: lane.name, expected: 'one block per lane', line: lane.line }));
    }
    seen.add(lane.name);
    if (context.mode === 'add' && context.existing.includes(lane.name)) {
      issues.push(
        issue('lane.exists', {
          got: lane.name,
          expected: `a lane other than: ${context.existing.join(', ')}`,
          line: lane.line,
        }),
      );
    }
    if (lane.caption !== null && lane.caption.length > MAX_CAPTION) {
      issues.push(
        issue('lane.caption-length', {
          severity: 'warning',
          got: `${String(lane.caption.length)} characters`,
          expected: `at most ${String(MAX_CAPTION)}`,
          line: lane.line,
        }),
      );
    }

    const covered = new Map<string, Set<number>>();
    let hits = 0;

    for (const row of lane.rows) {
      const span = row.to - row.from + 1;
      if (row.from < 1 || row.to > bars || span < 1) {
        issues.push(
          issue('row.bar-range', {
            got: `bars ${String(row.from)}–${String(row.to)}`,
            expected: `inside 1–${String(bars)}`,
            line: row.line,
          }),
        );
        continue;
      }

      const key = `${lane.name}/${row.piece ?? ''}`;
      const already = covered.get(key) ?? new Set<number>();
      for (let bar = row.from; bar <= row.to; bar++) {
        if (already.has(bar)) {
          issues.push(
            issue('row.overlap', {
              got: `bar ${String(bar)} is written twice${row.piece === null ? '' : ` for ${row.piece}`}`,
              expected: 'each bar of a part written once',
              line: row.line,
            }),
          );
          break;
        }
        already.add(bar);
      }
      covered.set(key, already);

      if (spec.drum === true && row.piece === null) {
        issues.push(
          issue('row.piece-missing', { got: 'no piece', expected: Object.keys(PIECES).join(' | '), line: row.line }),
        );
        continue;
      }
      if (spec.drum !== true && row.chords.length === 0 && /[Xx-]/.test(row.steps)) {
        issues.push(issue('pattern.no-degrees', { got: 'no degrees', expected: 'one or more', line: row.line }));
        continue;
      }
      if (spec.drum === true && row.chords.length > 0) {
        issues.push(
          issue('row.degrees-on-kit', {
            got: `${String(row.chords.length)} degrees`,
            expected: 'none',
            line: row.line,
          }),
        );
      }

      if (row.steps.length % STEPS_PER_BAR !== 0 || span % (row.steps.length / STEPS_PER_BAR) !== 0) {
        issues.push(
          issue('pattern.length', {
            got: `${String(row.steps.length)} characters over ${String(span)} bar(s)`,
            expected: `a multiple of ${String(STEPS_PER_BAR)} dividing ${String(span)}`,
            line: row.line,
          }),
        );
        continue;
      }
      if (!/[Xx-]/.test(row.steps)) {
        issues.push(issue('pattern.all-rest', { got: row.steps, expected: 'at least one hit', line: row.line }));
        continue;
      }
      if (row.steps.startsWith('=')) {
        /* A leading tie is the one orphan the expansion cannot resolve: everything else
           ties to the hit before it, and this one has nothing before it in its own row. */
        issues.push(issue('pattern.orphan-tie', { got: '`=` at step 1', expected: 'a hit first', line: row.line }));
        continue;
      }

      for (const chord of row.chords) {
        if (chord.length > MAX_CHORD) {
          issues.push(
            issue('pattern.chord-size', {
              got: `${String(chord.length)} notes`,
              expected: `at most ${String(MAX_CHORD)}`,
              line: row.line,
            }),
          );
        }
        for (const degree of chord) {
          if (degree < DEGREE_RANGE.min || degree > DEGREE_RANGE.max) {
            issues.push(
              issue('pattern.degree-range', {
                got: String(degree),
                expected: `${String(DEGREE_RANGE.min)}…${String(DEGREE_RANGE.max)}`,
                line: row.line,
              }),
            );
          }
        }
      }

      const repeats = span / (row.steps.length / STEPS_PER_BAR);
      const rowHits = (row.steps.match(/[Xx-]/g) ?? []).length * repeats;
      hits += rowHits;
      const chordSize = row.chords.length === 0 ? 1 : Math.max(...row.chords.map((chord) => chord.length));
      events += rowHits * chordSize;
      /* An upper bound rather than the exact set: expanding every row here would mean
         running the conversion twice, and a budget check does not need to be tight. */
      for (const symbol of new Set(row.steps.replace(/[.=]/g, ''))) {
        for (const chord of row.chords.length === 0 ? [[0]] : row.chords) {
          for (const degree of chord) voices.add(`${lane.name}/${symbol}/${String(degree)}`);
        }
      }
    }

    if (hits === 0) {
      issues.push(issue('lane.empty', { got: 'no notes', expected: 'at least one', line: lane.line }));
    }
    if (spec.drum !== true) {
      const print = lane.rows
        .map((row) => `${String(row.from)}:${row.steps}:${row.chords.map((c) => c.join('+')).join(',')}`)
        .join('|');
      const twin = fingerprints.get(print);
      if (twin !== undefined) {
        issues.push(
          issue('score.monotony', {
            severity: 'warning',
            got: `${twin} and ${lane.name} play identically`,
            expected: 'parts that differ',
            line: lane.line,
            hint: `Differentiate ${twin} and ${lane.name} — the same rhythm on the same degrees is one part played twice. Change one register, one rhythm, or drop it.`,
          }),
        );
      } else {
        fingerprints.set(print, lane.name);
      }
    }
  }

  if (events > MAX_EVENTS) {
    issues.push(
      issue('score.note-budget', { got: `${String(events)} events`, expected: `at most ${String(MAX_EVENTS)}` }),
    );
  }
  if (voices.size > MAX_VOICES) {
    issues.push(
      issue('score.voice-budget', {
        got: `${String(voices.size)} distinct voices`,
        expected: `at most ${String(MAX_VOICES)}`,
      }),
    );
  }

  return issues;
}

/* ------------------------------------------------------------------------- *
 * Becoming a track
 * ------------------------------------------------------------------------- */

/** Round a velocity onto the grid the render cache is keyed on. */
function velocity(value: number): number {
  const clamped = Math.max(VELOCITY_STEP, Math.min(1, value));
  return Math.round(clamped / VELOCITY_STEP) * VELOCITY_STEP;
}

/**
 * Expand one lane into the notes the renderer already knows how to play.
 *
 * The output is an ordinary {@link LoopLane} — the same shape `composeLane` produces —
 * which is the whole point: nothing downstream of here can tell whether a model or a
 * PRNG wrote it, so the voices, the mixdown, the timeline and both exports needed no
 * changes at all.
 */
export function laneFromScore(
  lane: ScoreLane,
  options: { readonly key: string; readonly bars: number; readonly index: number; readonly salt: string },
): LoopLane {
  const spec = LANES[lane.name];
  const hue = LANE_HUES[options.index % LANE_HUES.length] ?? 195;
  const base: LoopLane = {
    name: lane.name,
    hue,
    notes: [],
    salt: options.salt,
    ...(lane.caption === null ? {} : { caption: lane.caption }),
    score: lane.text,
  };
  if (spec === undefined) return base;

  const key = parseKey(options.key);
  const notes: LoopNote[] = [];

  for (const row of lane.rows) {
    const perPattern = row.steps.length / STEPS_PER_BAR;
    if (perPattern < 1 || !Number.isInteger(perPattern)) continue;
    const span = row.to - row.from + 1;
    const repeats = Math.max(1, Math.round(span / perPattern));
    /* Degrees are consumed across the whole row, not per bar: a riff of four degrees
       under eight hits a bar is written once and evolves across the range, which is what
       makes a two-bar phrase one line instead of two. */
    let taken = 0;

    for (let repeat = 0; repeat < repeats; repeat++) {
      for (let position = 0; position < row.steps.length; position++) {
        const symbol = row.steps[position] ?? '.';
        const gain = STEP_VELOCITY[symbol];
        if (gain === undefined) continue;

        /* Length is the hit plus the ties trailing it, so `X===` is a quarter note. */
        let length = 1;
        while (row.steps[position + length] === '=') length++;

        const bar = row.from - 1 + repeat * perPattern + Math.floor(position / STEPS_PER_BAR);
        const step = bar * STEPS_PER_BAR + (position % STEPS_PER_BAR);
        if (step < 0 || step >= options.bars * STEPS_PER_BAR) continue;

        if (spec.drum === true) {
          const midi = PIECES[row.piece ?? 'kick'] ?? DRUM.kick;
          notes.push({ step, midi, gain: velocity(gain), length });
          continue;
        }
        const chord = row.chords[taken % Math.max(1, row.chords.length)] ?? [0];
        taken++;
        for (const degree of chord.slice(0, MAX_CHORD)) {
          notes.push({
            step,
            midi: degreeToMidi(key, degree, spec.octave),
            /* Upper notes of a chord a shade quieter, the same taper the seeded
               composer uses — a triad at three equal velocities reads as a cluster. */
            gain: velocity(gain - chord.indexOf(degree) * 0.04),
            length,
          });
        }
      }
    }
  }

  return { ...base, notes: notes.sort((a, b) => a.step - b.step) };
}

/** A whole model-composed track, ready for the same staging a seeded one gets. */
export function trackFromScore(
  score: Score,
  options: { readonly id: string; readonly preset: string; readonly prompt: string; readonly salt: string },
): LoopTrack {
  const header = score.header;
  const bars = header?.bars ?? 16;
  const key = header?.key ?? 'A min';
  const known = score.lanes.filter((lane) => LANES[lane.name] !== undefined);
  return {
    id: options.id,
    name: header?.name ?? options.preset,
    preset: options.preset,
    bpm: header?.bpm ?? 120,
    bars,
    key,
    prompt: options.prompt,
    composedBy: 'model',
    lanes: known.map((lane, index) => laneFromScore(lane, { key, bars, index, salt: options.salt })),
  };
}

/* ------------------------------------------------------------------------- *
 * Writing one back
 * ------------------------------------------------------------------------- */

/**
 * The current arrangement as a score, for the request that extends it.
 *
 * Assembled from the blocks the model wrote rather than reconstructed from the notes: a
 * serializer would have to invert `degreeToMidi`, and the one thing worse than no
 * context is context that says a lane plays something it does not. Lanes the seeded
 * composer wrote have no block, so they are listed by name and marked — which is honest
 * and, as it happens, exactly what the model needs to avoid doubling one.
 */
export function scoreDocument(track: LoopTrack): string {
  const written = track.lanes.filter((lane) => lane.score !== undefined);
  const generated = track.lanes.filter((lane) => lane.score === undefined);
  const head = `loop "${track.name}" ${String(track.bpm)}bpm ${track.key} ${String(track.bars)} bars`;
  const seeded =
    generated.length === 0
      ? []
      : [`# also playing, written by the built-in composer: ${generated.map((lane) => lane.name).join(', ')}`];
  return [head, '', ...seeded, ...written.map((lane) => lane.score ?? '')].join('\n').trim();
}
