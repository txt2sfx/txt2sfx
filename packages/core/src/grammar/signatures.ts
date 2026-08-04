/**
 * Syntactic and physical contracts of every soundline primitive, effect and of
 * the envelope section.
 *
 * This table is the single source of truth for four consumers:
 *
 * 1. the lexer — the set of dimensionless parameter names that may be written
 *    glued to their value (`Q6`);
 * 2. the parser — which arguments exist, in which order, with which units;
 * 3. the serializer — canonical argument order, so round-tripping is stable;
 * 4. `packages/core/src/primitives/*` (phase 2) — each DSP builder imports its
 *    own signature instead of restating the parameter list.
 *
 * Keeping it here rather than inside the DSP modules means the grammar never
 * has to import audio code: `parse()` works in any JavaScript runtime, with or
 * without Web Audio.
 *
 * @packageDocumentation
 */

import type { ParamSpec, Signature } from '@txt2sfx/shared';

/* ------------------------------------------------------------------------- *
 * Primitives
 * ------------------------------------------------------------------------- */

/** Waveforms available to `tone`, `chirp` and the FM operators. */
export const WAVEFORMS = ['sine', 'tri', 'saw', 'square'] as const;

/** Noise colours: white is flat, pink is -3 dB/oct, brown is -6 dB/oct. */
export const NOISE_COLORS = ['white', 'pink', 'brown'] as const;

/** Modal material presets — each picks a default set of partial ratios. */
export const MODAL_MATERIALS = ['metal', 'wood', 'glass', 'membrane'] as const;

const TONE: Signature = {
  name: 'tone',
  kind: 'primitive',
  doc: 'Single oscillator. The tonal backbone of a layer: bodies, blips, hums.',
  params: [
    {
      name: 'wave',
      kind: 'enum',
      positional: true,
      required: true,
      values: WAVEFORMS,
      doc: 'Waveform. sine = pure body, tri = soft, saw/square = buzzy and retro.',
    },
    {
      name: 'freq',
      kind: 'freq',
      positional: true,
      required: true,
      rampable: true,
      min: 20,
      max: 18000,
      doc: 'Oscillator frequency; ramp it for pitch drops and rises.',
    },
  ],
};

const NOISE: Signature = {
  name: 'noise',
  kind: 'primitive',
  doc: 'Broadband noise source. The texture behind crunches, blasts and hiss.',
  params: [
    {
      name: 'color',
      kind: 'enum',
      positional: true,
      required: true,
      values: NOISE_COLORS,
      doc: 'Spectral tilt: white for air and grit, pink for material, brown for weight.',
    },
  ],
};

const CHIRP: Signature = {
  name: 'chirp',
  kind: 'primitive',
  doc: 'Fast frequency sweep. A tone that must move — lasers, zaps, whooshes.',
  params: [
    {
      name: 'wave',
      kind: 'enum',
      positional: true,
      values: WAVEFORMS,
      default: 'saw',
      doc: 'Waveform of the sweeping oscillator.',
    },
    {
      name: 'freq',
      kind: 'freq',
      positional: true,
      required: true,
      rampable: true,
      min: 20,
      max: 18000,
      doc: 'Start frequency; a chirp without a `->` ramp is just a tone.',
    },
  ],
};

const PLUCK: Signature = {
  name: 'pluck',
  kind: 'primitive',
  doc: 'Karplus-Strong plucked string: noise burst fed through a tuned delay.',
  params: [
    {
      name: 'freq',
      kind: 'freq',
      positional: true,
      required: true,
      min: 40,
      max: 8000,
      doc: 'Pitch of the string — the delay line is 1/freq seconds long.',
    },
    {
      name: 'damp',
      kind: 'ratio',
      default: 0.5,
      min: 0,
      max: 1,
      doc: 'Loop damping: 0 rings for a long time, 1 dies almost instantly.',
    },
    {
      name: 'bright',
      kind: 'ratio',
      default: 0.5,
      min: 0,
      max: 1,
      doc: 'Brightness of the initial excitation burst.',
    },
  ],
};

