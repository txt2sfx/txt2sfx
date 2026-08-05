/**
 * Reference comparison: decode, align, and measure.
 *
 * ## Why alignment and normalization are not options a purist would skip
 *
 * A recorded reference starts when the recorder was rolling, not when the sound
 * happens — the pop in the sample this was built against sits 125 ms into the
 * file, behind a quiet pre-roll. A candidate render starts at zero. Subtracting
 * those two as they are produces a difference picture of the *offset*, which
 * tells you nothing about the sound. Same for level: a reference peaking at 0.97
 * against a render peaking at 0.79 differs by 1.8 dB everywhere, and that
 * constant swamps the spectral differences that matter.
 *
 * So the default is: align the transients, normalize the peaks, then compare.
 * Both are switchable, because once the two do match you want to see the
 * remaining level and timing error rather than have it hidden.
 *
 * @packageDocumentation
 */

import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { spectrumAt } from './fft.js';

/** Mono samples at a known rate. */
export interface Signal {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

/** A loaded reference. */
export interface Reference {
  readonly name: string;
  readonly buffer: AudioBuffer;
}

/**
 * Decode any audio file the browser can read, at the project's sample rate.
 *
 * Decoding inside an `OfflineAudioContext` created at `GLOBAL_LIMITS.sampleRate`
 * makes the platform resample for us, so a 48 kHz reference and a 44.1 kHz render
 * share a bin grid and can be diffed bin for bin.
 */
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const bytes = await file.arrayBuffer();
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: 1,
    sampleRate: GLOBAL_LIMITS.sampleRate,
  });
  return ctx.decodeAudioData(bytes);
}

/** First channel of a buffer as a plain array. */
export function signalOf(buffer: AudioBuffer): Signal {
  return { samples: buffer.getChannelData(0), sampleRate: buffer.sampleRate };
}

/** Largest absolute sample. */
export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (const value of samples) {
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
  }
  return peak;
}

/** RMS in frames of `frameMs`, as linear amplitude. */
function rmsFrames(samples: Float32Array, sampleRate: number, frameMs: number): Float64Array {
  const size = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const count = Math.max(1, Math.floor(samples.length / size));
  const out = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    let sum = 0;
    for (let i = 0; i < size; i++) {
      const value = samples[f * size + i] ?? 0;
      sum += value * value;
    }
    out[f] = Math.sqrt(sum / size);
  }
  return out;
}

/**
 * Index of the sound's onset.
 *
 * Found as the steepest rise in the 1 ms RMS envelope, then refined back to the
 * first sample of that transient's foot. Steepest-rise rather than
 * first-above-threshold on purpose: a threshold picks up the reference's quiet
 * pre-roll and aligns the two sounds by their room noise.
 *
 * The search includes frame 0, measured against the silence before the signal.
 * A render whose layers all carry `attack 0ms` starts at full amplitude and has
 * no positive rise anywhere — every frame is quieter than the one before — so a
 * search starting at frame 1 finds its best rise of zero somewhere in the
 * trailing pad and puts the onset after the sound has finished.
 */
export function onsetIndex(signal: Signal): number {
  const frameMs = 1;
  const frameSize = Math.max(1, Math.round((frameMs / 1000) * signal.sampleRate));
  const rms = rmsFrames(signal.samples, signal.sampleRate, frameMs);
  if (rms.length < 2) return 0;

  let bestRise = -Infinity;
  let bestFrame = 0;
  for (let f = 0; f < rms.length; f++) {
    const rise = (rms[f] ?? 0) - (f === 0 ? 0 : (rms[f - 1] ?? 0));
    if (rise > bestRise) {
      bestRise = rise;
      bestFrame = f;
    }
  }

  /* Walk back to the foot: the last frame before the rise that is still quiet. */
  const target = (rms[bestFrame] ?? 0) * 0.2;
  let foot = bestFrame;
  while (foot > 0 && (rms[foot - 1] ?? 0) > target) foot--;

  /* Refine inside that frame to the first sample that actually moves. */
  const gate = peakOf(signal.samples) * 0.02;
  const from = Math.max(0, (foot - 1) * frameSize);
  const to = Math.min(signal.samples.length, (foot + 1) * frameSize);
  for (let i = from; i < to; i++) {
    if (Math.abs(signal.samples[i] ?? 0) >= gate) return i;
  }
  return from;
}

/** How the two signals are prepared before they are drawn or subtracted. */
export interface PrepareOptions {
  readonly align: boolean;
  readonly normalize: boolean;
}

