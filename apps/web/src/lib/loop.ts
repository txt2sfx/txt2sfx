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
 * ## The composer here is a function; the model is in `lib/score.ts`
 *
 * This file used to open by arguing that a model has no business composing, because a
 * melody cannot be validated the way a soundline can — there is no "physics of a chord
 * progression" for a validator to check. That reasoning was half right, and the half
 * that was wrong is now `lib/score.ts`: a *score* has plenty of checkable physics short
 * of taste, and when a model is connected it writes one and the rules in that file judge
 * it. Everything below the note events is unchanged and unaware of who wrote them.
 *
 * What survives here is the **fallback, and it is not a consolation prize**. With no
 * model connected the screen is exactly what it always was: the preset names the palette
 * (tempo, key, bars, which lanes exist), {@link knobsFor} reads a handful of keywords out
 * of the prompt, and everything else falls out of one seeded PRNG per lane. Same preset
 * plus same prompt plus same salt gives the same arrangement, byte for byte, forever —
 * which is why the three tracks a first visit opens on cost nothing and why a tab with no
 * key still has a working soundtrack screen rather than a dead button asking for one.
 *
 * The interface says which of the two it got. A user who asked for a model composition
 * and quietly received a PRNG one would have every later composition under suspicion.
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
  readonly family:
    | 'kit'
    | 'bass'
    | 'pluck'
    | 'bell'
    | 'lead'
    | 'power'
    | 'guitar'
    | 'organ'
    | 'brass'
    | 'epiano'
    | 'voice'
    | 'pad'
    | 'air';
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
 *
 * ## Why there are named instruments in here and not only roles
 *
 * `chords`, `stabs` and `pads` are *roles* — what a part does in an arrangement. `guitar`,
 * `organ`, `brass` and `epiano` are **instruments**, and mixing the two kinds in one table is
 * deliberate. A brief that says "distorted guitar" is not describing a role, and the model
 * used to be told in as many words to pick the nearest family and apologise for it in the
 * caption; the nearest family was a synth. An instrument somebody can name is an instrument
 * this table should have a row for, and the row is what makes the request answerable at all.
 */
export const LANES: Readonly<Record<string, LaneSpec>> = {
  drums: { family: 'kit', pattern: 'kit', octave: 0, level: 1, drum: true },
  perc: { family: 'kit', pattern: 'kit', octave: 0, level: 0.6, drum: true },
  bass: { family: 'bass', pattern: 'bass', octave: 2, level: 0.85 },
  chords: { family: 'pluck', pattern: 'chord', octave: 3, level: 0.5 },
  keys: { family: 'pluck', pattern: 'chord', octave: 4, level: 0.55 },
  epiano: { family: 'epiano', pattern: 'chord', octave: 4, level: 0.5 },
  organ: { family: 'organ', pattern: 'chord', octave: 3, level: 0.42 },
  /* Octave 3, not 4, and its own family: this is the heavy chord lane, and a chord lane that
     lives above middle C cannot be heavy however hard it is driven — the register *is* the
     weight. The synthesized one; `guitar` is the same register with an amplifier. */
  stabs: { family: 'power', pattern: 'chord', octave: 3, level: 0.6 },
  /* Both guitar lanes sit at 3 for the reason `stabs` does. `riff` takes the arp generator on
     purpose: a riff is one line, and the thing a metal brief asks for is a low single-note
     figure locked to the kick, not a chord per bar. */
  guitar: { family: 'guitar', pattern: 'chord', octave: 3, level: 0.55 },
  riff: { family: 'guitar', pattern: 'arp', octave: 3, level: 0.5 },
  brass: { family: 'brass', pattern: 'chord', octave: 4, level: 0.48 },
  lead: { family: 'lead', pattern: 'arp', octave: 5, level: 0.5 },
  arp: { family: 'pluck', pattern: 'arp', octave: 5, level: 0.42 },
  bells: { family: 'bell', pattern: 'arp', octave: 6, level: 0.34 },
  fx: { family: 'air', pattern: 'accent', octave: 5, level: 0.3 },
  pads: { family: 'pad', pattern: 'pad', octave: 3, level: 0.4 },
  strings: { family: 'pad', pattern: 'pad', octave: 3, level: 0.36 },
  /* A voice, not a pad with a slow attack — see the `voice` family. Same register, same
     pattern, and the only lane in the table whose *timbre* changed rather than its numbers. */
  choir: { family: 'voice', pattern: 'pad', octave: 4, level: 0.44 },
  drone: { family: 'pad', pattern: 'pad', octave: 1, level: 0.45 },
  air: { family: 'air', pattern: 'pad', octave: 5, level: 0.22 },
};

/**
 * Lanes "Add tracks" may propose, in the order it offers them.
 *
 * `guitar` is second because it is the one lane in the table a listener asks for by name.
 * Only two are ever offered at once, so the tail of this list is reachable through the brief
 * rather than through the button — which is the right way round for `riff` and `brass`.
 */
export const SPARE_LANES: readonly string[] = [
  'perc',
  'guitar',
  'arp',
  'fx',
  'bells',
  'strings',
  'keys',
  'organ',
  'choir',
  'epiano',
  'brass',
  'riff',
];

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
  /** The brief the composer reads. On a built-in palette, the one it ships with. */
  readonly prompt: string;
}

