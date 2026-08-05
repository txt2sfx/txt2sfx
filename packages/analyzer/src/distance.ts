/**
 * How far one sound is from another.
 *
 * ## Two distances, because a profile is not a waveform
 *
 * The plan called for a single metric: weighted profile fields plus a
 * multi-resolution STFT loss. It is two functions here, and the reason is not
 * stylistic — an STFT loss cannot be computed from a {@link SoundProfile}. A
 * profile is ~100 numbers; the loss needs the audio. Meanwhile the recipe bank
 * stores profiles and nothing else, so retrieval has to be able to compare two
 * recipes without rendering either of them.
 *
 * So: {@link profileDistance} compares fingerprints, {@link stftDistance}
 * compares waveforms, and {@link soundDistance} is the fitness function the
 * optimizer wants — both, weighted. Each returns 0 for identical inputs and
 * roughly 1 for unrelated ones, which is what makes them addable.
 *
 * ## Alignment and normalization are not optional
 *
 * A reference recording starts when the recorder was rolling; a render starts at
 * sample zero. Subtracting those as they are measures the offset, not the sound.
 * A reference peaking at 0.98 against a render peaking at 0.79 differs by 1.8 dB
 * everywhere, and that constant swamps the spectral difference that matters. So
 * both comparisons align onsets and match peaks first. The level difference is
 * not thrown away — `loudnessLufsApprox` carries it as its own term, where it
 * can be weighted deliberately instead of contaminating everything.
 *
 * @packageDocumentation
 */

import type { SoundProfile } from '@txt2sfx/shared';
import { magnitudes, prevPow2 } from './fft.js';
import { SILENCE_LUFS, onsetIndex, peakOf, type Signal } from './profile.js';

/* ------------------------------------------------------------------------- *
 * Scalar helpers
 * ------------------------------------------------------------------------- */

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Distance between two positive quantities, in octaves, scaled so that a factor
 * of eight counts as maximally different.
 *
 * Ratios rather than differences because that is how hearing works: 200 Hz to
 * 400 Hz is the same interval as 2 kHz to 4 kHz, and a metric that called the
 * second one ten times worse would spend the optimizer's budget in the treble.
 */
const OCTAVE_SCALE = 3;

function ratioDistance(a: number, b: number): number {
  const left = Math.max(a, 1e-6);
  const right = Math.max(b, 1e-6);
  return clamp01(Math.abs(Math.log2(left / right)) / OCTAVE_SCALE);
}

/** Mean absolute difference of two equal-length series. */
function meanAbs(a: readonly number[], b: readonly number[], transform: (x: number, y: number) => number): number {
  const count = Math.min(a.length, b.length);
  if (count === 0) return 0;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += transform(a[i] as number, b[i] as number);
  return sum / count;
}

/* ------------------------------------------------------------------------- *
 * Profile distance
 * ------------------------------------------------------------------------- */

/** Contribution of each profile field to {@link profileDistance}. */
export interface ProfileWeights {
  readonly duration: number;
  readonly attack: number;
  readonly envelope: number;
  readonly centroid: number;
  readonly flatness: number;
  readonly noiseRatio: number;
  readonly peakHz: number;
  readonly loudness: number;
}

/**
 * Default field weights, summing to 1.
 *
 * The envelope and the centroid trajectory carry the most because they are the
 * two things a listener names first when a sound is wrong — "too long", "too
 * dull". `peakHz` is weighted heavily for its size: the difference between a
 * bubble pop and a dull thud in this project's own reference work was entirely a
 * dominant-partial difference, 97 Hz against 1055 Hz, while the envelopes nearly
 * matched. Loudness is weighted lightest: it is the one error a game engine
 * fixes for free.
 */
export const DEFAULT_PROFILE_WEIGHTS: ProfileWeights = {
  duration: 0.15,
  attack: 0.1,
  envelope: 0.2,
  centroid: 0.2,
  flatness: 0.05,
  noiseRatio: 0.05,
  peakHz: 0.2,
  loudness: 0.05,
};

/** Per-field breakdown, for diagnostics and for {@link humanReadableDiff}. */
export interface ProfileDistanceParts {
  readonly duration: number;
  readonly attack: number;
  readonly envelope: number;
  readonly centroid: number;
  readonly flatness: number;
  readonly noiseRatio: number;
  readonly peakHz: number;
  readonly loudness: number;
  /** Weighted sum of the fields above. */
  readonly total: number;
}