/** Two signals on one common, equal-length time base. */
export interface AlignedPair {
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly sampleRate: number;
  /** Length of the common window, in milliseconds. */
  readonly windowMs: number;
  /** Where the onset sits inside the window, in milliseconds. */
  readonly onsetMs: number;
  /** Onsets found in the originals, for display. */
  readonly foundOnsetMsA: number;
  readonly foundOnsetMsB: number;
}

/** Silence kept before the aligned onset, so the attack has somewhere to sit. */
const PRE_ROLL_MS = 5;

/** Copy `count` samples starting at `from`, zero-padding out of range. */
function slicePadded(samples: Float32Array, from: number, count: number, scale: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const src = from + i;
    out[i] = src >= 0 && src < samples.length ? (samples[src] ?? 0) * scale : 0;
  }
  return out;
}

/** Put two signals on one time base, optionally aligned and peak-matched. */
export function alignPair(a: Signal, b: Signal, options: PrepareOptions): AlignedPair {
  const sampleRate = a.sampleRate;
  const onsetA = options.align ? onsetIndex(a) : 0;
  const onsetB = options.align ? onsetIndex(b) : 0;
  const pre = Math.round((PRE_ROLL_MS / 1000) * sampleRate);

  const tailA = a.samples.length - onsetA;
  const tailB = b.samples.length - onsetB;
  const count = pre + Math.max(tailA, tailB);

  const peakA = peakOf(a.samples) || 1;
  const peakB = peakOf(b.samples) || 1;
  const scaleA = options.normalize ? 0.95 / peakA : 1;
  const scaleB = options.normalize ? 0.95 / peakB : 1;

  return {
    a: slicePadded(a.samples, onsetA - pre, count, scaleA),
    b: slicePadded(b.samples, onsetB - pre, count, scaleB),
    sampleRate,
    windowMs: (count / sampleRate) * 1000,
    onsetMs: PRE_ROLL_MS,
    foundOnsetMsA: (onsetA / a.sampleRate) * 1000,
    foundOnsetMsB: (onsetB / b.sampleRate) * 1000,
  };
}

/**
 * Trim a pair to a shorter window.
 *
 * A recorded reference usually outlives the candidate by its room tail, and the
 * shared axis then squeezes the part under scrutiny — the first 40 ms — into a
 * sliver at the left. Clipping is a view concern, so it happens after alignment
 * rather than by measuring less.
 */
export function clipPair(pair: AlignedPair, windowMs: number): AlignedPair {
  const count = Math.min(pair.a.length, Math.max(1, Math.round((windowMs / 1000) * pair.sampleRate)));
  if (count >= pair.a.length) return pair;
  return {
    ...pair,
    a: pair.a.slice(0, count),
    b: pair.b.slice(0, count),
    windowMs: (count / pair.sampleRate) * 1000,
  };
}

/** Sample-wise difference of an aligned pair. */
export function differenceOf(pair: AlignedPair): Float32Array {
  const out = new Float32Array(pair.a.length);
  for (let i = 0; i < out.length; i++) out[i] = (pair.a[i] ?? 0) - (pair.b[i] ?? 0);
  return out;
}

/* ------------------------------------------------------------------------- *
 * Point measurements
 * ------------------------------------------------------------------------- */

/** Band edges of the summary, in Hz. */
const BAND_EDGES = [60, 250, 800, 2000, 6000] as const;

/** Human labels for {@link Metrics.bandsDb}. */
export const BAND_LABELS = ['60–250', '250–800', '0.8–2k', '2–6k', '6k+'] as const;

/** The numbers worth putting next to the pictures. */
export interface Metrics {
  readonly peak: number;
  /** Length from onset down to -60 dB of the RMS peak, in milliseconds. */
  readonly durationMs: number;
  /** Onset to RMS peak, in milliseconds. */
  readonly attackMs: number;
  /** Loudest partial in a short window at the onset, in Hz. */
  readonly dominantHz: number;
  /** Spectral centroid in the same window, in Hz. */
  readonly centroidHz: number;
  /** Share of energy per band, in dB below the frame total. */
  readonly bandsDb: readonly number[];
  /** Spectral flatness: 0 is a pure tone, 1 is white noise. */
  readonly flatness: number;
  /** Peak-hold level at onset + 0/5/10/15/20/25 ms, in dB below the first. */
  readonly decayDb: readonly number[];
}