/**
 * The built-in palettes.
 *
 * These are **no longer a control on the screen.** They were, and picking one replaced
 * the whole prompt — which is why every take started from the same six sentences, and
 * why the screen's own notes recorded that "boss fight" typed under `menu-drift` still
 * composed `menu-drift`. The chips are prompt fragments now ({@link LOOP_TAGS}) and the
 * numbers come from {@link paletteFor}.
 *
 * What they still are: the palettes the three opening tracks are built from, so a first
 * visit lands on a screen with something to press Play on, and the reference the fill
 * order in {@link paletteFor} is measured against.
 */
export const LOOP_PRESETS: readonly LoopPreset[] = [
  {
    id: 'overworld-run',
    bpm: 118,
    bars: 16,
    key: 'A min',
    lanes: ['drums', 'bass', 'chords', 'lead'],
    prompt: 'overworld road — plucked chords, walking bass, light kit',
  },
  {
    id: 'boss-fight',
    bpm: 150,
    bars: 16,
    key: 'D min',
    lanes: ['drums', 'perc', 'bass', 'stabs', 'lead'],
    prompt: 'relentless boss fight — driving toms, heavy bass stabs, alarm lead',
  },
  {
    id: 'cave-ambience',
    bpm: 76,
    bars: 8,
    key: 'F# min',
    lanes: ['drone', 'pads', 'bells'],
    prompt: 'dripping cave ambience — muffled pad, sparse bells, sub drone',
  },
  {
    id: 'night-market',
    bpm: 100,
    bars: 16,
    key: 'G maj',
    lanes: ['drums', 'bass', 'keys', 'air'],
    prompt: 'cozy night market — muted keys, round bass, brushed kit, crowd air',
  },
  {
    id: 'menu-drift',
    bpm: 84,
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
 * The prompt fragments
 * ------------------------------------------------------------------------- */

/**
 * Which row of chips a fragment sits in.
 *
 * Five rows rather than one cloud of thirty, because the groups are the *question*: a
 * brief that has a mood, a motion and a place is a brief, and a row per question is what
 * makes a missing one visible. They are not exclusive — nothing here is a radio button.
 */
export type TagGroup = 'mood' | 'motion' | 'texture' | 'kit' | 'place';

/** The rows, in the order they are offered. */
export const TAG_GROUPS: readonly TagGroup[] = ['mood', 'motion', 'texture', 'kit', 'place'];

/**
 * A piece of a brief.
 *
 * A fragment is **text first**: its `phrase` is written into the prompt, which is what
 * the model reads and what {@link knobsFor} scans. The numbers beside it are a *guess* at
 * the palette for the seeded composer and a starting point for the model, never a
 * setting — that is the difference between this and the preset it replaces, where the
 * chip owned the tempo and the words could not argue with it.
 *
 * English, like the keyword table, and for the same reason: these are musical direction,
 * and nine word lists would be nine chances to say something slightly different. The
 * chip shows the fragment itself, so what is added to the prompt is what is on the chip.
 */
export interface LoopTag {
  /** The chip's label, and the id the state keeps. */
  readonly id: string;
  readonly group: TagGroup;
  /** What this chip writes into the brief. */
  readonly phrase: string;
  /** Tempo it implies. Averaged with every other fragment that names one. */
  readonly bpm?: number;
  /** Loop length it implies. The shortest wins — an ambient fragment means fewer bars. */
  readonly bars?: number;
  /** Mode it implies. The first fragment that names one decides. */
  readonly mode?: 'min' | 'maj';
  /** Lanes it pulls in, in the order it wants them. */
  readonly lanes?: readonly string[];
  /** Lanes it refuses, whatever else asked for them. */
  readonly drop?: readonly string[];
}

/**
 * Every fragment on offer.
 *
 * Phrases are written so the keyword table can read them — `dark and low` moves the
 * brightness knob, `driving` moves the tempo — because a fragment that changes only the
 * seed would be a chip that does nothing with no model attached.
 */
export const LOOP_TAGS: readonly LoopTag[] = [
  { id: 'dark', group: 'mood', phrase: 'dark and low', mode: 'min' },
  { id: 'warm', group: 'mood', phrase: 'warm and round' },
  { id: 'melancholy', group: 'mood', phrase: 'melancholy, mournful', mode: 'min' },
  { id: 'hopeful', group: 'mood', phrase: 'hopeful, opening up', mode: 'maj' },
  { id: 'tense', group: 'mood', phrase: 'tense and unresolved', mode: 'min' },
  { id: 'dreamy', group: 'mood', phrase: 'dreamy and blurred' },
  /* The one the screen could not do at all: no fragment, no keyword and no voice reached
     aggression, so a request for something militant came back as ambience with a beat. */
  { id: 'aggressive', group: 'mood', phrase: 'aggressive, militant, brutal', mode: 'min', lanes: ['drums', 'bass', 'stabs'] },

  { id: 'still', group: 'motion', phrase: 'barely moving, still', bpm: 66, bars: 8 },
  { id: 'slow', group: 'motion', phrase: 'slow', bpm: 76 },
  { id: 'pulsing', group: 'motion', phrase: 'one steady pulse under everything', bpm: 100 },
  { id: 'half-time', group: 'motion', phrase: 'half-time, heavy backbeat', bpm: 84 },
  /* 126, the tempo of every military march anybody means when they say one. */
  { id: 'march', group: 'motion', phrase: 'a marching pulse, boots on the downbeat', bpm: 126 },
  { id: 'driving', group: 'motion', phrase: 'driving', bpm: 132 },
  { id: 'frantic', group: 'motion', phrase: 'frantic', bpm: 156 },

  { id: 'tape', group: 'texture', phrase: 'worn tape, soft top end' },
  { id: 'muffled', group: 'texture', phrase: 'muffled, heard through a wall' },
  { id: 'dusty', group: 'texture', phrase: 'dusty and analog' },
  { id: 'industrial', group: 'texture', phrase: 'industrial, distorted, metal on metal' },
  { id: 'glassy', group: 'texture', phrase: 'glassy and crisp' },
  { id: 'wide', group: 'texture', phrase: 'wide and spacious' },
  { id: 'sparse', group: 'texture', phrase: 'sparse — long gaps between events' },

  { id: 'no drums', group: 'kit', phrase: 'no drums', drop: ['drums', 'perc'] },
  { id: 'drums', group: 'kit', phrase: 'a kit that carries it', lanes: ['drums', 'perc'] },
  { id: 'sub bass', group: 'kit', phrase: 'a sub that sits under everything', lanes: ['bass', 'drone'] },
  { id: 'plucks', group: 'kit', phrase: 'plucked chords', lanes: ['chords'] },
  /* The five instruments people ask for by name. Each phrase carries a word the keyword table
     already reads — `distorted`, `palm-muted`, `warm`, `stabbing`, `soft` — so a fragment
     changes the *sound* and not only which lanes exist, which is the rule every other row
     here keeps. They pull a rhythm section in with them: a guitar over nothing is a demo of
     a guitar, and the palette needs three lanes anyway. */
  { id: 'guitar', group: 'kit', phrase: 'a distorted guitar carrying it', lanes: ['guitar', 'drums', 'bass'] },
  { id: 'riff', group: 'kit', phrase: 'a low palm-muted riff', lanes: ['riff', 'drums', 'bass'] },
  { id: 'organ', group: 'kit', phrase: 'a warm drawbar organ, held', lanes: ['organ', 'bass'] },
  { id: 'brass', group: 'kit', phrase: 'a brass section stabbing on the beat', lanes: ['brass', 'drums'] },
  { id: 'e-piano', group: 'kit', phrase: 'a soft electric piano', lanes: ['epiano', 'bass'] },
  { id: 'arp', group: 'kit', phrase: 'a winding arpeggio', lanes: ['arp'] },
  { id: 'bells', group: 'kit', phrase: 'high bells, only a few of them', lanes: ['bells'] },
  { id: 'choir', group: 'kit', phrase: 'a vowel-like choir', lanes: ['choir'] },
  { id: 'drone', group: 'kit', phrase: 'a held drone underneath', lanes: ['drone'] },

  { id: 'cave', group: 'place', phrase: 'in a dripping cave', bpm: 72, bars: 8, lanes: ['drone', 'pads', 'bells'] },
  { id: 'rain', group: 'place', phrase: 'under steady rain', bars: 8, lanes: ['air', 'pads'] },
  { id: 'night city', group: 'place', phrase: 'a night city, neon and far traffic', lanes: ['keys', 'bass', 'air'] },
  { id: 'deep space', group: 'place', phrase: 'deep space, weightless', bpm: 66, bars: 8, lanes: ['pads', 'drone'] },
  { id: 'temple', group: 'place', phrase: 'a stone temple, long reflections', bpm: 72, mode: 'min', lanes: ['choir', 'drone'] },
  { id: 'forest', group: 'place', phrase: 'a forest at dusk', lanes: ['air', 'pads', 'bells'] },
];

/** The fragment with this id, or nothing. */
export function tagById(id: string): LoopTag | undefined {
  return LOOP_TAGS.find((tag) => tag.id === id);
}

/**
 * The brief both composers read: the fragments that were added, then what was typed.
 *
 * Fragments first, in the order they were added, because that is the order they are on
 * screen — the prompt a user can point at is the prompt that was sent.
 */
export function brief(text: string, tags: readonly string[]): string {
  const phrases = tags.map((id) => tagById(id)?.phrase ?? id);
  const typed = text.trim();
  return [...phrases, ...(typed === '' ? [] : [typed])].join(', ');
}

/**
 * A short title for a seeded take.
 *
 * The fragments if there are any, the first words typed otherwise. A model names its own
 * track in the score header, so this is only ever the seeded composer's problem.
 */
export function briefName(text: string, tags: readonly string[]): string {
  if (tags.length > 0) return tags.slice(0, 2).join(' ');
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  return words === '' ? 'untitled' : words;
}

/**
 * Roots the seeded palette chooses between.
 *
 * Eight rather than twelve: the four left out are the ones whose only spelling here is a
 * sharp nobody reads on a key line (`A#`, `D#`, `G#`, `C#` as a minor tonic). The point of
 * the table is that two different briefs land in two different keys — a screen where
 * every take is in A minor is the same monotony as one where every take is in the same
 * register, and it took a preset chip to hide that.
 */
const ROOTS: readonly string[] = ['A', 'B', 'C', 'D', 'E', 'F', 'F#', 'G'];

/**
 * Tempi the seeded palette chooses between when no fragment names one.
 *
 * Deliberately weighted low. The old preset table averaged 119 bpm and its two calmest
 * entries were still 80 and 92; a screen for ambience that never offers 66 bpm unless
 * asked is a screen that has an opinion it never declared.
 */
const TEMPI: readonly number[] = [66, 72, 80, 88, 96, 108, 124];

/**
 * The order lanes are filled in when the fragments do not name enough of them.
 *
 * A backbone, not a preference: one fragment ("bells") is a colour and not a track, so
 * something has to be under it. Pads first because a bed under a colour is a piece of
 * music and a bare colour is a test tone.
 */
const BACKBONE: readonly string[] = ['pads', 'bass', 'drums', 'chords', 'lead', 'arp'];

/** Fewest lanes an arrangement is worth mixing. Under three there is nothing to balance. */
const MIN_LANES = 3;

/**
 * Most lanes a palette will ask for.
 *
 * One under `MAX_LANES` in `lib/score.ts`, so "Add tracks" always has room to propose
 * something rather than opening with "every lane is already here".
 */
const MAX_PALETTE_LANES = 5;

/**
 * The numbers behind a brief.
 *
 * This is what replaced the preset chip. Every value is either something a fragment
 * actually implied, or a seeded choice from a table — never a constant, which is the
 * whole complaint the old screen earned: six palettes meant six tempi, six keys and one
 * of six lane sets, forever, whatever the words said.
 *
 * The seed is the brief itself, so the palette is reproducible from the text alone —
 * which is what keeps `useLoop`'s "nothing seeded is persisted" argument true.
 */
export function paletteFor(text: string, tags: readonly string[]): LoopPreset {
  const written = brief(text, tags);
  const seed = hash(written === '' ? 'silence' : written);
  const picked = tags.map(tagById).filter((tag): tag is LoopTag => tag !== undefined);

  const tempi = picked.map((tag) => tag.bpm).filter((value): value is number => value !== undefined);
  const bpm =
    tempi.length === 0
      ? (TEMPI[seed % TEMPI.length] ?? 96)
      : Math.round(tempi.reduce((total, value) => total + value, 0) / tempi.length);

  const lengths = picked.map((tag) => tag.bars).filter((value): value is number => value !== undefined);
  /* Sixteen unless something asked for less: a four-bar progression needs four bars to
     be a progression, and eight is the shortest loop that can still have a shape. */
  const bars = lengths.length === 0 ? ((seed >> 3) % 4 === 0 ? 8 : 16) : Math.min(...lengths);

  /* Minor three times in four with nothing said. Not neutrality — a default has to be
     something, and the requests this screen gets are ambience far more often than they
     are fanfare. A `hopeful` chip is one press away from saying otherwise. */
  const mode = picked.find((tag) => tag.mode !== undefined)?.mode ?? ((seed >> 11) % 4 === 0 ? 'maj' : 'min');
  const root = ROOTS[(seed >> 5) % ROOTS.length] ?? 'A';

  const drop = new Set(picked.flatMap((tag) => tag.drop ?? []));
  const wanted: string[] = [];
  for (const tag of picked) {
    for (const lane of tag.lanes ?? []) {
      if (!drop.has(lane) && !wanted.includes(lane)) wanted.push(lane);
    }
  }
  const fill = BACKBONE.filter((lane) => !drop.has(lane) && !wanted.includes(lane));
  while (wanted.length < MIN_LANES && fill.length > 0) wanted.push(fill.shift() as string);

  /* Back into the table's own order, so `drums` keeps the first hue and a lane's colour
     does not depend on which chip happened to be pressed first. */
  const order = Object.keys(LANES);
  const lanes = wanted
    .slice(0, MAX_PALETTE_LANES)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));

  return {
    id: tags.length === 0 ? 'free' : tags.join('+'),
    bpm,
    bars,
    key: `${root} ${mode}`,
    lanes,
    prompt: written,
  };
}