/** Field-by-field distance between two profiles, each term in 0..1. */
export function profileDistanceParts(
  a: SoundProfile,
  b: SoundProfile,
  weights: ProfileWeights = DEFAULT_PROFILE_WEIGHTS,
): ProfileDistanceParts {
  /* Attack is offset by 1 ms before the ratio: a 0 ms attack is legitimate and
     common (any click), and a ratio metric has no opinion about zero. */
  const parts = {
    duration: ratioDistance(a.durationMs, b.durationMs),
    attack: ratioDistance(a.attackMs + 1, b.attackMs + 1),
    envelope: clamp01(meanAbs(a.rmsEnvelope, b.rmsEnvelope, (x, y) => Math.abs(x - y))),
    centroid: meanAbs(a.centroidHz, b.centroidHz, ratioDistance),
    flatness: clamp01(Math.abs(a.flatness - b.flatness)),
    noiseRatio: clamp01(Math.abs(a.noiseRatio - b.noiseRatio)),
    peakHz: ratioDistance(a.peakHz, b.peakHz),
    loudness: clamp01(Math.abs(finiteLufs(a.loudnessLufsApprox) - finiteLufs(b.loudnessLufsApprox)) / 20),
  };

  const total =
    parts.duration * weights.duration +
    parts.attack * weights.attack +
    parts.envelope * weights.envelope +
    parts.centroid * weights.centroid +
    parts.flatness * weights.flatness +
    parts.noiseRatio * weights.noiseRatio +
    parts.peakHz * weights.peakHz +
    parts.loudness * weights.loudness;

  return { ...parts, total };
}

/**
 * Clamp a loudness to the bottom of the scale.
 *
 * `extractProfile` already floors silence at {@link SILENCE_LUFS}, so this only
 * fires for a profile that arrived from somewhere else — the recipe bank stores
 * client-supplied profiles, and one carrying `-Infinity` or a NaN would otherwise
 * turn every distance computed against it into NaN, which no comparison can
 * recover from.
 */
function finiteLufs(value: number): number {
  return Number.isFinite(value) ? Math.max(value, SILENCE_LUFS) : SILENCE_LUFS;
}

/** Weighted distance between two acoustic profiles, 0 for identical. */
export function profileDistance(
  a: SoundProfile,
  b: SoundProfile,
  weights: ProfileWeights = DEFAULT_PROFILE_WEIGHTS,
): number {
  return profileDistanceParts(a, b, weights).total;
}

/* ------------------------------------------------------------------------- *
 * Alignment
 * ------------------------------------------------------------------------- */

/** Two signals on one time base, onset-aligned and peak-matched. */
export interface AlignedPair {
  readonly a: Float64Array;
  readonly b: Float64Array;
  readonly sampleRate: number;
  /** Onsets found in the originals, in samples. */
  readonly onsetA: number;
  readonly onsetB: number;
}

/** Silence kept before the shared onset, so an attack has somewhere to sit. */
const PRE_ROLL_MS = 5;

function slicePadded(samples: ArrayLike<number>, from: number, count: number, scale: number): Float64Array {
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const index = from + i;
    out[i] = index >= 0 && index < samples.length ? (samples[index] ?? 0) * scale : 0;
  }
  return out;
}

/**
 * Put two signals on a common time base.
 *
 * Both are cut to the same length — the longer of the two tails — so every
 * frame index means the same instant in both, which is what lets the STFT loss
 * subtract them bin for bin. Sample rates must match: resampling belongs to
 * whoever decoded the reference, and doing it silently here would hide a
 * mismatched bin grid inside a number that looks fine.
 */
export function alignAndNormalize(a: Signal, b: Signal, normalize = true): AlignedPair {
  if (a.sampleRate !== b.sampleRate) {
    throw new RangeError(
      `alignAndNormalize: sample rates differ (${a.sampleRate} vs ${b.sampleRate}) — decode both at the same rate`,
    );
  }
  const onsetA = onsetIndex(a);
  const onsetB = onsetIndex(b);
  const pre = Math.round((PRE_ROLL_MS / 1000) * a.sampleRate);
  const count = pre + Math.max(a.samples.length - onsetA, b.samples.length - onsetB);

  const scaleA = normalize ? 0.95 / (peakOf(a.samples) || 1) : 1;
  const scaleB = normalize ? 0.95 / (peakOf(b.samples) || 1) : 1;

  return {
    a: slicePadded(a.samples, onsetA - pre, count, scaleA),
    b: slicePadded(b.samples, onsetB - pre, count, scaleB),
    sampleRate: a.sampleRate,
    onsetA,
    onsetB,
  };
}

/* ------------------------------------------------------------------------- *
 * Spectral distance
 * ------------------------------------------------------------------------- */

