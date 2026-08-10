/**
 * NeurosLoop, and the four ways a generative screen lies without anybody noticing.
 *
 * 1. **A voice that does not parse.** Every note resolves to soundline text built by
 *    string interpolation, and a template with a wrong argument order produces a lane
 *    that is silently silent — the mixdown still works, the picture still draws, and one
 *    instrument is simply missing. So every distinct voice of every preset is parsed
 *    *and rendered*, and asked to make a sound.
 * 2. **A composer that is not deterministic.** The screen's whole claim is that a preset
 *    plus a prompt plus a salt reproduce an arrangement — that is why nothing is
 *    persisted. Two compositions of the same inputs are compared note for note.
 * 3. **A loop with a seam.** The mix folds a note's tail back to the head of the buffer,
 *    which is the one piece of arithmetic here that can be wrong in a way nobody sees
 *    until the eighth bar of the second lap.
 * 4. **A `.mid` that is not MIDI.** `lib/download.ts` spends a section refusing to hand
 *    over bytes that are not what the extension says. A hand-written chunk writer is the
 *    easiest place in this repository to break that promise.
 *
 * The renderer is reached only from here — `node-web-audio-api`, exactly as the agent
 * and optimizer tests do it, because the code under test takes its audio stack from the
 * caller and must never know one exists.
 *
 * @packageDocumentation
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OfflineAudioContext as NodeOfflineAudioContext } from 'node-web-audio-api';
import { codegen, parseWithDiagnostics, renderSound } from '@txt2sfx/core';
import {
  DRUM,
  LANES,
  LOOP_PRESETS,
  LOOP_TAGS,
  STEPS_PER_BAR,
  TAG_GROUPS,
  VELOCITY_STEP,
  brief,
  briefName,
  composeLane,
  composeTrack,
  degreeToMidi,
  knobsFor,
  laneClips,
  loopSeconds,
  paletteFor,
  parseKey,
  presetById,
  progression,
  proposals,
  register,
  stepCount,
  stepSeconds,
  type LoopTrack,
} from '../src/lib/loop.js';
import { voiceContext, voiceFor } from '../src/lib/loop-voice.js';
import { CEILING, SAMPLE_RATE, mixLoop, renderLoop, renderStems } from '../src/lib/loop-render.js';
import { schedule, toMidi, toModule } from '../src/lib/loop-export.js';
import { LOOP_FORMATS, formatById, formatsFor } from '../src/lib/download.js';
import { PIECES, laneFromScore, parseScore } from '../src/lib/score.js';
import { en } from '../src/lib/locales/en.js';

/** Every preset composed with its own prompt — the state the screen opens in. */
const TRACKS: readonly LoopTrack[] = LOOP_PRESETS.map((preset) =>
  composeTrack(`t-${preset.id}`, preset, preset.prompt, preset.id, 'test'),
);

/**
 * Briefs assembled the way the chips assemble them.
 *
 * The presets are no longer a control on the screen, so a suite that only composed those
 * six would be testing the path nobody takes. These are what a user actually produces:
 * a handful of fragments, no typing, and a palette derived from the resulting words —
 * which is also the only path that reaches the lowered registers and the pedal patterns.
 */
const BRIEFS: readonly (readonly string[])[] = [
  ['dark', 'still', 'cave'],
  ['hopeful', 'driving', 'drums', 'plucks'],
  ['dreamy', 'tape', 'no drums', 'choir'],
  ['tense', 'half-time', 'sub bass', 'arp'],
  ['melancholy', 'sparse', 'bells', 'rain'],
  ['warm', 'pulsing', 'night city'],
  /* The driven one. Every voice it reaches carries a `dist` stage, so it is the brief that
     proves saturation parses, renders and does not clip — the whole point of the peak-
     normalized curve. */
  ['aggressive', 'march', 'industrial', 'drums', 'sub bass'],
  /* The two that reach the named instruments. The guitar has the longest chain in the file —
     pickup, shaper, two cabinet stages — and the second brief is the only path to the three
     sustaining families, which are the only voices here that write `hold`. */
  ['aggressive', 'guitar', 'riff', 'march'],
  ['organ', 'brass', 'e-piano'],
];

const TAGGED: readonly LoopTrack[] = BRIEFS.map((tags, index) => {
  const palette = paletteFor('', tags);
  return composeTrack(`tag-${String(index)}`, palette, palette.prompt, briefName('', tags), 'test');
});

/** Everything a lane invariant has to hold for, whoever assembled the brief. */
const ALL: readonly LoopTrack[] = [...TRACKS, ...TAGGED];

/* The real one, from `lib/loop-voice.ts`: a context assembled by hand here would drift the
   first time the templates gained a dimension — which is exactly what `drive` was. */
const contextFor = voiceContext;

/** Every distinct voice a track needs, as text. */
function voicesOf(track: LoopTrack): readonly string[] {
  const context = contextFor(track);
  const seen = new Set<string>();
  for (const lane of track.lanes) for (const note of lane.notes) seen.add(voiceFor(lane.name, note, context));
  return [...seen];
}