const MODAL: Signature = {
  name: 'modal',
  kind: 'primitive',
  doc: 'Bank of 2-5 inharmonic resonators. How metal, wood and glass ring.',
  params: [
    {
      name: 'material',
      kind: 'enum',
      positional: true,
      values: MODAL_MATERIALS,
      default: 'metal',
      doc: 'Preset partial ratios: metal 1:2.41:3.86, wood 1:2.57:4.94, glass 1:2.76:5.40, membrane 1:1.59:2.14.',
    },
    {
      name: 'freq',
      kind: 'freq',
      positional: true,
      required: true,
      min: 40,
      max: 12000,
      doc: 'Fundamental mode frequency; every partial is a multiple of it.',
    },
    {
      name: 'ratios',
      kind: 'list',
      doc: 'Explicit partial ratios, e.g. 1:2.41:3.86:5.12. Overrides the material preset.',
    },
    {
      name: 'Q',
      kind: 'ratio',
      default: 40,
      min: 1,
      max: 400,
      doc: 'Resonator sharpness: 20 is a dull knock, 200 a long metallic ring.',
    },
  ],
};

const FM: Signature = {
  name: 'fm',
  kind: 'primitive',
  doc: 'Two-operator FM pair. Cheap source of bells, sparkle and grit.',
  params: [
    {
      name: 'freq',
      kind: 'freq',
      positional: true,
      required: true,
      rampable: true,
      min: 20,
      max: 12000,
      doc: 'Carrier frequency.',
    },
    {
      name: 'ratio',
      kind: 'ratio',
      default: 2,
      min: 0.1,
      max: 24,
      doc: 'Modulator/carrier frequency ratio. Integers sound harmonic, fractions metallic.',
    },
    {
      name: 'index',
      kind: 'ratio',
      default: 3,
      rampable: true,
      min: 0,
      max: 40,
      doc: 'Modulation index (brightness). Ramp it down for a natural bell decay.',
    },
  ],
};

const SUB: Signature = {
  name: 'sub',
  kind: 'primitive',
  doc: 'Low-frequency body thump: a sine you feel rather than hear.',
  params: [
    {
      name: 'freq',
      kind: 'freq',
      positional: true,
      required: true,
      rampable: true,
      min: 18,
      max: 200,
      doc: 'Sub frequency; a downward ramp is what makes an impact land.',
    },
  ],
};

const CLICK: Signature = {
  name: 'click',
  kind: 'primitive',
  doc: 'Single impulse, 1-5 ms. Pure transient, no pitch of its own.',
  params: [
    {
      name: 'width',
      kind: 'time',
      positional: true,
      required: true,
      min: 0.2,
      max: 5,
      doc: 'Impulse width. Wider is duller; below 1 ms it is nearly a spectral flash.',
    },
  ],
};

/* ------------------------------------------------------------------------- *
 * Effects
 * ------------------------------------------------------------------------- */

const filterParams = (defaultQ: number, doc: string): readonly ParamSpec[] => [
  {
    name: 'freq',
    kind: 'freq',
    positional: true,
    required: true,
    rampable: true,
    min: 20,
    max: 20000,
    doc,
  },
  {
    name: 'Q',
    kind: 'ratio',
    default: defaultQ,
    min: 0.1,
    max: 40,
    doc: 'Resonance. Above ~10 the filter starts to sing at its cutoff.',
  },
];

const LP: Signature = {
  name: 'lp',
  kind: 'effect',
  doc: 'Low-pass biquad. Removes air; ramp it down to make a sound recede.',
  params: filterParams(0.7, 'Cutoff frequency; content above it is attenuated.'),
};

const HP: Signature = {
  name: 'hp',
  kind: 'effect',
  doc: 'High-pass biquad. Removes weight; the standard way to thin a transient.',
  params: filterParams(0.7, 'Cutoff frequency; content below it is attenuated.'),
};

const BP: Signature = {
  name: 'bp',
  kind: 'effect',
  doc: 'Band-pass biquad. Turns flat noise into a pitched-sounding snap.',
  params: filterParams(4, 'Centre frequency of the passband.'),
};

const DIST: Signature = {
  name: 'dist',
  kind: 'effect',
  doc: 'Waveshaper. Adds harmonics and glues transients; also raises loudness.',
  params: [
    {
      name: 'drive',
      kind: 'ratio',
      required: true,
      min: 0,
      max: 20,
      doc: 'Drive amount. 1 is gentle saturation, 10 is aggressive clipping.',
    },
    {
      name: 'mix',
      kind: 'ratio',
      default: 1,
      min: 0,
      max: 1,
      doc: 'Dry/wet blend.',
    },
  ],
};

const DELAY: Signature = {
  name: 'delay',
  kind: 'effect',
  doc: 'Feedback delay. With short times and high feedback it becomes a rhythmic or resonant texture.',
  params: [
    {
      name: 'time',
      kind: 'time',
      positional: true,
      required: true,
      min: 1,
      max: 1000,
      doc: 'Delay time. Below ~30 ms this reads as resonance, above as repeats.',
    },
    {
      name: 'feedback',
      kind: 'ratio',
      default: 0.3,
      min: 0,
      max: 0.95,
      doc: 'Fraction fed back. Capped below 1 so the layer cannot run away.',
    },
    {
      name: 'mix',
      kind: 'ratio',
      default: 0.3,
      min: 0,
      max: 1,
      doc: 'Dry/wet blend.',
    },
  ],
};

