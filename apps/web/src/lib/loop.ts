/**
 * NeurosLoop: a game soundtrack as a grid of soundline voices.
 *
 * ## Why this is not a second synthesis engine
 *
 * A loop here is **not** a new kind of audio object. It is a list of note events, and
 * every event resolves to an ordinary `soundline` recipe rendered by the same compiler,
 * the same IR and the same two backends as everything else in this repository — see
 * `lib/loop-voice.ts` for the voices and `lib/loop-render.ts` for the mixdown. That is
 * the whole design constraint: a soundtrack must be exportable as *code* for the same
 * reason a sound effect is, and it can only be exportable as code if it is made of the
 * same primitives.
 *
 * So this module owns exactly two things a sound effect does not need: **when** a voice
 * fires, and **at what pitch**. Everything downstream is existing machinery.
 *
 * ## The composer is a function, not a model
 *
 * Pressing Compose does not call a language model, and the interface never claims it
 * does. What it does is deterministic: the preset names the palette (tempo, key, bars,
 * which lanes exist), {@link knobsFor} reads a handful of keywords out of the prompt,
 * and everything else falls out of one seeded PRNG per lane. Same preset plus same
 * prompt plus same salt gives the same arrangement, byte for byte, forever.
 *
 * That is a deliberate trade and it is worth stating plainly. A model would write better
 * melodies. But this screen would then need a key, a network round trip and a repair
 * loop for a result that cannot be validated the way a soundline can — there is no
 * "physics of a chord progression" for a validator to check. A seeded composer is honest
 * about being a generator of *plausible* arrangements, is instant, is free, works
 * offline, and — the part that actually matters — produces the note events that the
 * MIDI and JavaScript exports need. Someone who wants a better melody has the MIDI.
 *
 * ## Velocity lives in the recipe
 *
 * A note's loudness is written into its voice's `gain` rather than carried beside the
 * buffer as a multiplier. It costs a few extra renders — velocity is quantized to
 * {@link VELOCITY_STEP} so the cache still collapses them — and it buys the property the
 * export depends on: **one note is one recipe**, so the emitted module is a table of
 * `codegen` arrow functions plus a schedule of `(voice, step)` pairs, with no gain
 * plumbing wrapped around the generated code. See `lib/loop-export.ts`.
 *
 * @packageDocumentation
 */

/** Sixteenth notes. The grid every pattern, picture and export is written against. */
export const STEPS_PER_BAR = 16;

/** Steps per beat, which is what turns a step index into a MIDI tick. */
export const STEPS_PER_BEAT = 4;

/**
 * Velocity quantum.
 *
 * Twenty levels is finer than a listener can hear on a percussive hit and coarse enough
 * that a sixteen-bar hat lane resolves to three or four distinct recipes instead of a
 * hundred and twenty-eight. The whole point of baking velocity into the recipe is that
 * identical text renders once; a continuous velocity would defeat that.
 */
export const VELOCITY_STEP = 0.05;

/* ------------------------------------------------------------------------- *
 * Determinism
 * ------------------------------------------------------------------------- */

/**
 * FNV-1a over a string, as a positive 31-bit integer.
 *
 * The same shape `ghostBars` uses, and for the same reason: a card that reshuffles
 * itself on repaint is noise, and an arrangement that changes when React re-renders
 * would be worse than noise.
 */
