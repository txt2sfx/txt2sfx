/**
 * Turning a rendered buffer into the compact fingerprint everything downstream
 * compares against: {@link SoundProfile}.
 *
 * ## One extractor, two kinds of input
 *
 * The same function measures a candidate render and a decoded reference
 * recording. That is the whole point — a distance between a synthesized sound
 * and a recorded one is only meaningful if both were measured the same way. It
 * is also why every measurement here is taken relative to the signal's own
 * onset rather than to sample zero: a recording starts when the recorder was
 * rolling, and in the project's own reference pop the sound sits 125 ms behind a
 * quiet pre-roll. Measuring from zero would report that silence as attack.
 *
 * ## Why the numbers are what they are
 *
 * `SoundProfile` is ~100 floats. It is small on purpose: it is stored per recipe
 * in the bank, sent to a language model as text, and evaluated a few hundred
 * thousand times by the optimizer. Anything richer would have to be recomputed
 * from audio every time, and anything smaller stops distinguishing a click from
 * a thump.
 *
 * @packageDocumentation
 */

import type { SoundProfile } from '@txt2sfx/shared';
import { dominantBin, magnitudes, prevPow2, refinePeakBin } from './fft.js';

/** Mono samples at a known rate — the analyzer's only input shape. */
export interface Signal {
  /** Accepts `Float32Array` from an `AudioBuffer`, `Float64Array`, or an array. */
  readonly samples: ArrayLike<number>;
  readonly sampleRate: number;
}

/** Points in {@link SoundProfile.rmsEnvelope}. */
export const ENVELOPE_POINTS = 64;

/** Points in {@link SoundProfile.centroidHz}. */
export const CENTROID_POINTS = 32;

/** Frame length of the RMS envelope used for onset, attack and duration, in ms. */
const RMS_FRAME_MS = 1;

/** -60 dBFS relative to the RMS peak: where a sound is declared over. */
const TAIL_FLOOR = 0.001;

/** Largest absolute sample. */
export function peakOf(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i] ?? 0);
    if (abs > peak) peak = abs;
  }
  return peak;
}

/** Root mean square of a range, zero-padded outside the signal. */
export function rmsOf(samples: ArrayLike<number>, from: number, to: number): number {
  const count = Math.max(1, to - from);
  let sum = 0;
  for (let i = from; i < to; i++) {
    const value = i >= 0 && i < samples.length ? (samples[i] ?? 0) : 0;
    sum += value * value;
  }
  return Math.sqrt(sum / count);
}

/** RMS in consecutive frames of `frameMs`, covering the whole signal. */
export function rmsFrames(signal: Signal, frameMs = RMS_FRAME_MS): Float64Array {
  const size = Math.max(1, Math.round((frameMs / 1000) * signal.sampleRate));
  const count = Math.max(1, Math.ceil(signal.samples.length / size));
  const out = new Float64Array(count);
  for (let f = 0; f < count; f++) out[f] = rmsOf(signal.samples, f * size, Math.min((f + 1) * size, signal.samples.length));
  return out;
}

/**
 * Index of the sound's onset.
 *
 * Found as the steepest rise in the 1 ms RMS envelope, then walked back to the
 * foot of that transient and refined to the first sample that actually moves.
 * Steepest-rise rather than first-above-threshold deliberately: a threshold
 * catches a recording's room noise and aligns two sounds by their pre-roll,
 * which produces a beautifully aligned picture of nothing.
 *
 * The search starts at frame 0 against an implicit silence before it, and that
 * detail is load-bearing. A sound written with `attack 0ms` — every click in the
 * reference recipes — begins at full amplitude on sample 0, so it contains no
 * positive rise anywhere: every later frame is quieter than the one before. A
 * search starting at frame 1 then finds its maximum rise of *zero* somewhere in
 * the trailing silence the renderer appends, puts the onset there, and every
 * measurement downstream reports an empty span. That is a silent failure of
 * exactly the kind this project keeps finding: no error, no warning, a profile
 * full of zeroes.
 */