/**
 * Window sizes of the multi-resolution loss.
 *
 * Three resolutions because no single one can see everything: 256 samples (6 ms)
 * resolves a transient's timing but not its pitch, 4096 (93 ms) resolves the
 * pitch but smears the transient across the whole window, and 1024 sits between.
 * Summing the three is the standard trick from neural audio synthesis, and it is
 * the reason this loss does not reward a candidate that gets the spectrum right
 * at the wrong moment.
 */
export const STFT_SIZES: readonly number[] = [256, 1024, 4096];

/** Spectral difference counted as maximally wrong, in decibels. */
const DB_SCALE = 60;

/** Floor for log magnitudes, -120 dBFS. */
const MAG_FLOOR = 1e-6;

/**
 * Multi-resolution spectral distance between two signals.
 *
 * Two terms per frame, averaged, each already in 0..1:
 *
 * - **Log-magnitude L1.** A quiet difference matters as much as a loud one to a
 *   listener, and a squared linear loss would let a candidate ignore everything
 *   30 dB down — which is most of what makes a sound sound like a material.
 * - **Spectral convergence**, the energy-relative error. The log term alone is
 *   diluted by the bins where both signals sit on the floor, and in a sparse
 *   spectrum that is nearly every bin: a 1 kHz sine against a 1.4 kHz sine —
 *   nothing in common, obviously different to any listener — scored 0.046,
 *   because six bins disagreeing by 100 dB averaged out across 250 that agreed
 *   perfectly about silence. Normalizing by the energy actually present fixes
 *   that; the same pair scores about 0.5.
 *
 * Both terms are needed. Convergence alone is deaf to the quiet tail, the log
 * term alone is deaf to where the energy is.
 */
export function stftDistance(a: Signal, b: Signal, normalize = true): number {
  const pair = alignAndNormalize(a, b, normalize);
  const length = pair.a.length;
  let sum = 0;
  let sizes = 0;

  for (const requested of STFT_SIZES) {
    /* A window longer than the signal would compare two zero-padded blurs. */
    const size = Math.min(requested, prevPow2(length));
    if (size < 32) continue;
    const hop = size / 4;
    let frameSum = 0;
    let frames = 0;

    for (let start = 0; start + size <= length; start += hop) {
      const left = magnitudes(pair.a, start, size);
      const right = magnitudes(pair.b, start, size);
      let logSum = 0;
      let squaredError = 0;
      let energy = 0;

      for (let i = 1; i < left.length; i++) {
        const magA = left[i] as number;
        const magB = right[i] as number;
        const dbA = 20 * Math.log10(Math.max(magA, MAG_FLOOR));
        const dbB = 20 * Math.log10(Math.max(magB, MAG_FLOOR));
        logSum += Math.abs(dbA - dbB);
        squaredError += (magA - magB) ** 2;
        energy += magA * magA + magB * magB;
      }

      const bins = Math.max(1, left.length - 1);
      /* `(a - b)^2 <= a^2 + b^2` for non-negative magnitudes, so this ratio is
         already in 0..1: 0 when the frames match, 1 when one of them is empty. */
      const convergence = energy === 0 ? 0 : Math.sqrt(squaredError / energy);
      frameSum += (clamp01(logSum / bins / DB_SCALE) + convergence) / 2;
      frames++;
    }

    if (frames === 0) continue;
    sum += frameSum / frames;
    sizes++;
  }

  return sizes === 0 ? 0 : clamp01(sum / sizes);
}

/* ------------------------------------------------------------------------- *
 * Combined
 * ------------------------------------------------------------------------- */

/** How {@link soundDistance} splits its verdict. */
export interface SoundDistanceWeights {
  readonly profile: number;
  readonly spectral: number;
}

/**
 * An even split.
 *
 * The profile terms are interpretable and the STFT loss is not, but the STFT
 * loss sees things no profile field does — a missing partial, a filter one
 * octave off in the middle of the tail. Weighting either out would lose
 * something: the profile alone is fooled by a sound with the right statistics
 * and the wrong content, and the spectral loss alone gives an optimizer no
 * gradient it can explain.
 */
export const DEFAULT_SOUND_WEIGHTS: SoundDistanceWeights = { profile: 0.5, spectral: 0.5 };

/** The full metric: profile fields plus spectral loss. The optimizer's fitness. */
export function soundDistance(
  candidate: { readonly signal: Signal; readonly profile: SoundProfile },
  target: { readonly signal: Signal; readonly profile: SoundProfile },
  weights: SoundDistanceWeights = DEFAULT_SOUND_WEIGHTS,
): number {
  const profile = profileDistance(candidate.profile, target.profile);
  const spectral = stftDistance(candidate.signal, target.signal);
  return profile * weights.profile + spectral * weights.spectral;
}