export function hash(text: string): number {
  let state = 2166136261;
  for (let i = 0; i < text.length; i++) {
    state ^= text.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return (state >>> 1) || 1;
}

/**
 * MINSTD, the generator the exported code already uses.
 *
 * Deliberately the same one as `packages/core`: full period, no weak low bits, and no
 * second PRNG in the repository for a reader to wonder about. The state must never
 * reach zero, which is what the modulo dance on the way in is for.
 */
export function rng(seed: number): () => number {
  let state = (Math.abs(Math.trunc(seed)) % 2147483646) + 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

/* ------------------------------------------------------------------------- *
 * Pitch
 * ------------------------------------------------------------------------- */

/** Semitone offset of every note name the presets use. */
const SEMITONE: Readonly<Record<string, number>> = {
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11,
};

/** Natural minor and major, as semitone offsets from the root. */
const SCALES = {
  min: [0, 2, 3, 5, 7, 8, 10],
  maj: [0, 2, 4, 5, 7, 9, 11],
} as const;

/** A key signature, resolved into the two numbers the composer needs. */
export interface Key {
  /** Semitone of the root within an octave, 0 = C. */
  readonly root: number;
  readonly scale: readonly number[];
  readonly minor: boolean;
}

/**
 * Read `"F# min"` into a root and a scale.
 *
 * Anything unreadable falls back to A minor rather than throwing: a key signature is a
 * label on a preset, and a typo in one should cost a different mode, not a blank screen.
 */
export function parseKey(text: string): Key {
  const [name = 'A', mode = 'min'] = text.trim().split(/\s+/);
  const root = SEMITONE[name.toUpperCase()] ?? 9;
  const minor = !mode.toLowerCase().startsWith('maj');
  return { root, scale: minor ? SCALES.min : SCALES.maj, minor };
}

/**
 * MIDI note for a scale degree, where degree 0 is the root of `octave`.
 *
 * Degrees run past the end of the scale in both directions — degree 7 is the root an
 * octave up, degree −1 is the seventh below — which is what lets an arpeggio and a chord
 * voicing be written as plain arithmetic instead of as a table.
 */
export function degreeToMidi(key: Key, degree: number, octave: number): number {
  const length = key.scale.length;
  const octaves = Math.floor(degree / length);
  const index = degree - octaves * length;
  return 12 * (octave + 1) + key.root + (key.scale[index] ?? 0) + 12 * octaves;
}

/** Concert pitch, A4 = 440 Hz. */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/* ------------------------------------------------------------------------- *
 * Lanes
 * ------------------------------------------------------------------------- */

/**
 * Lane hues, in the order lanes are added to a track.
 *
 * The same trick the rest of the playground plays with `--hue`: the lane label, its
 * clips, the composing indicator's dot and the mute button are one colour, so the eye
 * follows a lane down the timeline without reading its name.
 */
export const LANE_HUES: readonly number[] = [195, 150, 300, 80, 340, 120, 42, 265];

/** How a lane's pattern is written, and what it is played with. */
export interface LaneSpec {
  /** Which family in `lib/loop-voice.ts` renders a note of this lane. */
  readonly family: 'kit' | 'bass' | 'pluck' | 'bell' | 'lead' | 'pad' | 'air';
  /** Which pattern generator writes the notes. */
  readonly pattern: 'kit' | 'bass' | 'chord' | 'arp' | 'pad' | 'accent';
  /** Octave the lane sits in. Degrees are counted from the key's root in it. */
  readonly octave: number;
  /**
   * Where this lane sits in the mix, 0…1.
   *
   * Separate from a note's velocity on purpose, and applied in exactly one place —
   * `voiceFor` in `lib/loop-voice.ts`. Velocity is musical and goes into the MIDI;
   * this is the balance decision, and folding it into velocity would mean turning a
   * shaker down also rewrote the exported score.
   */
  readonly level: number;
  /** Whether the lane is percussion — decides the MIDI channel and the voice map. */
  readonly drum?: true;
}

/**
 * Every lane a preset may name.
 *
 * Deliberately a closed table rather than free text: a lane name selects a voice family,
 * a register and a pattern generator all at once, so an unknown name has nothing to
 * play. Adding a lane is one row here, one row in `LANE_MESSAGE`, and a case in
 * `lib/loop-voice.ts` if the family is new.
 */
export const LANES: Readonly<Record<string, LaneSpec>> = {
  drums: { family: 'kit', pattern: 'kit', octave: 0, level: 1, drum: true },
  perc: { family: 'kit', pattern: 'kit', octave: 0, level: 0.6, drum: true },
  bass: { family: 'bass', pattern: 'bass', octave: 2, level: 0.85 },
  chords: { family: 'pluck', pattern: 'chord', octave: 3, level: 0.5 },
  keys: { family: 'pluck', pattern: 'chord', octave: 4, level: 0.55 },
  stabs: { family: 'lead', pattern: 'chord', octave: 4, level: 0.5 },
  lead: { family: 'lead', pattern: 'arp', octave: 5, level: 0.5 },
  arp: { family: 'pluck', pattern: 'arp', octave: 5, level: 0.42 },
  bells: { family: 'bell', pattern: 'arp', octave: 6, level: 0.34 },
  fx: { family: 'air', pattern: 'accent', octave: 5, level: 0.3 },
  pads: { family: 'pad', pattern: 'pad', octave: 3, level: 0.4 },
  strings: { family: 'pad', pattern: 'pad', octave: 3, level: 0.36 },
  choir: { family: 'pad', pattern: 'pad', octave: 4, level: 0.3 },
  drone: { family: 'pad', pattern: 'pad', octave: 1, level: 0.45 },
  air: { family: 'air', pattern: 'pad', octave: 5, level: 0.22 },
};

/** Lanes "Add tracks" may propose, in the order it offers them. */
export const SPARE_LANES: readonly string[] = ['perc', 'arp', 'fx', 'bells', 'strings', 'keys', 'choir'];

/* ------------------------------------------------------------------------- *
 * Presets
 * ------------------------------------------------------------------------- */

/** A palette: tempo, key, length and the lanes that make it that kind of music. */
export interface LoopPreset {
  readonly id: string;
  readonly bpm: number;
  readonly bars: number;
  readonly key: string;
  readonly lanes: readonly string[];
  /** The prompt the box is filled with when the preset is picked. */
  readonly prompt: string;
}

/** The six palettes on offer. */
export const LOOP_PRESETS: readonly LoopPreset[] = [
  {
    id: 'overworld-run',
    bpm: 128,
    bars: 16,
    key: 'A min',
    lanes: ['drums', 'bass', 'chords', 'lead'],
    prompt: 'bright overworld theme — plucky lead, walking bass, light shaker, upbeat',
  },
  {
    id: 'boss-fight',
    bpm: 150,
    bars: 16,
    key: 'D min',
    lanes: ['drums', 'perc', 'bass', 'stabs', 'lead'],
    prompt: 'relentless boss fight — driving toms, detuned bass stabs, alarm lead',
  },
  {
    id: 'cave-ambience',
    bpm: 80,
    bars: 8,
    key: 'F# min',
    lanes: ['drone', 'pads', 'bells'],
    prompt: 'dripping cave ambience — airy pad, sparse bells, sub drone',
  },
  {
    id: 'night-market',
    bpm: 104,
    bars: 16,
    key: 'G maj',
    lanes: ['drums', 'bass', 'keys', 'air'],
    prompt: 'cozy night market — muted keys, round bass, brushed kit, crowd air',
  },
  {
    id: 'menu-drift',
    bpm: 92,
    bars: 8,
    key: 'C maj',
    lanes: ['pads', 'arp', 'bass'],
    prompt: 'weightless menu loop — soft arp, warm pad, no drums',
  },
  {
    id: 'rooftop-chase',
    bpm: 160,
    bars: 16,
    key: 'E min',
    lanes: ['drums', 'bass', 'pads', 'fx'],
    prompt: 'rooftop chase — breakbeat, siren pad, urgent bass',
  },
];

/** The preset with this id, or the first one. */
export function presetById(id: string): LoopPreset {
  return LOOP_PRESETS.find((preset) => preset.id === id) ?? (LOOP_PRESETS[0] as LoopPreset);
}

/* ------------------------------------------------------------------------- *
 * What the prompt is allowed to do
 * ------------------------------------------------------------------------- */

/** The four things a prompt can move, plus the lanes it asks to be left out. */
export interface Knobs {
  /** Seed derived from the prompt: different wording, different arrangement. */
  readonly seed: number;
  /** −1 sparse … +1 busy. Scales how often an optional hit is taken. */
  readonly density: number;
  /** −1 dark … +1 bright. Moves every voice's filter cutoff. */
  readonly brightness: number;
  /** Multiplier on the preset's tempo, clamped to ±20%. */
  readonly tempo: number;
  /** Lanes the prompt asked for without ("no drums"), dropped before composing. */
  readonly without: readonly string[];
}

/**
 * The keyword table.
 *
 * English only, and that is a real limitation worth naming rather than hiding: the
 * interface ships in nine languages and this reads one. It is not a translation problem
 * — the words here are *musical direction*, and the honest fix is a model, not nine more
 * word lists. Until then a prompt in another language still changes the seed, so it
 * still produces its own arrangement; it just does not steer the tempo.
 */
const WORDS: readonly (readonly [RegExp, Partial<Record<'density' | 'brightness' | 'tempo', number>>])[] = [
  [/\b(fast|faster|driving|urgent|frantic|relentless|chase|breakbeat)\b/, { tempo: 0.12, density: 0.3 }],
  [/\b(slow|slower|lazy|sleepy|drift|weightless|calm|still)\b/, { tempo: -0.14, density: -0.3 }],
  [/\b(busy|dense|thick|layered|crowded|chaotic)\b/, { density: 0.45 }],
  [/\b(sparse|minimal|empty|bare|quiet|spacious|sparsely)\b/, { density: -0.45 }],
  [/\b(bright|shimmer|shimmering|airy|crisp|glassy|plucky|upbeat)\b/, { brightness: 0.4 }],
  [/\b(dark|darker|muffled|muddy|deep|heavy|murky|dripping|cave)\b/, { brightness: -0.4 }],
  [/\b(warm|round|soft|cozy|muted|gentle)\b/, { brightness: -0.2, density: -0.15 }],
];

/** `no drums`, `without percussion`, `drumless` — the shapes people actually write. */
const WITHOUT = /\b(?:no|without|drop the|minus)\s+([a-z]+)\b/g;

/** Aliases, so "percussion" and "drum" find the lanes they mean. */
const LANE_ALIASES: Readonly<Record<string, string>> = {
  drum: 'drums',
  drums: 'drums',
  percussion: 'perc',
  perc: 'perc',
  bass: 'bass',
  pad: 'pads',
  pads: 'pads',
  lead: 'lead',
  keys: 'keys',
  arp: 'arp',
  bells: 'bells',
  strings: 'strings',
  choir: 'choir',
  fx: 'fx',
  drone: 'drone',
  air: 'air',
  chords: 'chords',
  stabs: 'stabs',
};

/** Read a prompt into the knobs the composer respects. */
export function knobsFor(prompt: string): Knobs {
  const text = prompt.toLowerCase();
  let density = 0;
  let brightness = 0;
  let tempo = 0;

  for (const [pattern, effect] of WORDS) {
    if (!pattern.test(text)) continue;
    density += effect.density ?? 0;
    brightness += effect.brightness ?? 0;
    tempo += effect.tempo ?? 0;
  }

  const without: string[] = [];
  for (const match of text.matchAll(WITHOUT)) {
    const lane = LANE_ALIASES[match[1] ?? ''];
    if (lane !== undefined && !without.includes(lane)) without.push(lane);
  }

  const clamp = (value: number): number => Math.max(-1, Math.min(1, value));
  return {
    seed: hash(text.trim() === '' ? 'silence' : text.trim()),
    density: clamp(density),
    brightness: clamp(brightness),
    tempo: 1 + clamp(tempo) * 0.2,
    without,
  };
}

/* ------------------------------------------------------------------------- *
 * The arrangement
 * ------------------------------------------------------------------------- */

/** One note, on the sixteenth-note grid. */
export interface LoopNote {
  /** Grid position, 0 … `bars * STEPS_PER_BAR - 1`. */
  readonly step: number;
  readonly midi: number;
  /** 0 … 1, already quantized to {@link VELOCITY_STEP}. */
  readonly gain: number;
  /** How long it sounds, in steps. Drives the voice's decay and the MIDI duration. */
  readonly length: number;
}

/** One instrument's part. */
export interface LoopLane {
  readonly name: string;
  readonly hue: number;
  readonly notes: readonly LoopNote[];
  /** Set while this lane is an unaccepted proposal from "Add tracks". */
  readonly proposed?: boolean;
  /** What produced it — kept so ↻ can recompose exactly this lane. */
  readonly salt: string;
}

/** A soundtrack. */
export interface LoopTrack {
  readonly id: string;
  readonly name: string;
  readonly preset: string;
  readonly bpm: number;
  readonly bars: number;
  readonly key: string;
  readonly prompt: string;
  readonly lanes: readonly LoopLane[];
}

/** Steps in the whole loop. */
export function stepCount(track: LoopTrack): number {
  return track.bars * STEPS_PER_BAR;
}

/** Seconds per sixteenth. */
export function stepSeconds(track: LoopTrack): number {
  return 60 / track.bpm / STEPS_PER_BEAT;
}

/** Seconds the loop takes to come round. */
export function loopSeconds(track: LoopTrack): number {
  return stepCount(track) * stepSeconds(track);
}

/** Round a velocity to the grid the render cache is keyed on. */
function velocity(value: number): number {
  const clamped = Math.max(VELOCITY_STEP, Math.min(1, value));
  return Math.round(clamped / VELOCITY_STEP) * VELOCITY_STEP;
}

/**
 * The chord under each bar, as a scale degree for its root.
 *
 * Two progressions per mode, chosen by the lane-independent track seed so every lane
 * agrees about the harmony. Degrees rather than chord names because a degree is what
 * {@link degreeToMidi} takes, and because naming them would imply a theory of voicing
 * this does not have.
 */
export function progression(key: Key, seed: number, bars: number): readonly number[] {
  const options = key.minor
    ? [
        [0, 5, 3, 4],
        [0, 3, 5, 4],
      ]
    : [
        [0, 3, 4, 3],
        [0, 5, 3, 4],
      ];
  const chosen = options[seed % options.length] ?? [0, 5, 3, 4];
  return Array.from({ length: bars }, (_, bar) => chosen[bar % chosen.length] ?? 0);
}

/** GM percussion notes, so the MIDI export lands on the right pads in any DAW. */
export const DRUM = { kick: 36, rim: 37, snare: 38, clap: 39, hatClosed: 42, hatOpen: 46 } as const;

/** Everything a pattern generator needs that is not the lane itself. */
interface Bed {
  readonly key: Key;
  readonly chords: readonly number[];
  readonly steps: number;
  readonly knobs: Knobs;
}

/** A drum grid: kick on the bar, snare on the backbeat, hats filling between them. */
function kitPattern(bed: Bed, random: () => number, sparse: boolean): LoopNote[] {
  const notes: LoopNote[] = [];
  const fill = 0.5 + bed.knobs.density * 0.35;

  for (let step = 0; step < bed.steps; step++) {
    const inBar = step % STEPS_PER_BAR;
    const lastBar = Math.floor(step / STEPS_PER_BAR) === bed.steps / STEPS_PER_BAR - 1;

    if (sparse) {
      /* A colour lane: off the strong beats on purpose, so it reads as decoration
         rather than as a second kit fighting the first. */
      if (inBar % 4 !== 2) continue;
      if (random() > fill * 0.55) continue;
      notes.push({ step, midi: random() > 0.6 ? DRUM.rim : DRUM.clap, gain: velocity(0.35 + random() * 0.2), length: 1 });
      continue;
    }

    if (inBar === 0 || inBar === 10 || (inBar === 6 && random() < fill * 0.4)) {
      notes.push({ step, midi: DRUM.kick, gain: velocity(inBar === 0 ? 0.95 : 0.75), length: 2 });
    }
    if (inBar === 4 || inBar === 12) {
      notes.push({ step, midi: DRUM.snare, gain: velocity(0.8), length: 2 });
    }
    if (inBar % 2 === 0 && random() < 0.55 + bed.knobs.density * 0.3) {
      const open = lastBar && inBar === 14;
      notes.push({
        step,
        midi: open ? DRUM.hatOpen : DRUM.hatClosed,
        gain: velocity(inBar % 4 === 0 ? 0.55 : 0.35),
        length: open ? 2 : 1,
      });
    }
  }
  return notes;
}

/** Root on the downbeat, then whatever syncopation the density asks for. */
function bassPattern(spec: LaneSpec, bed: Bed, random: () => number): LoopNote[] {
  const notes: LoopNote[] = [];
  for (let step = 0; step < bed.steps; step += 2) {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const inBar = step % STEPS_PER_BAR;
    const root = bed.chords[bar % bed.chords.length] ?? 0;
    if (inBar === 0) {
      notes.push({ step, midi: degreeToMidi(bed.key, root, spec.octave), gain: velocity(0.85), length: 4 });
      continue;
    }
    if (random() > 0.32 + bed.knobs.density * 0.28) continue;
    /* Fifth and octave only. A passing tone from a random walk is what makes a
       generated bass line sound generated. */
    const degree = root + (random() < 0.65 ? 4 : 7);
    notes.push({ step, midi: degreeToMidi(bed.key, degree, spec.octave), gain: velocity(0.5 + random() * 0.2), length: 2 });
  }
  return notes;
}

/** A triad per bar, sometimes pushed again halfway through it. */
function chordPattern(spec: LaneSpec, bed: Bed, random: () => number): LoopNote[] {
  const notes: LoopNote[] = [];
  const bars = bed.steps / STEPS_PER_BAR;
  for (let bar = 0; bar < bars; bar++) {
    const root = bed.chords[bar % bed.chords.length] ?? 0;
    const hits = [0, ...(random() < 0.4 + bed.knobs.density * 0.3 ? [8] : [])];
    for (const offset of hits) {
      for (const interval of [0, 2, 4]) {
        notes.push({
          step: bar * STEPS_PER_BAR + offset,
          midi: degreeToMidi(bed.key, root + interval, spec.octave),
          gain: velocity((offset === 0 ? 0.7 : 0.5) - interval * 0.04),
          length: offset === 0 ? 6 : 4,
        });
      }
    }
  }
  return notes;
}

/** Chord tones walked in eighths, with rests where the density says to breathe. */
function arpPattern(spec: LaneSpec, bed: Bed, random: () => number): LoopNote[] {
  const notes: LoopNote[] = [];
  const shape = [0, 2, 4, 2, 7, 4, 2, 0];
  const rest = 0.28 - bed.knobs.density * 0.2;
  for (let step = 0; step < bed.steps; step += 2) {
    if (random() < rest) continue;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const root = bed.chords[bar % bed.chords.length] ?? 0;
    const degree = root + (shape[(step / 2) % shape.length] ?? 0);
    notes.push({ step, midi: degreeToMidi(bed.key, degree, spec.octave), gain: velocity(0.45 + random() * 0.25), length: 2 });
  }
  return notes;
}

/** One held chord per two bars — the thing a listener hears as "the pad". */
function padPattern(spec: LaneSpec, bed: Bed, random: () => number): LoopNote[] {
  const notes: LoopNote[] = [];
  const span = STEPS_PER_BAR * 2;
  for (let step = 0; step < bed.steps; step += span) {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const root = bed.chords[bar % bed.chords.length] ?? 0;
    /* A drone holds the root alone; anything else takes the triad, minus the third
       when the prompt asked for sparse — an open fifth is the sound of "less". */
    const intervals = spec.octave <= 1 ? [0] : bed.knobs.density < -0.2 ? [0, 4] : [0, 2, 4];
    for (const interval of intervals) {
      notes.push({
        step,
        midi: degreeToMidi(bed.key, root + interval, spec.octave),
        gain: velocity(0.6 - interval * 0.05 + random() * 0.08),
        length: span,
      });
    }
  }
  return notes;
}

/** One or two events in the whole loop: a riser, a hit, a whoosh. */
function accentPattern(spec: LaneSpec, bed: Bed, random: () => number): LoopNote[] {
  const count = 1 + (random() < 0.5 ? 1 : 0);
  const notes: LoopNote[] = [];
  for (let i = 0; i < count; i++) {
    const bar = Math.floor(random() * (bed.steps / STEPS_PER_BAR));
    notes.push({
      step: bar * STEPS_PER_BAR,
      midi: degreeToMidi(bed.key, bed.chords[bar % bed.chords.length] ?? 0, spec.octave),
      gain: velocity(0.4 + random() * 0.2),
      length: STEPS_PER_BAR,
    });
  }
  return notes.sort((a, b) => a.step - b.step);
}

/**
 * Compose one lane.
 *
 * `salt` is what makes ↻ produce a different take of the same lane in the same track:
 * it is mixed into the seed and stored on the lane, so a recomposition is reproducible
 * rather than merely random.
 */
export function composeLane(
  track: Pick<LoopTrack, 'id' | 'bars' | 'key' | 'prompt'>,
  name: string,
  index: number,
  salt: string,
): LoopLane {
  const spec = LANES[name];
  const hue = LANE_HUES[index % LANE_HUES.length] ?? 195;
  if (spec === undefined) return { name, hue, notes: [], salt };

  const knobs = knobsFor(track.prompt);
  const key = parseKey(track.key);
  const bed: Bed = {
    key,
    chords: progression(key, knobs.seed, track.bars),
    steps: track.bars * STEPS_PER_BAR,
    knobs,
  };
  const random = rng(hash(`${track.id}/${name}/${salt}`) ^ knobs.seed);

  const notes =
    spec.pattern === 'kit'
      ? kitPattern(bed, random, name !== 'drums')
      : spec.pattern === 'bass'
        ? bassPattern(spec, bed, random)
        : spec.pattern === 'chord'
          ? chordPattern(spec, bed, random)
          : spec.pattern === 'arp'
            ? arpPattern(spec, bed, random)
            : spec.pattern === 'pad'
              ? padPattern(spec, bed, random)
              : accentPattern(spec, bed, random);

  return { name, hue, notes, salt };
}

/** A fresh soundtrack from a preset and a prompt, with every lane composed. */
export function composeTrack(id: string, preset: LoopPreset, prompt: string, name: string, salt: string): LoopTrack {
  const knobs = knobsFor(prompt);
  const skeleton = {
    id,
    name,
    preset: preset.id,
    /* Whole beats per minute: a tempo of 141.3 is unusable in every tool the MIDI
       export lands in, and the keyword nudge is a direction, not a measurement. */
    bpm: Math.round(preset.bpm * knobs.tempo),
    bars: preset.bars,
    key: preset.key,
    prompt,
  };
  const wanted = preset.lanes.filter((lane) => !knobs.without.includes(lane));
  /* Refuse to compose nothing. "no drums" on a drums-only preset is a mistake worth
     ignoring rather than a request for silence. */
  const lanes = (wanted.length > 0 ? wanted : preset.lanes).map((lane, index) =>
    composeLane(skeleton, lane, index, salt),
  );
  return { ...skeleton, lanes };
}

/** The lanes "Add tracks" would propose next for this track, at most two. */
export function proposals(track: LoopTrack): readonly string[] {
  const present = track.lanes.map((lane) => lane.name);
  return SPARE_LANES.filter((lane) => !present.includes(lane)).slice(0, 2);
}

/* ------------------------------------------------------------------------- *
 * The picture
 * ------------------------------------------------------------------------- */

/** A run of activity in a lane, as the timeline draws it. */
export interface LoopClip {
  /** Left edge as a percentage of the loop. */
  readonly left: number;
  readonly width: number;
  /** One cell per step in the run: height 0…100, opacity 0…1. */
  readonly cells: readonly { readonly h: number; readonly o: number }[];
}

/**
 * How far apart two notes may be and still be drawn as one clip.
 *
 * Half a bar. Closer than that and a lane with a rest every other beat becomes fifty
 * boxes; further and a lane that plays once per phrase looks continuous. The picture is
 * derived from the notes rather than drawn from a shape table, which is the point — what
 * is on screen is the arrangement, not an illustration of one.
 */
const CLIP_GAP = STEPS_PER_BAR / 2;

/** A lane's notes, grouped into the clips the timeline draws. */
export function laneClips(lane: LoopLane, steps: number): readonly LoopClip[] {
  if (lane.notes.length === 0) return [];

  /* Peak per step, so a chord's three simultaneous notes are one bar of the picture
     at the loudest of them rather than three overlapping ones. */
  const level = new Float32Array(steps);
  for (const note of lane.notes) {
    for (let i = 0; i < Math.max(1, note.length) && note.step + i < steps; i++) {
      const decay = i === 0 ? 1 : Math.max(0.35, 1 - i / Math.max(1, note.length));
      const at = note.step + i;
      level[at] = Math.max(level[at] ?? 0, note.gain * decay);
    }
  }

  const clips: LoopClip[] = [];
  let from = -1;
  let quiet = 0;
  const flush = (to: number): void => {
    if (from < 0) return;
    const cells: { h: number; o: number }[] = [];
    for (let i = from; i <= to; i++) {
      const value = level[i] ?? 0;
      cells.push({ h: Math.round(Math.max(7, Math.min(96, value * 96))), o: value > 0 ? 0.9 : 0.25 });
    }
    clips.push({ left: (from / steps) * 100, width: ((to - from + 1) / steps) * 100, cells });
    from = -1;
  };

  for (let i = 0; i < steps; i++) {
    if ((level[i] ?? 0) > 0) {
      if (from < 0) from = i;
      quiet = 0;
      continue;
    }
    if (from < 0) continue;
    quiet++;
    if (quiet > CLIP_GAP) flush(i - quiet);
  }
  flush(steps - 1);
  return clips;
}