export function onsetIndex(signal: Signal): number {
  const frameSize = Math.max(1, Math.round((RMS_FRAME_MS / 1000) * signal.sampleRate));
  const rms = rmsFrames(signal);
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

  const foot = (rms[bestFrame] ?? 0) * 0.2;
  let frame = bestFrame;
  while (frame > 0 && (rms[frame - 1] ?? 0) > foot) frame--;

  const gate = peakOf(signal.samples) * 0.02;
  const from = Math.max(0, (frame - 1) * frameSize);
  const to = Math.min(signal.samples.length, (frame + 1) * frameSize);
  for (let i = from; i < to; i++) {
    if (Math.abs(signal.samples[i] ?? 0) >= gate) return i;
  }
  return from;
}

/** The part of a signal that is actually the sound, in samples. */
export interface Span {
  readonly onset: number;
  /** One past the last sample above the tail floor. */
  readonly end: number;
  readonly attackMs: number;
  readonly durationMs: number;
}

/** Locate the sound inside a signal: where it starts, peaks and ends. */
export function spanOf(signal: Signal): Span {
  const frameSize = Math.max(1, Math.round((RMS_FRAME_MS / 1000) * signal.sampleRate));
  const rms = rmsFrames(signal);
  const onset = onsetIndex(signal);
  const onsetFrame = Math.min(rms.length - 1, Math.floor(onset / frameSize));

  let peakFrame = onsetFrame;
  for (let f = onsetFrame; f < rms.length; f++) {
    if ((rms[f] ?? 0) > (rms[peakFrame] ?? 0)) peakFrame = f;
  }

  /* A silent signal has no span. Without this, the tail search finds nothing
     below a floor of zero and reports the whole buffer as sound — a profile
     that would then be stored in the bank as a very long, very quiet recipe. */
  if ((rms[peakFrame] ?? 0) === 0) return { onset: 0, end: 0, attackMs: 0, durationMs: 0 };

  const floor = (rms[peakFrame] ?? 0) * TAIL_FLOOR;
  let endFrame = rms.length;
  while (endFrame > peakFrame + 1 && (rms[endFrame - 1] ?? 0) < floor) endFrame--;

  return {
    onset,
    end: Math.min(signal.samples.length, endFrame * frameSize),
    attackMs: Math.max(0, peakFrame - onsetFrame) * RMS_FRAME_MS,
    durationMs: Math.max(0, endFrame - onsetFrame) * RMS_FRAME_MS,
  };
}

/**
 * Analysis window for the spectral trajectory.
 *
 * One window per hop, clamped to 512..2048 samples — 12 to 46 ms at 44.1 kHz.
 * Both ends of that range were established by measurement, not by taste:
 *
 * - **2048 is too long for a transient.** Measuring a 25 ms pop through a 43 ms
 *   window smeared one rising tone into three phantom partials at 896/982/1060
 *   Hz, and a recipe was written to chase that artefact. With 512 the picture was
 *   unambiguous.
 * - **512 is as short as is useful.** Below it, bins are wider than 86 Hz and a
 *   thousand-hertz partial is described by three cycles; the difference the
 *   project actually needs to resolve — a reference pop at 1055 Hz against a
 *   candidate at 1098 — disappears into one bin. A 128-sample window put this
 *   analyzer's `peakHz` for the reference pop recipe at 772 Hz, reading the
 *   opening instant of its 14 ms sweep instead of the sweep.
 *
 * 512 is also what the playground's compare panel uses, which is the point:
 * a judgment formed while looking at the pictures has to mean the same thing to
 * the optimizer.
 */
function windowFor(spanSamples: number): number {
  return Math.max(512, Math.min(2048, prevPow2(Math.max(1, Math.round(spanSamples / CENTROID_POINTS)))));
}

/** Spectral centroid of one magnitude frame, in hertz. */
function centroidOf(mags: Float64Array, binHz: number): number {
  let weighted = 0;
  let total = 0;
  for (let i = 1; i < mags.length; i++) {
    const m = mags[i] as number;
    weighted += i * binHz * m;
    total += m;
  }
  return total === 0 ? 0 : weighted / total;
}