const VERB: Signature = {
  name: 'verb',
  kind: 'effect',
  doc: 'Short procedural reverb tail: a noise impulse response, decayed.',
  params: [
    {
      name: 'time',
      kind: 'time',
      positional: true,
      required: true,
      min: 10,
      max: 2000,
      doc: 'Tail length. Keep it short — long tails belong to the game engine, not the SFX.',
    },
    {
      name: 'mix',
      kind: 'ratio',
      default: 0.25,
      min: 0,
      max: 1,
      doc: 'Dry/wet blend.',
    },
    {
      name: 'damp',
      kind: 'ratio',
      default: 0.5,
      min: 0,
      max: 1,
      doc: 'High-frequency damping of the tail: 0 is a tiled room, 1 is a padded one.',
    },
  ],
};

/* ------------------------------------------------------------------------- *
 * Envelope
 * ------------------------------------------------------------------------- */

/**
 * The `| ...` section of a layer.
 *
 * `delay` lives here rather than in the source because it shifts the whole
 * voice in time, not the oscillator. Parameter order in this list is the
 * canonical serialization order.
 */
export const ENVELOPE: Signature = {
  name: 'envelope',
  kind: 'envelope',
  doc: 'Amplitude contour of the layer source: gain, attack, hold, decay, start delay.',
  params: [
    {
      name: 'gain',
      kind: 'level',
      default: 1,
      min: 0,
      max: 1,
      doc: 'Peak linear gain (or a negative dB value, e.g. -6dB).',
    },
    {
      name: 'attack',
      kind: 'time',
      default: 1,
      min: 0,
      max: 2000,
      doc: 'Rise time to peak. Keep it at 1-3 ms for anything percussive.',
    },
    {
      name: 'hold',
      kind: 'time',
      default: 0,
      min: 0,
      max: 3000,
      doc: 'Time held at peak before the decay starts.',
    },
    {
      name: 'decay',
      kind: 'time',
      required: true,
      min: 1,
      max: 3000,
      doc: 'Fall time from peak to silence. The single most audible number in a layer.',
    },
    {
      name: 'curve',
      kind: 'enum',
      values: ['exp', 'lin'],
      default: 'exp',
      doc: 'Decay shape. exp is how physical energy dissipates; lin sounds synthetic.',
    },
    {
      name: 'delay',
      kind: 'time',
      default: 0,
      min: 0,
      max: 3000,
      doc: 'Start offset of this layer relative to the sound onset.',
    },
  ],
};

/* ------------------------------------------------------------------------- *
 * Registry
 * ------------------------------------------------------------------------- */

/** All v0 primitives, keyed by the word that introduces a layer source. */
export const PRIMITIVES: Readonly<Record<string, Signature>> = {
  tone: TONE,
  noise: NOISE,
  chirp: CHIRP,
  pluck: PLUCK,
  modal: MODAL,
  fm: FM,
  sub: SUB,
  click: CLICK,
};

/** All v0 effects, keyed by the word that follows `>>`. */
export const EFFECTS: Readonly<Record<string, Signature>> = {
  lp: LP,
  hp: HP,
  bp: BP,
  dist: DIST,
  delay: DELAY,
  verb: VERB,
};

/** Primitive names in documentation order. */
export const PRIMITIVE_NAMES: readonly string[] = Object.keys(PRIMITIVES);

/** Effect names in documentation order. */
export const EFFECT_NAMES: readonly string[] = Object.keys(EFFECTS);

/**
 * Dimensionless parameter names that may be written glued to their value
 * (`Q6`, `gain0.8`) instead of separated by a space (`Q 6`).
 *
 * The set is closed and derived from the signatures above, which is what makes
 * the split unambiguous: a layer called `snap2` is left alone because `snap` is
 * not a dimensionless parameter name.
 */
export const GLUED_PARAM_NAMES: ReadonlySet<string> = new Set(
  [...Object.values(PRIMITIVES), ...Object.values(EFFECTS), ENVELOPE]
    .flatMap((sig) => sig.params)
    .filter((p) => p.kind === 'ratio' || p.kind === 'level')
    .map((p) => p.name),
);

/** Look up a primitive or effect signature by name. */
export function lookupSignature(name: string): Signature | undefined {
  return PRIMITIVES[name] ?? EFFECTS[name];
}