/* ------------------------------------------------------------------------- *
 * What the prompt is allowed to do
 * ------------------------------------------------------------------------- */

/** The things a prompt can move, plus the lanes it asks to be left out. */
export interface Knobs {
  /** Seed derived from the prompt: different wording, different arrangement. */
  readonly seed: number;
  /** −1 sparse … +1 busy. Scales how often an optional hit is taken. */
  readonly density: number;
  /** −1 dark … +1 bright. Moves every voice's filter cutoff. */
  readonly brightness: number;
  /** Multiplier on the preset's tempo, clamped to ±20%. */
  readonly tempo: number;
  /**
   * 0 clean … 1 snarling. Saturation on the voices that can take it.
   *
   * A fourth dimension rather than an extreme of `brightness`, because aggression is not
   * brightness: a distorted bass is *darker* and far more aggressive than a clean lead an
   * octave up. Without it the instrument set had no way to be aggressive at all — every
   * sustained voice was a clean filtered saw — so "militant" and "menacing" arrived as
   * arrangement and never as sound. See `lib/loop-voice.ts`.
   */
  readonly drive: number;
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
const WORDS: readonly (readonly [
  RegExp,
  Partial<Record<'density' | 'brightness' | 'tempo' | 'drive', number>>,
])[] = [
  [/\b(fast|faster|driving|urgent|frantic|relentless|chase|breakbeat)\b/, { tempo: 0.12, density: 0.3 }],
  [/\b(slow|slower|lazy|sleepy|drift|weightless|calm|still)\b/, { tempo: -0.14, density: -0.3 }],
  [/\b(busy|dense|thick|layered|crowded|chaotic)\b/, { density: 0.45 }],
  [/\b(sparse|minimal|empty|bare|quiet|spacious|sparsely)\b/, { density: -0.45 }],
  [/\b(bright|shimmer|shimmering|airy|crisp|glassy|plucky|upbeat)\b/, { brightness: 0.4 }],
  [/\b(dark|darker|muffled|muddy|deep|heavy|murky|dripping|cave)\b/, { brightness: -0.4 }],
  [/\b(warm|round|soft|cozy|muted|gentle)\b/, { brightness: -0.2, density: -0.15 }],
  /* The vocabulary the chips brought with them. Without these rows a fragment would
     change the seed and nothing else — a chip that moves the arrangement but not the
     sound is a chip that looks broken with no model attached. */
  [/\b(melancholy|mournful|sombre|somber|wistful|lonely)\b/, { brightness: -0.25, density: -0.2 }],
  [/\b(tense|unresolved|ominous|menacing|uneasy|dread)\b/, { brightness: -0.3, density: 0.1 }],
  [/\b(dreamy|hazy|blurred|underwater|distant|far)\b/, { brightness: -0.15, density: -0.25 }],
  [/\b(tape|worn|dusty|analog|analogue|wool|felt)\b/, { brightness: -0.3 }],
  [/\b(hopeful|sunlit|tender|golden|opening)\b/, { brightness: 0.2 }],
  /* Aggression. Its own dimension because the instrument set had no other way to sound
     angry — see `Knobs.drive`. The first row is what the music *is*, the second is what it
     is made of, and they stack: "industrial war march" is as driven as this gets. */
  [/\b(aggressive|militant|military|march|marching|war|battle|brutal|violent|hostile)\b/, { drive: 0.65, density: 0.2 }],
  [/\b(industrial|metal|distorted|overdriven|harsh|gritty|snarling|hell|savage)\b/, { drive: 0.8, brightness: 0.1 }],
  [/\b(heavy|pounding|hard|crushing|relentless|driving)\b/, { drive: 0.3 }],
  /* How a guitar is played, which in this vocabulary means the same thing as how hard the amp
     is being pushed: none of these words describes a sound anybody makes on a clean channel. */
  [/\b(riff|riffs|chug|chugging|shred|breakdown|palm-muted)\b/, { drive: 0.5, density: 0.15 }],
  /* A stab is an articulation, not a timbre: short, accented, more events per bar and a harder
     attack. It reaches `drive` only a little, which is what keeps "brass stabs" from arriving
     as a fuzz box. */
  [/\b(stab|stabs|stabbing|punchy|marcato)\b/, { density: 0.2, drive: 0.15 }],
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
  guitar: 'guitar',
  guitars: 'guitar',
  riff: 'riff',
  organ: 'organ',
  brass: 'brass',
  horns: 'brass',
  /* "no piano" is far likelier to be typed than "no epiano", and there is only one piano in
     the table for it to mean. */
  piano: 'epiano',
  epiano: 'epiano',
};

/** Read a prompt into the knobs the composer respects. */
export function knobsFor(prompt: string): Knobs {
  const text = prompt.toLowerCase();
  let density = 0;
  let brightness = 0;
  let tempo = 0;
  let drive = 0;

  for (const [pattern, effect] of WORDS) {
    if (!pattern.test(text)) continue;
    density += effect.density ?? 0;
    brightness += effect.brightness ?? 0;
    tempo += effect.tempo ?? 0;
    drive += effect.drive ?? 0;
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
    /* One-sided: there is no such thing as negative saturation, and a clean voice is the
       floor rather than the middle. */
    drive: Math.max(0, Math.min(1, drive)),
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
  /**
   * The model's own one-line description of this part.
   *
   * Shown while the lane's audio is being built, in place of the fixed sentence in
   * `LANE_MESSAGE`. It costs nothing — the caption is already in the score — and it is
   * the one moment where the screen can answer "is this what I asked for" before the
   * first note exists. Absent on a seeded lane, which is why the table stays.
   */
  readonly caption?: string;
  /**
   * The `lane` block that produced it, verbatim.
   *
   * Kept for two reasons and neither is display: it is what the next request shows the
   * model so an added lane answers what is already playing, and it is what a reload
   * restores from. See `lib/score.ts`.
   */
  readonly score?: string;
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
  /** Who wrote the notes. The screen says so, rather than letting the user assume. */
  readonly composedBy: 'model' | 'seed';
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
 * Chosen by the lane-independent track seed, so every lane agrees about the harmony.
 * Degrees rather than chord names because a degree is what {@link degreeToMidi} takes,
 * and because naming them would imply a theory of voicing this does not have.
 *
 * Six per mode rather than two. Two was the single biggest reason every take sounded like
 * the last one: the progression is the thing a listener remembers, and a screen with four
 * of them in total was a screen with four songs. The pedal entries (`0,0,3,0`) are here on
 * purpose — a loop that mostly refuses to move is a real kind of music and the old table
 * could not express it at all.
 */
export function progression(key: Key, seed: number, bars: number): readonly number[] {
  const options: readonly (readonly number[])[] = key.minor
    ? [
        [0, 5, 3, 4], // i – VI – iv – v, the one everything else is measured against
        [0, 3, 5, 4], // i – iv – VI – v
        [0, 6, 5, 4], // i – VII – VI – v, the descent
        [0, 4, 5, 3], // i – v – VI – iv
        [0, 0, 3, 0], // a pedal that leans out once
        [5, 3, 0, 0], // starts away from home and arrives at it
      ]
    : [
        [0, 3, 4, 3], // I – IV – V – IV
        [0, 5, 3, 4], // I – vi – IV – V
        [0, 4, 5, 3], // I – V – vi – IV
        [0, 3, 0, 4],
        [0, 0, 4, 0], // a pedal that leaves home for one bar
        [3, 4, 0, 0],
      ];
  const chosen = options[seed % options.length] ?? [0, 5, 3, 4];
  return Array.from({ length: bars }, (_, bar) => chosen[bar % chosen.length] ?? 0);
}

/**
 * GM percussion notes, so the MIDI export lands on the right pads in any DAW.
 *
 * `tom` is 45, GM's low tom. It is here because the kit had nothing between a kick and a
 * snare: no pitched membrane, so no marching toms, no fills with any weight in them, and a
 * "heavy" arrangement had exactly one voice below 200 Hz.
 */
export const DRUM = { kick: 36, rim: 37, snare: 38, clap: 39, hatClosed: 42, tom: 45, hatOpen: 46 } as const;

/** Everything a pattern generator needs that is not the lane itself. */
interface Bed {
  readonly key: Key;
  readonly chords: readonly number[];
  readonly steps: number;
  readonly knobs: Knobs;
  /**
   * Octaves to move the whole arrangement by. Never positive — see {@link register}.
   *
   * On the bed rather than on the lane, because a register is a property of the *track*:
   * a bass an octave down under a lead that stayed put is not a darker piece of music,
   * it is a hole in the middle of one.
   */
  readonly octaves: number;
}

/**
 * How far below its palette register a track sits.
 *
 * "Too high" was half of one complaint and it was a fair one: every lane took its
 * register from a fixed number in {@link LANES}, so every take of every palette put the
 * lead in octave 5 whatever the words said. Dark words now move the whole arrangement
 * down an octave, and a brief that says nothing either way tosses a seeded coin — because
 * a screen where every track lands in the same octave sounds like one track.
 *
 * Never up. The tables are written at the top of each lane's usable range: `bells` at 6 is
 * already near the top of what `fm` renders as a bell rather than as a whistle.
 */
export function register(knobs: Knobs): number {
  /* Aggression lives low. This is the other half of "it still sounds like a children's
     song": heavy music is not a bright arrangement with distortion on it, it is the same
     arrangement an octave down, and the drive knob is the only thing that knows. */
  if (knobs.drive >= 0.5) return -1;
  if (knobs.brightness <= -0.2) return -1;
  if (knobs.brightness >= 0.25) return 0;
  return (knobs.seed >> 7) % 3 === 0 ? -1 : 0;
}

/**
 * The octave a lane actually plays in, after the track's register shift.
 *
 * Exported because a model-composed lane needs exactly the same arithmetic: the model writes
 * *degrees* in a lane's own register, so shifting the register moves the whole part and leaves
 * everything it wrote about the music intact. Clamped at 1 so a shifted bass or drone stays a
 * pitch rather than becoming a rumble under the speaker.
 */
export function laneOctave(spec: LaneSpec, octaves: number): number {
  return Math.max(1, spec.octave + octaves);
}

/** The octave a lane actually plays in. */
function octaveOf(spec: LaneSpec, bed: Bed): number {
  return laneOctave(spec, bed.octaves);
}

/**
 * The grooves the kit chooses between, written the way `scoreline` writes a bar.
 *
 * One character per sixteenth — `X` accent, `x` normal, `.` rest — so a groove is legible
 * as the thing it plays rather than as a set of modulo conditions. That is the other half
 * of the monotony complaint: there used to be exactly one grid (kick on 1 and 11, snare on
 * 5 and 13, hats on every other step), so every drummed take in the application played the
 * same beat at a different tempo.
 */
const GROOVES: readonly { readonly kick: string; readonly snare: string; readonly hat: string }[] = [
  { kick: 'X.....x..X......', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' }, // straight eights
  { kick: 'X.......X.......', snare: '........X.......', hat: '..x...x...x...x.' }, // half-time
  { kick: 'X...X...X...X...', snare: '....x.......x...', hat: '..x...x...x...x.' }, // four on the floor
  { kick: 'X.....x...x.....', snare: '....X.....X.X...', hat: 'x.xxx.x.x.xxx.x.' }, // broken
  { kick: 'X...............', snare: '................', hat: '....x.......x...' }, // one hit and air
  { kick: 'X..x....X.x.....', snare: '....X.......X..x', hat: 'x..x..x.x..x..x.' }, // shuffled
];

/** The velocity a groove character asks for, or nothing if it is a rest. */
function grooveGain(symbol: string | undefined, accent: number, normal: number): number | null {
  if (symbol === 'X') return accent;
  if (symbol === 'x') return normal;
  return null;
}

/**
 * A drum grid: one of {@link GROOVES}, varied by phrase.
 *
 * Two kinds of variation, and both of them are the arrangement rather than noise: hats
 * thin out or fill in with the density knob, and the last bar of every four-bar phrase can
 * take a fill — which is exactly where a listener expects the loop to acknowledge that it
 * is about to come round.
 */
function kitPattern(bed: Bed, random: () => number, sparse: boolean): LoopNote[] {
  const notes: LoopNote[] = [];
  const bars = bed.steps / STEPS_PER_BAR;

  if (sparse) {
    /* A colour lane: off the strong beats on purpose, so it reads as decoration rather
       than as a second kit fighting the first. */
    const spot = [2, 6, 10, 14][Math.floor(random() * 4)] ?? 6;
    const take = 0.55 + bed.knobs.density * 0.3;
    for (let step = 0; step < bed.steps; step++) {
      const inBar = step % STEPS_PER_BAR;
      if (inBar !== spot && inBar !== (spot + 8) % STEPS_PER_BAR) continue;
      if (random() > take) continue;
      notes.push({
        step,
        midi: random() > 0.6 ? DRUM.rim : DRUM.clap,
        gain: velocity(0.35 + random() * 0.2),
        length: 1,
      });
    }
    /* Never nothing: a lane the user can see and cannot hear is worse than a lane that
       plays once. */
    if (notes.length === 0) notes.push({ step: spot, midi: DRUM.rim, gain: velocity(0.4), length: 1 });
    return notes;
  }

  /* A driven brief does not get the half-time or the one-hit-and-air groove: "militant" and
     "a kick every four bars" are answers to different requests, and the seeded composer
     landing on the second one is how an aggressive prompt came back as ambience. */
  const choices = bed.knobs.drive > 0.4 ? GROOVES.filter((_, index) => index !== 1 && index !== 4) : GROOVES;
  const groove = choices[Math.floor(random() * choices.length)] ?? (GROOVES[0] as (typeof GROOVES)[number]);
  const hats = 0.6 + bed.knobs.density * 0.35;

  for (let bar = 0; bar < bars; bar++) {
    const last = bar === bars - 1;
    const fill = (last || bar % 4 === 3) && random() < 0.45 + bed.knobs.density * 0.35;
    for (let inBar = 0; inBar < STEPS_PER_BAR; inBar++) {
      const step = bar * STEPS_PER_BAR + inBar;

      const kick = grooveGain(groove.kick[inBar], 0.95, 0.72);
      if (kick !== null) notes.push({ step, midi: DRUM.kick, gain: velocity(kick), length: 2 });

      const snare = grooveGain(groove.snare[inBar], 0.8, 0.55);
      if (snare !== null) notes.push({ step, midi: DRUM.snare, gain: velocity(snare), length: 2 });

      const hat = grooveGain(groove.hat[inBar], 0.55, 0.35);
      if (hat !== null && random() < hats) {
        /* The open hat lands on the last eighth of the loop, where it is the pickup into
           bar 1 rather than a random splash. */
        const open = last && inBar === 14;
        notes.push({
          step,
          midi: open ? DRUM.hatOpen : DRUM.hatClosed,
          gain: velocity(hat),
          length: open ? 2 : 1,
        });
      }

      /* The fill. Toms when the brief is driven — a march announces its own turnaround with
         the low drums, and a snare roll in the same place is a different genre. */
      if (fill && inBar >= 12 && inBar % 2 === 0) {
        notes.push({
          step,
          midi: bed.knobs.drive > 0.4 ? DRUM.tom : DRUM.snare,
          gain: velocity(0.45 + inBar * 0.02),
          length: 1,
        });
      }
    }
  }
  return notes;
}

/**
 * The three things a bass line can be, chosen per lane.
 *
 * `pedal` is the one the old generator could not write, and it is the one an ambient
 * brief wants: the root, held, and nothing else asking for attention.
 */
const BASS_FEELS = ['walking', 'octaves', 'pedal'] as const;

/** Root on the downbeat, then whatever the feel and the density ask for. */
function bassPattern(spec: LaneSpec, bed: Bed, random: () => number): LoopNote[] {
  const notes: LoopNote[] = [];
  const octave = octaveOf(spec, bed);
  const feel = BASS_FEELS[Math.floor(random() * BASS_FEELS.length)] ?? 'walking';
  /* Eighths, or quarters when the brief is calm — the note *rate* is most of what makes
     a bass line feel busy, and it used to be fixed at eighths for every track. */
  const grid = feel === 'pedal' || bed.knobs.density < -0.25 ? 4 : 2;

  for (let step = 0; step < bed.steps; step += grid) {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const inBar = step % STEPS_PER_BAR;
    const root = bed.chords[bar % bed.chords.length] ?? 0;
    if (inBar === 0) {
      notes.push({
        step,
        midi: degreeToMidi(bed.key, root, octave),
        gain: velocity(0.85),
        length: feel === 'pedal' ? STEPS_PER_BAR : 4,
      });
      continue;
    }
    if (feel === 'pedal') continue;
    if (random() > 0.32 + bed.knobs.density * 0.28) continue;
    /* Fifth and octave only. A passing tone from a random walk is what makes a
       generated bass line sound generated. */
    const degree = root + (feel === 'octaves' ? 7 : random() < 0.65 ? 4 : 7);
    notes.push({
      step,
      midi: degreeToMidi(bed.key, degree, octave),
      gain: velocity(0.5 + random() * 0.2),
      length: 2,
    });
  }
  return notes;
}

/**
 * Chord voicings, as intervals in scale degrees.
 *
 * A triad is not the only chord: the open fifth is the sound of "less", and the added
 * seventh is most of the difference between a game menu and something sadder. Picked per
 * lane rather than per track, so `chords` and `keys` in the same track voice differently.
 */
const VOICINGS: readonly (readonly number[])[] = [
  [0, 2, 4], // the triad
  [0, 4], // open fifth
  [0, 2, 4, 6], // added seventh
  [0, 4, 7], // root, fifth, octave — a shell
  [2, 4, 6], // rootless, sitting above the bass
];

/** A voicing per bar, on one of a few rhythms. */
function chordPattern(spec: LaneSpec, bed: Bed, random: () => number): LoopNote[] {
  const notes: LoopNote[] = [];
  const bars = bed.steps / STEPS_PER_BAR;
  const octave = octaveOf(spec, bed);
  const voicing = VOICINGS[Math.floor(random() * VOICINGS.length)] ?? [0, 2, 4];
  /* Where in the bar the chord is pushed again, if at all. `[0, 6]` is the dotted push
     that stops a chord lane from sounding like a metronome holding a triad. */
  const rhythm = [[0], [0, 8], [0, 6], [0, 6, 12]][Math.floor(random() * 4)] ?? [0];

  for (let bar = 0; bar < bars; bar++) {
    const root = bed.chords[bar % bed.chords.length] ?? 0;
    const hits = rhythm.filter((offset) => offset === 0 || random() < 0.55 + bed.knobs.density * 0.3);
    for (const offset of hits) {
      for (const interval of voicing) {
        notes.push({
          step: bar * STEPS_PER_BAR + offset,
          midi: degreeToMidi(bed.key, root + interval, octave),
          gain: velocity((offset === 0 ? 0.7 : 0.5) - interval * 0.03),
          length: offset === 0 ? (hits.length === 1 ? 8 : 6) : 4,
        });
      }
    }
  }
  return notes;
}

/**
 * The figures an arp lane walks.
 *
 * One shape — up the triad, past the octave and back — was the whole vocabulary, and a
 * lead lane uses this generator too, so *every melody in the application traced the same
 * curve*. These six do not make it a composer; they make it stop being one phrase.
 */
const ARP_SHAPES: readonly (readonly number[])[] = [
  [0, 2, 4, 2, 7, 4, 2, 0], // up and back
  [0, 4, 2, 7, 4, 9, 7, 4], // climbing
  [7, 4, 2, 0, 2, 4, 2, 0], // falling in
  [0, 7, 2, 9, 4, 7, 2, 0], // wide
  [0, 2, 0, 4, 0, 2, 4, 2], // a pedal on the root
  [0, -3, 2, 0, 4, 2, -1, 0], // reaching under the chord
];

/** Chord tones walked on a chosen grid, with rests where the density says to breathe. */
function arpPattern(spec: LaneSpec, bed: Bed, random: () => number): LoopNote[] {
  const notes: LoopNote[] = [];
  const octave = octaveOf(spec, bed);
  const shape = ARP_SHAPES[Math.floor(random() * ARP_SHAPES.length)] ?? ARP_SHAPES[0] ?? [0, 2, 4];
  /* Sixteenths only when the brief asked to be busy, quarters when it asked for space.
     A melody at a fixed eighth-note rate is the definition of monotonous. */
  const grid = bed.knobs.density > 0.35 ? 1 : bed.knobs.density < -0.25 ? 4 : 2;
  const rest = 0.28 - bed.knobs.density * 0.2;
  /* Which bars the part plays at all. A lane that enters late gives the loop a shape;
     one that plays everywhere gives it none. */
  const enter = random() < 0.35 ? Math.floor(bed.steps / STEPS_PER_BAR / 2) : 0;

  for (let step = enter * STEPS_PER_BAR, index = 0; step < bed.steps; step += grid, index++) {
    if (random() < rest) continue;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const root = bed.chords[bar % bed.chords.length] ?? 0;
    const degree = root + (shape[index % shape.length] ?? 0);
    notes.push({
      step,
      midi: degreeToMidi(bed.key, degree, octave),
      gain: velocity(0.45 + random() * 0.25),
      length: Math.max(2, grid),
    });
  }
  /* An entry so late the rests ate the whole part still has to sound. */
  if (notes.length === 0) {
    notes.push({
      step: 0,
      midi: degreeToMidi(bed.key, bed.chords[0] ?? 0, octave),
      gain: velocity(0.5),
      length: 4,
    });
  }
  return notes;
}

/** One held chord per two bars — the thing a listener hears as "the pad". */
function padPattern(spec: LaneSpec, bed: Bed, random: () => number): LoopNote[] {
  const notes: LoopNote[] = [];
  const octave = octaveOf(spec, bed);
  const span = STEPS_PER_BAR * 2;
  /**
   * Whether the harmony under the pad moves every two bars or every four.
   *
   * The *retrigger* rate stays at two bars either way, and that is the point: a voice is
   * clamped to `MAX_VOICE_MS`, so writing a four-bar note at 66 bpm would buy ten seconds
   * of silence in the middle of the bed. Stillness is the chord not changing, not the pad
   * not sounding.
   */
  const slow = bed.knobs.density < -0.2 || random() < 0.3;
  for (let step = 0; step < bed.steps; step += span) {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const root = bed.chords[(slow ? Math.floor(bar / 4) * 4 : bar) % bed.chords.length] ?? 0;
    /* A drone holds the root alone; anything else takes a voicing, and the open fifth
       when the prompt asked for sparse — an open fifth is the sound of "less". */
    const intervals = octave <= 1 ? [0] : bed.knobs.density < -0.2 ? [0, 4] : random() < 0.35 ? [0, 2, 4, 6] : [0, 2, 4];
    for (const interval of intervals) {
      notes.push({
        step,
        midi: degreeToMidi(bed.key, root + interval, octave),
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
  const octave = octaveOf(spec, bed);
  for (let i = 0; i < count; i++) {
    const bar = Math.floor(random() * (bed.steps / STEPS_PER_BAR));
    notes.push({
      step: bar * STEPS_PER_BAR,
      midi: degreeToMidi(bed.key, bed.chords[bar % bed.chords.length] ?? 0, octave),
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
    octaves: register(knobs),
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
    composedBy: 'seed' as const,
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