/** Spectral flatness: geometric over arithmetic mean, 0 = tone, 1 = noise. */
function flatnessOf(mags: Float64Array): number {
  let logSum = 0;
  let sum = 0;
  let count = 0;
  for (let i = 1; i < mags.length; i++) {
    const m = Math.max(mags[i] as number, 1e-12);
    logSum += Math.log(m);
    sum += m;
    count++;
  }
  if (count === 0) return 0;
  const arithmetic = sum / count;
  /* Below this the frame is silence, where the ratio of two floors is 1 and
     would report silence as the flattest possible spectrum. */
  if (arithmetic < 1e-9) return 0;
  return Math.min(1, Math.exp(logSum / count) / arithmetic);
}

/** Median of a list, without mutating it. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Share of energy that is not in a spectral peak, 0..1.
 *
 * Peaks are found against a smoothed copy of the spectrum — its own local noise
 * floor — rather than against a fixed threshold, because "how peaky" has to mean
 * the same thing for a quiet layer and a loud one. Energy that a local maximum
 * carries above that floor counts as tonal; everything else is noise. A pure
 * sine lands near 0, white noise near 1, and a band-passed burst in between,
 * which is the distinction the profile needs to make.
 *
 * Applied per frame and reduced by median, never to a time-averaged spectrum. A
 * sweep averaged over its own duration is a plateau with no peaks in it: the
 * reference pop recipe — two tonal layers and nothing broadband — measured 0.93
 * that way, which would have told the optimizer to chase noise it should not add.
 */
function noiseRatioOf(mags: Float64Array): number {
  const bins = mags.length;

  /* Prefix sums, so each bin's local floor costs four lookups instead of a
     nested loop. The analyzer runs inside the optimizer's inner loop. */
  const prefix = new Float64Array(bins + 1);
  for (let i = 0; i < bins; i++) prefix[i + 1] = (prefix[i] as number) + (mags[i] as number);
  const sum = (from: number, to: number): number =>
    (prefix[Math.min(bins, Math.max(0, to))] as number) - (prefix[Math.min(bins, Math.max(0, from))] as number);
  const span = (from: number, to: number): number => Math.min(bins, Math.max(0, to)) - Math.min(bins, Math.max(0, from));

  let tonal = 0;
  let total = 0;
  for (let i = 1; i < bins; i++) {
    const m = mags[i] as number;
    total += m * m;

    /* Local floor from the ring around the bin, with the bin's own main lobe
       notched out. A Hann-windowed partial covers about three bins, so leaving
       them in would make every peak part of the floor it is measured against —
       which is what compressed this metric to 0.64 for two pure tones. */
    const ringSum = sum(i - RING_OUTER, i + RING_OUTER + 1) - sum(i - RING_INNER, i + RING_INNER + 1);
    const ringCount = span(i - RING_OUTER, i + RING_OUTER + 1) - span(i - RING_INNER, i + RING_INNER + 1);
    if (ringCount <= 0) continue;
    const floor = ringSum / ringCount;

    /* Rayleigh-distributed noise magnitudes exceed three times their local mean
       with probability under 0.1 %, so the margin costs almost no tonal energy
       on real noise and keeps almost all of it on a partial. */
    if (m > TONAL_MARGIN * floor) tonal += m * m - floor * floor;
  }

  if (total === 0) return 0;
  return Math.max(0, Math.min(1, 1 - tonal / total));
}

/** Bins excluded from a peak's own local floor: its main lobe. */
const RING_INNER = 2;

/** Half-width of the ring the local floor is averaged over. */
const RING_OUTER = 8;

/** How far above its local floor a bin must stand to count as tonal. */
const TONAL_MARGIN = 3;

/**
 * Approximate integrated loudness in LUFS.
 *
 * "Approximate" is load-bearing. Proper BS.1770 loudness needs two biquads whose
 * coefficients are derived per sample rate; what is here instead is a
 * first-order high-pass at 100 Hz standing in for the K weighting's
 * low-frequency de-emphasis, followed by the standard mean-square to LUFS
 * conversion. That is enough for the two things the number is used for —
 * comparing a candidate against a target and normalizing before a spectral
 * comparison — and it costs one multiply-add per sample instead of six.
 */