/** Window for the point measurements: 512 samples ≈ 12 ms. Short on purpose. */
const POINT_FFT = 512;

/** Measure one signal, treating `onset` as t = 0. */
export function metricsOf(signal: Signal, onset = onsetIndex(signal)): Metrics {
  const { samples, sampleRate } = signal;
  const binHz = sampleRate / POINT_FFT;
  const mags = spectrumAt(samples, onset, POINT_FFT);

  let dominantBin = 1;
  let weighted = 0;
  let total = 0;
  let logSum = 0;
  let count = 0;
  for (let i = 1; i < mags.length; i++) {
    const m = mags[i] ?? 0;
    if (m > (mags[dominantBin] ?? 0)) dominantBin = i;
    weighted += i * binHz * m;
    total += m;
    logSum += Math.log(Math.max(m, 1e-12));
    count++;
  }

  const bandsDb = BAND_EDGES.map((low, index) => {
    const high = BAND_EDGES[index + 1] ?? sampleRate / 2;
    let sum = 0;
    for (let i = Math.ceil(low / binHz); i < Math.min(mags.length, high / binHz); i++) sum += mags[i] ?? 0;
    return 20 * Math.log10(Math.max(sum / (total || 1e-12), 1e-6));
  });

  const rms = rmsFrames(samples, sampleRate, 1);
  const onsetFrame = Math.floor(onset / Math.max(1, Math.round(sampleRate / 1000)));
  let peakFrame = onsetFrame;
  for (let f = onsetFrame; f < rms.length; f++) if ((rms[f] ?? 0) > (rms[peakFrame] ?? 0)) peakFrame = f;
  const floor = (rms[peakFrame] ?? 0) * 0.001;
  let endFrame = rms.length;
  while (endFrame > peakFrame && (rms[endFrame - 1] ?? 0) < floor) endFrame--;

  const step = Math.round(0.005 * sampleRate);
  const holds: number[] = [];
  for (let k = 0; k < 6; k++) {
    let hold = 0;
    for (let i = onset + k * step; i < Math.min(samples.length, onset + (k + 1) * step); i++) {
      const abs = Math.abs(samples[i] ?? 0);
      if (abs > hold) hold = abs;
    }
    holds.push(hold);
  }
  const first = holds[0] ?? 1e-6;
  const decayDb = holds.map((h) => 20 * Math.log10(Math.max(h, 1e-6) / Math.max(first, 1e-6)));

  return {
    peak: peakOf(samples),
    durationMs: Math.max(0, endFrame - onsetFrame),
    attackMs: Math.max(0, peakFrame - onsetFrame),
    dominantHz: dominantBin * binHz,
    centroidHz: total === 0 ? 0 : weighted / total,
    bandsDb,
    flatness: count === 0 ? 0 : Math.exp(logSum / count) / (total / count || 1e-12),
    decayDb,
  };
}

/** Metrics rendered as a markdown table — the form a language model reads best. */
export function metricsMarkdown(
  candidateName: string,
  referenceName: string,
  candidate: Metrics,
  reference: Metrics,
): string {
  const n = (value: number, digits = 0): string => value.toFixed(digits);
  const rows: readonly (readonly [string, string, string])[] = [
    ['peak', n(candidate.peak, 3), n(reference.peak, 3)],
    ['duration to -60 dB, ms', n(candidate.durationMs), n(reference.durationMs)],
    ['attack to peak, ms', n(candidate.attackMs), n(reference.attackMs)],
    ['dominant partial, Hz', n(candidate.dominantHz), n(reference.dominantHz)],
    ['centroid, Hz', n(candidate.centroidHz), n(reference.centroidHz)],
    ['flatness (0 tone, 1 noise)', n(candidate.flatness, 4), n(reference.flatness, 4)],
    ...BAND_LABELS.map(
      (label, i) =>
        [`band ${label}, dB`, n(candidate.bandsDb[i] ?? 0, 1), n(reference.bandsDb[i] ?? 0, 1)] as const,
    ),
    [
      'decay 0/5/10/15/20/25 ms, dB',
      candidate.decayDb.map((d) => n(d, 1)).join(' / '),
      reference.decayDb.map((d) => n(d, 1)).join(' / '),
    ],
  ];

  const head = `| metric | ${candidateName} (candidate) | ${referenceName} (reference) |\n| --- | --- | --- |`;
  const body = rows.map(([label, a, b]) => `| ${label} | ${a} | ${b} |`).join('\n');
  return `${head}\n${body}`;
}