describe('the composer', () => {
  it('gives every preset a lane per instrument, and notes in every lane', () => {
    for (const track of TRACKS) {
      const preset = presetById(track.preset);
      expect(track.lanes.map((lane) => lane.name)).toEqual([...preset.lanes]);
      for (const lane of track.lanes) {
        expect(lane.notes.length, `${track.preset}/${lane.name}`).toBeGreaterThan(0);
        expect(LANES[lane.name]).toBeDefined();
      }
    }
  });

  it('keeps every note on the grid, in range, at a quantized velocity', () => {
    for (const track of ALL) {
      const steps = stepCount(track);
      for (const lane of track.lanes) {
        for (const note of lane.notes) {
          expect(note.step).toBeGreaterThanOrEqual(0);
          expect(note.step).toBeLessThan(steps);
          expect(note.midi).toBeGreaterThanOrEqual(0);
          expect(note.midi).toBeLessThanOrEqual(127);
          expect(note.length).toBeGreaterThan(0);
          /* Velocity is the cache key and the export key. A value off the grid means a
             recipe rendered once per note instead of once per level. */
          expect(Math.abs(note.gain / VELOCITY_STEP - Math.round(note.gain / VELOCITY_STEP))).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('reproduces an arrangement from preset, prompt and salt — which is why nothing is stored', () => {
    for (const preset of LOOP_PRESETS) {
      const once = composeTrack('same', preset, preset.prompt, preset.id, 'salt');
      const twice = composeTrack('same', preset, preset.prompt, preset.id, 'salt');
      expect(twice).toEqual(once);
    }
  });

  it('produces a different arrangement for a different prompt, same preset', () => {
    const preset = presetById('overworld-run');
    const a = composeTrack('x', preset, 'bright and busy', 'a', 's');
    const b = composeTrack('x', preset, 'dark and sparse', 'b', 's');
    expect(b.lanes.map((lane) => lane.notes)).not.toEqual(a.lanes.map((lane) => lane.notes));
  });

  it('changes only the retried lane when a lane is recomposed', () => {
    const track = TRACKS[0] as LoopTrack;
    const again = composeLane(track, 'bass', 1, 'other-salt');
    const bass = track.lanes.find((lane) => lane.name === 'bass');
    expect(bass).toBeDefined();
    expect(again.notes).not.toEqual(bass?.notes);
    expect(again.name).toBe('bass');
  });

  /**
   * A lane the screen cannot name.
   *
   * `LANE_MESSAGE` in `components/LoopProgress.tsx` falls back to "writing {lane}…", so a
   * missing row is not a crash — it is a lane that spends its composing seconds described by
   * its own variable name, which is the moment the user is deciding whether this is the thing
   * they asked for. The table's keys are `loop.msg.<lane>` without exception, so asserting the
   * dictionary has one is the same assertion from the side that has no React in it.
   */
  it('has a sentence for every lane to be composed under', () => {
    for (const name of Object.keys(LANES)) {
      expect(en[`loop.msg.${name}` as keyof typeof en], `${name} has no caption`).toBeDefined();
    }
  });

  it('offers at most two spare lanes, none of them already present', () => {
    for (const track of ALL) {
      const spare = proposals(track);
      expect(spare.length).toBeLessThanOrEqual(2);
      for (const lane of spare) expect(track.lanes.some((existing) => existing.name === lane)).toBe(false);
    }
  });
});

describe('the prompt', () => {
  it('reads tempo, density and brightness out of the words it knows', () => {
    expect(knobsFor('relentless driving chase').tempo).toBeGreaterThan(1);
    expect(knobsFor('slow weightless drift').tempo).toBeLessThan(1);
    expect(knobsFor('sparse minimal').density).toBeLessThan(0);
    expect(knobsFor('busy dense layered').density).toBeGreaterThan(0);
    expect(knobsFor('bright shimmering').brightness).toBeGreaterThan(0);
    expect(knobsFor('dark muffled').brightness).toBeLessThan(0);
  });

  it('drops the lanes it was asked to do without', () => {
    expect(knobsFor('weightless menu loop — soft arp, warm pad, no drums').without).toContain('drums');
    expect(knobsFor('without percussion').without).toContain('perc');
    const track = composeTrack('n', presetById('overworld-run'), 'no drums please', 'n', 's');
    expect(track.lanes.some((lane) => lane.name === 'drums')).toBe(false);
  });

  it('refuses to compose silence when every lane was excluded', () => {
    const preset = presetById('menu-drift');
    const asked = `no ${preset.lanes.join(', no ')}`;
    expect(composeTrack('n', preset, asked, 'n', 's').lanes.length).toBeGreaterThan(0);
  });

  it('leaves the tempo a whole number, because every tool downstream wants one', () => {
    for (const preset of LOOP_PRESETS) {
      const track = composeTrack('n', preset, 'relentless driving chase', 'n', 's');
      expect(Number.isInteger(track.bpm)).toBe(true);
    }
  });
});

/**
 * The chips, and the three ways a fragment table lies.
 *
 * 1. **A chip that does nothing.** A fragment whose words no keyword row reads changes the
 *    seed and nothing else, which with no model attached is a button that looks broken. So
 *    every fragment is asked to move at least one knob, or to name lanes, or to be a
 *    fragment whose only job is text the *model* reads — and that last case has to be a
 *    deliberate, visible exception rather than an accident.
 * 2. **A palette that is secretly a constant.** The whole complaint that produced this
 *    table was six tempi and six keys forever. A derivation that lands every brief on
 *    96 bpm in A minor would pass every other test in this file.
 * 3. **An arrangement with nothing in it.** One fragment ("bells") is a colour, and a
 *    palette that took it literally would mix one lane.
 */
describe('the brief', () => {
  it('assembles the fragments in the order they were added, then what was typed', () => {
    expect(brief('and a heartbeat under it', ['dark', 'cave'])).toBe(
      'dark and low, in a dripping cave, and a heartbeat under it',
    );
    expect(brief('', ['still'])).toBe('barely moving, still');
    expect(brief('  just words  ', [])).toBe('just words');
    /* Nothing typed and nothing pressed is not a request. `Loop.tsx` refuses the press on
       exactly this value rather than inventing a palette to fall back on. */
    expect(brief('', [])).toBe('');
  });

  it('names a take after the fragments, or after the first words typed', () => {
    expect(briefName('', ['dark', 'still', 'cave'])).toBe('dark still');
    expect(briefName('A Slow Iron Hymn for nobody', [])).toBe('a slow iron');
    expect(briefName('', [])).toBe('untitled');
  });

  it('gives every fragment a group the screen has a row for, and a phrase that does something', () => {
    for (const tag of LOOP_TAGS) {
      expect(TAG_GROUPS, tag.id).toContain(tag.group);
      expect(tag.phrase.trim(), tag.id).not.toBe('');
      const knobs = knobsFor(tag.phrase);
      const moves =
        knobs.density !== 0 ||
        knobs.brightness !== 0 ||
        knobs.tempo !== 1 ||
        knobs.without.length > 0 ||
        (tag.lanes ?? []).length > 0 ||
        tag.bpm !== undefined ||
        tag.bars !== undefined ||
        tag.mode !== undefined;
      expect(moves, `${tag.id} changes nothing without a model`).toBe(true);
    }
  });

  it('spreads keys and tempi across briefs, which is the whole reason it replaced the presets', () => {
    const palettes = LOOP_TAGS.map((tag) => paletteFor('', [tag.id]));
    expect(new Set(palettes.map((palette) => palette.key)).size).toBeGreaterThan(4);
    expect(new Set(palettes.map((palette) => palette.bpm)).size).toBeGreaterThan(4);
    /* Both modes reachable, and neither by accident: `hopeful` pins major and `dark` pins
       minor, so a derivation that ignored the hint would fail here and nowhere else. */
    expect(paletteFor('', ['hopeful']).key.endsWith('maj')).toBe(true);
    expect(paletteFor('', ['dark']).key.endsWith('min')).toBe(true);
  });

  it('honours the lanes a fragment asks for and the ones it refuses', () => {
    expect(paletteFor('', ['bells']).lanes).toContain('bells');
    expect(paletteFor('', ['choir', 'drone']).lanes).toEqual(expect.arrayContaining(['choir', 'drone']));
    const drumless = paletteFor('', ['drums', 'no drums']);
    expect(drumless.lanes).not.toContain('drums');
    expect(drumless.lanes).not.toContain('perc');
  });

  it('never derives an arrangement too thin to balance, and never one too wide to extend', () => {
    for (const tag of LOOP_TAGS) {
      const palette = paletteFor('', [tag.id]);
      expect(palette.lanes.length, tag.id).toBeGreaterThanOrEqual(3);
      /* One under the score's own `MAX_LANES`, so "Add tracks" always has something to
         propose rather than opening with "every lane is already here". */
      expect(palette.lanes.length, tag.id).toBeLessThanOrEqual(5);
      for (const lane of palette.lanes) expect(LANES[lane], `${tag.id}/${lane}`).toBeDefined();
    }
  });

  it('reproduces a palette from the brief alone, which is why nothing seeded is stored', () => {
    expect(paletteFor('a cellar', ['dark', 'cave'])).toEqual(paletteFor('a cellar', ['dark', 'cave']));
    expect(paletteFor('a cellar', ['dark', 'cave'])).not.toEqual(paletteFor('a cellar', ['cave', 'dark']));
  });

  it('gives every derived palette a lane per instrument and notes in every lane', () => {
    for (const track of TAGGED) {
      expect(track.lanes.length).toBeGreaterThanOrEqual(3);
      for (const lane of track.lanes) {
        expect(lane.notes.length, `${track.name}/${lane.name}`).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * Variety, as an assertion.
 *
 * "Every track comes out the same" is a complaint no other test in this file could have
 * caught: one groove, one arp figure and two progressions per mode all satisfy determinism,
 * every grid invariant and every render. The only way to hold it is to compose many
 * different briefs and count how many distinct things came out.
 */
describe('the variety', () => {
  /** Eight briefs that differ only in wording, so nothing but the seed can be doing the work. */
  const WORDINGS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

  /** A lane's rhythm and pitches as one string, for counting distinct parts. */
  const shapeOf = (track: LoopTrack, name: string): string =>
    (track.lanes.find((lane) => lane.name === name)?.notes ?? [])
      .map((note) => `${String(note.step)}:${String(note.midi)}`)
      .join(' ');

  it('writes more than one drum groove', () => {
    const preset = presetById('overworld-run');
    const grooves = new Set(
      WORDINGS.map((word) => shapeOf(composeTrack('g', preset, `a kit ${word}`, 'g', 's'), 'drums')),
    );
    expect(grooves.size).toBeGreaterThan(2);
  });

  it('writes more than one melodic figure and more than one bass feel', () => {
    const preset = presetById('overworld-run');
    const tracks = WORDINGS.map((word) => composeTrack('m', preset, `a tune ${word}`, 'm', 's'));
    expect(new Set(tracks.map((track) => shapeOf(track, 'lead'))).size).toBeGreaterThan(2);
    expect(new Set(tracks.map((track) => shapeOf(track, 'bass'))).size).toBeGreaterThan(2);
  });

  /**
   * Aggression, which the instrument set had no way to express at all.
   *
   * A brief for something militant used to come back as ambience with a drum track: every
   * sustained voice was a clean filtered saw, and the bed lanes faded in over a second
   * whatever was written on top. Three things have to hold now, and none of them is
   * checkable by ear in a test: the words reach the knob, the knob reaches the recipe text,
   * and the recipe still renders inside the ceiling.
   */
  it('saturates the voices a driven brief reaches, and leaves a calm one clean', () => {
    expect(knobsFor('aggressive militant march').drive).toBeGreaterThan(0.5);
    expect(knobsFor('industrial, distorted, metal on metal').drive).toBeGreaterThan(0.5);
    expect(knobsFor('dreamy and blurred, under steady rain').drive).toBe(0);

    const hot = { stepSeconds: 0.12, brightness: 0, drive: 1 };
    const cool = { stepSeconds: 0.12, brightness: 0, drive: 0 };
    const note = { step: 0, midi: 45, gain: 0.9, length: 4 };
    /* The lanes that can take it: bass, lead, the plucked family and the bed, plus the kick
       and the snare — which have to be asked for by GM number, because a drum lane's pitch
       *is* the piece and anything else falls through to the tick. */
    for (const lane of ['bass', 'lead', 'chords', 'pads']) {
      expect(voiceFor(lane, note, hot), lane).toContain('dist ');
      expect(voiceFor(lane, note, cool), lane).not.toContain('dist ');
    }
    expect(voiceFor('drums', { ...note, midi: DRUM.kick }, hot)).toContain('dist ');
    expect(voiceFor('drums', { ...note, midi: DRUM.kick }, cool)).not.toContain('dist ');
    /* The snare stays clean at any drive: its crack is white noise, and a shaper on noise is
       louder noise. It clipped on its own when it had one. */
    expect(voiceFor('drums', { ...note, midi: DRUM.snare }, hot)).not.toContain('dist ');
    /* A driven voice is a different recipe, or the render cache would hand a clean one to a
       driven track and the drive would exist only in the text. */
    expect(voiceFor('bass', note, hot)).not.toBe(voiceFor('bass', note, cool));
  });

  /**
   * The weight, which is where "it still sounds like a children's song" was hiding.
   *
   * Saturation on its own is not heaviness: the arrangement also has to *have* a bottom, and
   * three things were missing it. The bass was a single filtered saw with almost nothing under
   * 80 Hz, the loudest chord lane lived above middle C, and the register shift — the one thing
   * that moves a whole arrangement down — was applied to seeded tracks only, so a
   * model-composed march sat exactly where the lane table put it.
   */
  it('gives the bass a sub an octave down, and the heavy chord lane an octave of its own', () => {
    const clean = { stepSeconds: 0.12, brightness: 0, drive: 0 };
    const note = { step: 0, midi: 45, gain: 0.9, length: 4 };
    const bass = voiceFor('bass', note, clean);
    /* A2 is 110 Hz, so the sub layer is the 55 Hz sine under it. Without it the mix has one
       voice below 80 Hz — the kick — for 200 ms at a time. */
    expect(bass).toContain('sub: tone sine 55Hz');
    expect(bass).toContain('tone saw 110Hz');

    /* `stabs` is its own family now, two saws an octave apart, and driven even when the brief
       is calm: a chord lane called `stabs` is asking for teeth. */
    const stabs = voiceFor('stabs', note, clean);
    expect(stabs).toContain('sound "power"');
    expect(stabs).toContain('dist ');
    expect(LANES['stabs']?.octave).toBe(3);
  });

  /**
   * The instruments, and the one thing each of them cannot be wrong about.
   *
   * These are not timbre assertions — a test cannot hear a guitar. Each one pins the single
   * decision that makes its family *that instrument* rather than a filtered saw, which is
   * exactly the decision an innocent-looking edit removes: reorder the guitar's chain and it
   * is a buzzer, drop the organ's third-harmonic drawbar and it is a sine stack, freeze the
   * electric piano's index and it is a bell for the whole note.
   */
  describe('the named instruments', () => {
    const clean = { stepSeconds: 0.12, brightness: 0, drive: 0 };
    /* A2, 110 Hz: every ratio below is legible against it by hand. */
    const note = { step: 0, midi: 45, gain: 0.9, length: 4 };

    it('puts the cabinet after the distortion, which is all that separates a guitar from a buzzer', () => {
      const text = voiceFor('guitar', note, clean);
      expect(text).toContain('sound "guitar"');
      /* pickup → amplifier → speaker, in that order and on one line. After the shaper the
         cabinet's low-pass removes the fizz above the eighth harmonic; before it, it would
         only be removing harmonics the shaper is about to regenerate. */
      expect(text).toMatch(
        /tone saw [\d.]+Hz >> lp [\d.]+Hz Q1\.6 >> dist drive [\d.]+ mix [\d.]+ >> lp [\d.]+Hz >> hp [\d.]+Hz \|/,
      );
      /* Driven on a calm brief too: a lane called `guitar` is asking for an amplifier, and a
         clean electric is a different instrument. */
      expect(text).toContain('dist ');
      /* The cabinet does not follow the note — that is why a low chord and a high one sound
         like one instrument. */
      const cabOf = (midi: number): string =>
        /mix [\d.]+ >> lp ([\d.]+)Hz/.exec(voiceFor('guitar', { ...note, midi }, clean))?.[1] ?? '';
      expect(cabOf(45)).toBe(cabOf(64));
      /* And it gives way when the fundamental is under it, rather than eating the note. */
      expect(voiceFor('guitar', { ...note, midi: 28 }, clean)).toMatch(/>> hp (?:[1-4]\d|\d)(?:\.\d)?Hz/);
    });

    it('sums drawbars for the organ, the third harmonic among them', () => {
      const text = voiceFor('organ', note, clean);
      /* 16′, 8′, 5⅓′, 4′ — and 165 Hz is the 5⅓′ drawbar, the one that makes a stack of sines
         read as an organ rather than as octaves. */
      expect(text).toContain('tone sine 55Hz');
      expect(text).toContain('tone sine 110Hz');
      expect(text).toContain('tone sine 165Hz');
      expect(text).toContain('tone sine 220Hz');
      /* The key click. A Hammond's contacts arrive before its tone does. */
      expect(text).toContain('click 2ms');
      /* Brightness pulls the upper drawbars rather than moving a cutoff, because that is the
         only control the instrument has. */
      const upper = (brightness: number): number =>
        Number(/tone sine 165Hz \| gain ([\d.]+)/.exec(voiceFor('organ', note, { ...clean, brightness }))?.[1] ?? '0');
      expect(upper(1)).toBeGreaterThan(upper(-1));
    });

    it('ramps the electric piano down from its strike instead of holding a bell', () => {
      const text = voiceFor('epiano', note, clean);
      expect(text).toMatch(/fm [\d.]+Hz ratio [\d.]+ index [\d.]+ -> 0\.4 in \d+ms/);
      /* The bark sits in a fixed band, so the ratio falls as the note rises — a constant one
         would put a low note's strike at 900 Hz and a high note's out of hearing. */
      const ratioOf = (midi: number): number =>
        Number(/ratio ([\d.]+)/.exec(voiceFor('epiano', { ...note, midi }, clean))?.[1] ?? '0');
      expect(ratioOf(69)).toBeLessThan(ratioOf(45));
      /* And a fundamental under it, or the voice is all attack and no note. */
      expect(text).toContain('tone sine 110Hz');
    });

    it('sings a vowel for the choir rather than filtering a saw', () => {
      const dark = voiceFor('choir', note, { ...clean, brightness: -1 });
      const bright = voiceFor('choir', note, { ...clean, brightness: 1 });
      /* Two resonances at absolute frequencies is what a vowel *is*; the layer is named after
         the one it is singing, so the recipe says which. */
      expect(dark).toContain('oo: tone saw');
      expect(bright).toContain('ah: tone saw');
      expect(dark).toMatch(/>> bp 320Hz Q3\.5/);
      expect(bright).toMatch(/>> bp 730Hz Q3\.5/);
      /* A formant does not move with the note. That is the difference from every other filter
         in the file, and the reason a sung chord holds together. */
      const formantOf = (midi: number): string =>
        />> bp ([\d.]+)Hz Q3\.5/.exec(voiceFor('choir', { ...note, midi }, clean))?.[1] ?? '';
      expect(formantOf(45)).toBe(formantOf(64));
      expect(dark).toContain('noise pink');
    });

    it('holds the instruments that sustain and decays the ones that are struck', () => {
      /* An organ, a section and a choir are driven for as long as the note lasts. Writing
         `decay <the whole note>` for them is the shape of a piano, and a held chord that falls
         away from the moment it arrives is audibly wrong under an arrangement. */
      for (const lane of ['organ', 'brass', 'choir']) {
        expect(voiceFor(lane, { ...note, length: 16 }, clean), lane).toContain(' hold ');
      }
      for (const lane of ['epiano', 'chords', 'guitar', 'bass']) {
        expect(voiceFor(lane, { ...note, length: 16 }, clean), lane).not.toContain(' hold ');
      }
    });

    it('speaks the brass over tens of milliseconds, and brightens as it arrives', () => {
      const text = voiceFor('brass', { ...note, length: 16 }, clean);
      const attacks = [...text.matchAll(/attack (\d+)ms/g)].map((match) => Number(match[1]));
      expect(attacks).toHaveLength(2);
      /* A saw with a 3 ms attack is a synth lead whatever else is done to it, and the bright
         layer opening later than the dull one *is* the filter sweep this DSL has no envelope
         for. */
      expect(Math.min(...attacks)).toBeGreaterThan(15);
      expect(Math.max(...attacks)).toBeGreaterThan(Math.min(...attacks) * 2);
    });

    it('keeps every named instrument inside the ceiling at any velocity or drive', () => {
      /* Written gains do not predict a peak here — the guitar's chain measured 10× its own
         gain — so the sizes come from measurement. This holds the *shape* of that result:
         nothing in the table is louder than the bass, which is the loudest voice by design,
         and loud still separates from quiet. `renderLoop` proves the peaks themselves. */
      for (const lane of ['guitar', 'riff', 'organ', 'brass', 'epiano', 'choir']) {
        const loud = voiceFor(lane, { ...note, gain: 0.9 }, { ...clean, drive: 1 });
        const quiet = voiceFor(lane, { ...note, gain: 0.35 }, { ...clean, drive: 1 });
        expect(loud, lane).not.toBe(quiet);
        for (const written of [...loud.matchAll(/gain ([\d.]+)/g)].map((match) => Number(match[1]))) {
          expect(written, `${lane} writes a gain over unity`).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  it('shifts a model-composed arrangement down with the same knob a seeded one uses', () => {
    const written = parseScore(
      'lane bass "the grind"\n  1-8  X=x=X=x=X=x=X=x=  0 0 0 4 0 0 -3 4\n',
    ).score.lanes[0];
    expect(written).toBeDefined();
    if (written === undefined) return;
    const at = (prompt: string | undefined): number =>
      Math.min(
        ...laneFromScore(written, {
          key: 'C min',
          bars: 8,
          index: 0,
          salt: 's',
          ...(prompt === undefined ? {} : { prompt }),
        }).notes.map((note) => note.midi),
      );
    /* Exactly an octave, from the drive knob, on the path the user actually hears. The brief
       reaches this through `register` — the same function, not a second copy of the rule. */
    expect(at('glassy and crisp') - at('aggressive, militant, brutal')).toBe(12);
    /* No brief, no shift: the score path is used by tests and by `Add tracks` before a track
       has a prompt, and neither should silently transpose. */
    expect(at(undefined)).toBe(at('glassy and crisp'));
  });

  it('has a tom, because a kit with no pitched membrane cannot march', () => {
    expect(PIECES['tom']).toBe(DRUM.tom);
    const tom = voiceFor('drums', { step: 0, midi: DRUM.tom, gain: 0.8, length: 2 }, {
      stepSeconds: 0.12,
      brightness: 0,
      drive: 0,
    });
    expect(tom).toContain('sound "tom"');
    /* A falling sub, not a tick: the pitch drop is what makes it a drum. */
    expect(tom).toMatch(/sub \d+Hz -> \d+Hz/);
  });

  it('steps the crowded register back when the brief is heavy, and leaves the low lanes alone', () => {
    const note = { step: 0, midi: 60, gain: 0.9, length: 4 };
    const gainOf = (text: string): number => Number(/gain ([\d.]+)/.exec(text)?.[1] ?? '0');
    for (const lane of ['chords', 'lead', 'pads']) {
      const calm = gainOf(voiceFor(lane, note, { stepSeconds: 0.12, brightness: 0, drive: 0 }));
      const heavy = gainOf(voiceFor(lane, note, { stepSeconds: 0.12, brightness: 0, drive: 1 }));
      expect(heavy, lane).toBeLessThan(calm);
    }
    /* The kick keeps its level whatever happens: `mixLoop` scales the whole sum to fit, so
       what a crowded middle costs is the bottom, which is the thing being protected. */
    const kick = { step: 0, midi: DRUM.kick, gain: 0.9, length: 2 };
    expect(gainOf(voiceFor('drums', kick, { stepSeconds: 0.12, brightness: 0, drive: 0 }))).toBeGreaterThan(
      0.7,
    );
  });

  it('makes the bed arrive fast when the brief is driven, and slowly when it is still', () => {
    const held = { step: 0, midi: 50, gain: 0.7, length: 32 };
    const attackOf = (text: string): number => Number(/attack (\d+)ms/.exec(text)?.[1] ?? '0');
    const still = attackOf(voiceFor('pads', held, { stepSeconds: 0.23, brightness: 0, drive: 0 }));
    const march = attackOf(voiceFor('pads', held, { stepSeconds: 0.23, brightness: 0, drive: 1 }));
    /* The number that turned every march into space music: a flat 28% of a two-bar chord is
       a second of fade-in, and it used to apply whatever the brief said. */
    expect(still).toBeGreaterThan(400);
    expect(march).toBeLessThan(100);
  });

  it('refuses the half-time and empty grooves when the brief is militant', () => {
    const preset = presetById('boss-fight');
    for (const word of WORDINGS) {
      const track = composeTrack('a', preset, `aggressive industrial march ${word}`, 'a', 's');
      const kick = (track.lanes.find((lane) => lane.name === 'drums')?.notes ?? []).filter(
        (note) => note.midi === 36,
      );
      /* Sixteen bars of a march has a kick in most of them. The two grooves excluded put one
         hit every four bars, which is an answer to a different request. */
      expect(kick.length, word).toBeGreaterThan(16);
    }
  });

  it('drops the whole arrangement an octave when the words are dark, and never raises it', () => {
    expect(register(knobsFor('dark and low'))).toBe(-1);
    expect(register(knobsFor('glassy and crisp'))).toBe(0);
    for (const tag of LOOP_TAGS) expect(register(knobsFor(tag.phrase)), tag.id).toBeLessThanOrEqual(0);

    const preset = presetById('overworld-run');
    const low = composeTrack('l', preset, 'dark and low', 'l', 's');
    const high = composeTrack('h', preset, 'glassy and crisp', 'h', 's');
    const lowest = (track: LoopTrack, name: string): number =>
      Math.min(...(track.lanes.find((lane) => lane.name === name)?.notes ?? []).map((note) => note.midi));
    /* A whole octave, exactly: the shift is applied once, to every pitched lane, from the
       same number — a partial shift would be a hole in the middle of the arrangement. */
    expect(lowest(high, 'bass') - lowest(low, 'bass')).toBe(12);
  });

  it('has more than two progressions per mode, one of which mostly refuses to move', () => {
    for (const mode of ['A min', 'C maj']) {
      const key = parseKey(mode);
      const written = new Set(
        Array.from({ length: 24 }, (_, seed) => progression(key, seed, 4).join(',')),
      );
      /* Four bars of harmony is the thing a listener remembers, and two of them per mode
         was the single biggest reason every take sounded like the last one. */
      expect(written.size, mode).toBeGreaterThan(3);
      /* A pedal — a progression that spends most of its bars on one root — is reachable.
         The old table could not express it at all, so ambience always walked. */
      expect(
        [...written].some((entry) => new Set(entry.split(',')).size <= 2),
        mode,
      ).toBe(true);
    }
  });
});

describe('pitch', () => {
  it('reads a key signature into a root and a mode', () => {
    expect(parseKey('A min')).toEqual({ root: 9, scale: [0, 2, 3, 5, 7, 8, 10], minor: true });
    expect(parseKey('G maj').minor).toBe(false);
    /* A typo costs a mode, not a screen. */
    expect(parseKey('nonsense').root).toBe(9);
  });

  it('walks degrees past the ends of the scale', () => {
    const key = parseKey('C maj');
    expect(degreeToMidi(key, 0, 4)).toBe(60);
    expect(degreeToMidi(key, 7, 4)).toBe(72);
    expect(degreeToMidi(key, -7, 4)).toBe(48);
    expect(degreeToMidi(key, 4, 4)).toBe(67);
  });
});

describe('every voice a preset can ask for', () => {
  /* Slow by construction — a few hundred offline renders — but this is the assertion
     the whole screen rests on: a template that does not parse is an instrument that is
     silently missing from the mix. */
  it('parses, compiles and makes a sound', async () => {
    for (const track of ALL) {
      for (const soundline of voicesOf(track)) {
        const parsed = parseWithDiagnostics(soundline);
        expect(parsed.errors, `${track.preset}\n${soundline}`).toEqual([]);
        expect(parsed.ast).not.toBeNull();
        if (parsed.ast === null) continue;

        const result = await renderSound(parsed.ast, {
          context: (options) =>
            new NodeOfflineAudioContext(options.numberOfChannels, options.length, options.sampleRate),
          seed: 7,
        });
        expect(result.peak, `silent: ${soundline}`).toBeGreaterThan(0.001);
        /* The recipes carry their own gain; nothing downstream normalizes a voice, so a
           clipping template would clip in the mix too. */
        expect(result.clipped, `clips: ${soundline}`).toBe(false);
      }
    }
  }, 120000);

  it('compiles to an exportable function for every one of them', () => {
    for (const track of ALL) {
      for (const soundline of voicesOf(track)) {
        const ast = parseWithDiagnostics(soundline).ast;
        expect(ast).not.toBeNull();
        if (ast === null) continue;
        const emitted = codegen(ast, { seed: 7 }).code;
        /* Syntax only — `test/codegen.test.ts` already proves the emitted graph renders
           sample-for-sample like the live one. */
        expect(() => new Function(`return ${emitted}`)).not.toThrow();
      }
    }
  });

  it('names a distinct recipe per velocity, so the render cache can collapse them', () => {
    const track = TRACKS[0] as LoopTrack;
    const context = contextFor(track);
    const quiet = voiceFor('bass', { step: 0, midi: 45, gain: 0.3, length: 4 }, context);
    const loud = voiceFor('bass', { step: 0, midi: 45, gain: 0.9, length: 4 }, context);
    expect(quiet).not.toBe(loud);
    expect(voiceFor('bass', { step: 8, midi: 45, gain: 0.3, length: 4 }, context)).toBe(quiet);
  });
});

describe('the mixdown', () => {
  it('folds a tail that runs past the end back onto the head', () => {
    const part = { samples: Float32Array.from([0, 0, 1, 2]), offset: 2 };
    const { samples } = mixLoop([part], 4);
    /* Onset at 2, so samples 2 and 3 land at the end and the last two wrap to 0 and 1 —
       which is exactly what makes the second lap continue the first. */
    expect([...samples]).toEqual([1, 2, 0, 0]);
  });

  it('wraps more than once when a part is longer than the whole loop', () => {
    const { samples } = mixLoop([{ samples: Float32Array.from([1, 1, 1, 1, 1]), offset: 0 }], 2);
    expect([...samples]).toEqual([3, 2]);
  });

  it('sums overlapping parts and reports the peak before any headroom', () => {
    const { peak } = mixLoop(
      [
        { samples: Float32Array.from([0.6]), offset: 0 },
        { samples: Float32Array.from([0.7]), offset: 0 },
      ],
      2,
    );
    expect(peak).toBeCloseTo(1.3, 6);
  });
});

/**
 * The one place this file installs a global.
 *
 * `lib/loop-render.ts` is browser code — it reaches for `OfflineAudioContext` the way
 * `lib/engine.ts` does, because in a tab that constructor is simply there. Standing the
 * Node implementation up under the same name is what lets the *real* mixdown path run
 * here: the same voice renders, the same wrap, the same headroom decision, the same
 * `copyToChannel`. Testing a reimplementation of it would prove nothing.
 */
describe('a whole soundtrack, mixed', () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const had = 'OfflineAudioContext' in globals;

  beforeAll(() => {
    globals['OfflineAudioContext'] = NodeOfflineAudioContext;
  });
  afterAll(() => {
    if (!had) delete globals['OfflineAudioContext'];
  });

  it('renders one seamless buffer of exactly the loop length', async () => {
    const track = TRACKS[4] as LoopTrack;
    const rendered = await renderLoop(track, { seed: 7 });

    expect(rendered.buffer.length).toBe(Math.round(loopSeconds(track) * SAMPLE_RATE));
    expect(rendered.buffer.sampleRate).toBe(SAMPLE_RATE);
    expect(rendered.notes).toBe(track.lanes.reduce((total, lane) => total + lane.notes.length, 0));
    expect(rendered.voices).toBeGreaterThan(0);
    expect(rendered.voices).toBeLessThanOrEqual(rendered.notes);

    /* Audible, and inside the ceiling after headroom — the two things a listener would
       otherwise have to discover by pressing Play on silence or on a clipped mix. */
    const samples = rendered.buffer.getChannelData(0);
    let peak = 0;
    for (const value of samples) peak = Math.max(peak, Math.abs(value));
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
    expect(rendered.headroom).toBeLessThanOrEqual(1);
  }, 60000);

  it('leaves the head of the buffer sounding, because a tail wrapped onto it', async () => {
    /* `cave-ambience` is pads and a drone: every note is longer than the grid it sits
       on, so if the wrap were dropped the first samples of the loop would be silence
       and the seam would be audible on every lap. */
    const rendered = await renderLoop(TRACKS[2] as LoopTrack, { seed: 7 });
    const head = rendered.buffer.getChannelData(0).slice(0, 512);
    let energy = 0;
    for (const value of head) energy += Math.abs(value);
    expect(energy / head.length).toBeGreaterThan(0.0005);
  }, 60000);

  it('mutes a lane by re-mixing, so what plays and what exports cannot disagree', async () => {
    const track = TRACKS[0] as LoopTrack;
    const full = await renderLoop(track, { seed: 7 });
    const withoutDrums = await renderLoop(track, { seed: 7, muted: new Set(['drums']) });
    expect(withoutDrums.notes).toBeLessThan(full.notes);
  }, 60000);

  it('renders each stem on its own rather than slicing the master', async () => {
    const track = TRACKS[4] as LoopTrack;
    const master = await renderLoop(track, { seed: 7 });
    const stems = await renderStems(track, 7);

    expect(stems.map((stem) => stem.lane)).toEqual(track.lanes.map((lane) => lane.name));
    for (const stem of stems) {
      expect(stem.render.notes, stem.lane).toBeGreaterThan(0);
      /* Each is a summand of the master's *pre-headroom* peak. If stems were sliced off
         the finished mix they would each carry the sum's gain reduction, and a producer
         summing them back together would get a quieter mix than the one auditioned. */
      expect(stem.render.peak, stem.lane).toBeLessThanOrEqual(master.peak + 1e-6);
    }
  }, 90000);
});

describe('the picture', () => {
  it('draws clips only where the lane actually plays', () => {
    for (const track of ALL) {
      const steps = stepCount(track);
      for (const lane of track.lanes) {
        const clips = laneClips(lane, steps);
        expect(clips.length).toBeGreaterThan(0);
        for (const clip of clips) {
          expect(clip.left).toBeGreaterThanOrEqual(0);
          expect(clip.left + clip.width).toBeLessThanOrEqual(100.0001);
          expect(clip.cells.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('has nothing to draw for a lane with no notes', () => {
    expect(laneClips({ name: 'lead', hue: 195, notes: [], salt: 's' }, 64)).toEqual([]);
  });
});

describe('the exports', () => {
  it('offers a menu of its own, defaulting to something that exists in it', () => {
    expect(formatsFor('loop')).toBe(LOOP_FORMATS);
    /* The loop has no `soundline` and no single-recipe `js` entry — either would export
       one note of an arrangement under the name of the whole thing. */
    expect(LOOP_FORMATS.some((format) => format.id === 'soundline')).toBe(false);
    expect(LOOP_FORMATS.some((format) => format.id === 'js')).toBe(false);
    expect(LOOP_FORMATS).toContain(formatById('nonsense', LOOP_FORMATS));
    for (const format of LOOP_FORMATS) expect(format.extension).not.toBe('');
  });

  it('writes a module with one compiled voice per distinct recipe, and every hit in it', () => {
    const track = TRACKS[0] as LoopTrack;
    const plan = schedule(track);
    const module = toModule(track, 7, false);

    expect(plan.hits.length).toBe(track.lanes.reduce((total, lane) => total + lane.notes.length, 0));
    expect(plan.voices.length).toBeLessThanOrEqual(plan.hits.length);
    /* Every hit references a voice that exists — an off-by-one in the dedup would be an
       arrangement with a hole in it that only shows up when somebody runs the export. */
    for (const hit of plan.hits) expect(plan.voices[hit.voice]).toBeDefined();

    expect(module).toContain('export default function playLoop');
    expect(module).toContain(`bpm: ${String(track.bpm)}`);
    expect((module.match(/\n {2}\[\d+, \d+\],/g) ?? []).length).toBe(plan.hits.length);
    /* No stray annotations in the untyped emitter — a `.js` file with `: AudioContext`
       in it is a broken file, and the two emitters share every line but four. */
    expect(module).not.toContain(': AudioContext');
    expect(toModule(track, 7, true)).toContain('ctx: AudioContext');
  });

  it('writes a Standard MIDI File a DAW can open', () => {
    const track = TRACKS[1] as LoopTrack;
    const bytes = toMidi(track);
    const text = (from: number, length: number): string =>
      String.fromCharCode(...[...bytes.slice(from, from + length)]);

    expect(text(0, 4)).toBe('MThd');
    /* Header length 6, format 1, then the track count: a conductor track plus one per lane. */
    expect([...bytes.slice(4, 10)]).toEqual([0, 0, 0, 6, 0, 1]);
    expect((bytes[10] ?? 0) * 256 + (bytes[11] ?? 0)).toBe(track.lanes.length + 1);
    expect(text(14, 4)).toBe('MTrk');

    /* Percussion has to be on channel 10 — that is what makes note 36 a kick rather
       than a very low C on whatever patch happens to be loaded. */
    const chunks = [...bytes].reduce<number[]>((found, _, index) => {
      if (text(index, 4) === 'MTrk') found.push(index);
      return found;
    }, []);
    expect(chunks.length).toBe(track.lanes.length + 1);

    const drumLane = track.lanes.findIndex((lane) => LANES[lane.name]?.drum === true);
    expect(drumLane).toBeGreaterThanOrEqual(0);
    const start = chunks[drumLane + 1] ?? 0;
    const body = [...bytes.slice(start, (chunks[drumLane + 2] ?? bytes.length))];
    expect(body.some((byte, index) => byte === 0x99 && index > 0)).toBe(true);
  });

  /**
   * The program changes, which are the only place a General MIDI sound bank belongs.
   *
   * A bank cannot go in the player — a soundline compiles to a function with no assets, and a
   * sampler would make that a lie — but a program change is fourteen bytes that hand the whole
   * question to whatever the file is opened in. Get them wrong and the payoff is silently lost:
   * the file still opens, still plays, and every track is a piano.
   */
  it('names each lane a General MIDI instrument, per lane and not per synthesis technique', () => {
    const track: LoopTrack = {
      ...(TRACKS[0] as LoopTrack),
      lanes: ['guitar', 'organ', 'choir', 'chords'].map((name, index) =>
        composeLane({ id: 'gm', bars: 8, key: 'A min', prompt: 'a distorted guitar carrying it' }, name, index, 's'),
      ),
    };
    const bytes = [...toMidi(track)];
    const marker = (at: number): string => String.fromCharCode(...bytes.slice(at, at + 4));
    const chunks = bytes.reduce<number[]>((found, _, index) => {
      if (marker(index) === 'MTrk') found.push(index);
      return found;
    }, []);
    /* Track 0 is the conductor, so lane n is track n+1. Read the program change out of that
       track's own bytes rather than scanning the file, or a delta time could answer instead. */
    const programOf = (lane: number): number | undefined => {
      const body = bytes.slice(chunks[lane + 1] ?? 0, chunks[lane + 2] ?? bytes.length);
      /* Read the layout rather than hunting for a status byte: a chunk's own length field is
         four raw bytes and can hold 0xC3 as easily as a program change can. The writer puts
         the track name first, so the program change begins one delta after it ends. */
      const name = body.findIndex((byte, index) => byte === 0xff && body[index + 1] === 0x03);
      if (name < 0) return undefined;
      const after = name + 3 + (body[name + 2] ?? 0);
      const status = body[after + 1] ?? 0;
      return status >= 0xc0 && status <= 0xcf ? body[after + 2] : undefined;
    };
    /* Zero-based programs: 30 is what a DAW displays as 31, Distortion Guitar. */
    expect(programOf(0)).toBe(30); // guitar → Distortion Guitar
    expect(programOf(1)).toBe(16); // organ → Drawbar Organ
    expect(programOf(2)).toBe(52); // choir → Choir Aahs
    /* The one the old by-family table got wrong: `chords` and `stabs` shared program 4, an
       electric piano, because a family is a technique and a program is an instrument. */
    expect(programOf(3)).toBe(24); // chords → Nylon guitar, a plucked string
    /* And every lane in the table has an instrument of its own, or the export quietly hands a
       DAW a piano for it. */
    for (const name of Object.keys(LANES)) {
      const one: LoopTrack = {
        ...(TRACKS[0] as LoopTrack),
        lanes: [composeLane({ id: 'gm', bars: 8, key: 'A min', prompt: 'a brief' }, name, 0, 's')],
      };
      const found = [...toMidi(one)];
      const chunk = found.reduce<number[]>((all, _, index) => {
        if (String.fromCharCode(...found.slice(index, index + 4)) === 'MTrk') all.push(index);
        return all;
      }, []);
      const body = found.slice(chunk[1] ?? 0);
      const meta = body.findIndex((byte, index) => byte === 0xff && body[index + 1] === 0x03);
      const status = body[meta + 3 + (body[meta + 2] ?? 0) + 1] ?? 0;
      expect(status >= 0xc0 && status <= 0xcf, `${name} has no program change`).toBe(true);
    }
  });

  it('scales a MIDI tick off the same grid the audio is scheduled on', () => {
    const track = TRACKS[0] as LoopTrack;
    /* One bar of steps is one bar of seconds: the two clocks are derived from the same
       tempo, and a disagreement here is a MIDI file that drifts against the WAV. */
    expect(stepSeconds(track) * STEPS_PER_BAR * track.bars).toBeCloseTo(loopSeconds(track), 9);
  });
});