function loudnessOf(signal: Signal, from: number, to: number): number {
  const cutoff = 100;
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / signal.sampleRate;
  const alpha = rc / (rc + dt);

  let previousIn = 0;
  let previousOut = 0;
  let sum = 0;
  let count = 0;
  for (let i = from; i < to; i++) {
    const value = signal.samples[i] ?? 0;
    const out = alpha * (previousOut + value - previousIn);
    previousIn = value;
    previousOut = out;
    sum += out * out;
    count++;
  }
  if (count === 0) return -Infinity;
  const meanSquare = sum / count;
  return meanSquare <= 0 ? -Infinity : -0.691 + 10 * Math.log10(meanSquare);
}

/**
 * Measure a signal.
 *
 * Everything is relative to the detected onset: the envelope starts there, the
 * spectral trajectory starts there, and `durationMs` counts from there down to
 * -60 dB. A profile therefore describes the sound and not its position in the
 * file it happened to arrive in.
 */
export function extractProfile(signal: Signal): SoundProfile {
  const span = spanOf(signal);
  const spanSamples = Math.max(1, span.end - span.onset);

  /* Amplitude contour, normalized so shape is compared without level. */
  const envelope: number[] = [];
  const step = spanSamples / ENVELOPE_POINTS;
  for (let p = 0; p < ENVELOPE_POINTS; p++) {
    const from = span.onset + Math.floor(p * step);
    envelope.push(rmsOf(signal.samples, from, Math.max(from + 1, span.onset + Math.floor((p + 1) * step))));
  }
  const envelopePeak = Math.max(...envelope, 0);
  const rmsEnvelope = envelopePeak > 0 ? envelope.map((value) => value / envelopePeak) : envelope;

  /* Spectral trajectory, one window per hop from the onset forward. */
  const size = windowFor(spanSamples);
  const binHz = signal.sampleRate / size;
  const hop = spanSamples / CENTROID_POINTS;
  const centroidHz: number[] = [];
  const flatnessPerFrame: number[] = [];
  const noisePerFrame: number[] = [];
  const average = new Float64Array(size / 2);
  let loudestFrame: Float64Array | undefined;
  let loudestEnergy = -1;

  for (let p = 0; p < CENTROID_POINTS; p++) {
    const mags = magnitudes(signal.samples, span.onset + Math.round(p * hop), size);
    centroidHz.push(centroidOf(mags, binHz));
    flatnessPerFrame.push(flatnessOf(mags));
    noisePerFrame.push(noiseRatioOf(mags));

    let energy = 0;
    for (let i = 1; i < mags.length; i++) {
      const m = mags[i] as number;
      energy += m * m;
      average[i] = (average[i] as number) + m / CENTROID_POINTS;
    }
    if (energy > loudestEnergy) {
      loudestEnergy = energy;
      loudestFrame = mags;
    }
  }

  /* The dominant partial is read from the loudest frame, not from the average:
     a sweep's average spectrum is a plateau with no peak to find. */
  const frame = loudestFrame ?? average;
  const peakHz = refinePeakBin(frame, dominantBin(frame)) * binHz;

  return {
    durationMs: span.durationMs,
    attackMs: span.attackMs,
    rmsEnvelope,
    centroidHz,
    flatness: median(flatnessPerFrame),
    noiseRatio: median(noisePerFrame),
    peakHz,
    loudnessLufsApprox: loudnessOf(signal, span.onset, span.end),
  };
}

/** A profile as a markdown table — the form a language model reads best. */
export function profileMarkdown(label: string, profile: SoundProfile): string {
  const rows: readonly (readonly [string, string])[] = [
    ['duration to -60 dB, ms', profile.durationMs.toFixed(0)],
    ['attack to peak, ms', profile.attackMs.toFixed(0)],
    ['dominant partial, Hz', profile.peakHz.toFixed(0)],
    ['centroid at onset, Hz', (profile.centroidHz[0] ?? 0).toFixed(0)],
    ['centroid mean, Hz', (profile.centroidHz.reduce((a, b) => a + b, 0) / Math.max(1, profile.centroidHz.length)).toFixed(0)],
    ['flatness (0 tone, 1 noise)', profile.flatness.toFixed(4)],
    ['noise ratio', profile.noiseRatio.toFixed(3)],
    ['loudness, LUFS (approx)', profile.loudnessLufsApprox.toFixed(1)],
  ];
  const head = `| metric | ${label} |\n| --- | --- |`;
  return `${head}\n${rows.map(([name, value]) => `| ${name} | ${value} |`).join('\n')}`;
}
