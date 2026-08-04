/**
 * Canvas drawing shared by the single-sound visualizer and the compare view.
 *
 * Both panels must agree on the colour ramp, the logarithmic frequency mapping
 * and the waveform rendering, or the eye cannot carry a judgement from one to the
 * other — which is the whole point of having a compare view. So the primitives
 * live here once, and the components only decide layout.
 *
 * @packageDocumentation
 */

import type { Spectrogram } from './fft.js';

/** Lowest frequency the spectrograms show. Below this SFX energy is inaudible rumble. */
export const F_MIN = 40;

/** Highest frequency worth showing for a given sample rate. */
export function fMaxFor(sampleRate: number): number {
  return Math.min(20000, sampleRate / 2);
}

/** Magnitude ramp stops, dark to hot, in the project's neon palette. */
const HOT: readonly (readonly [number, number, number])[] = [
  [10, 12, 20],
  [18, 32, 74],
  [16, 96, 132],
  [34, 211, 238],
  [192, 132, 252],
  [251, 191, 36],
  [255, 255, 235],
];

/**
 * Diverging ramp for signed differences.
 *
 * Cyan = the candidate has less energy here, amber = more, near-black = agreement.
 * Deliberately not red/green: the point of a diff picture is that a *reader* — a
 * human or a vision model — can name the direction, and red/green fails for a
 * significant share of humans.
 */
const COLD_HOT: readonly (readonly [number, number, number])[] = [
  [34, 211, 238],
  [16, 90, 120],
  [12, 14, 22],
  [120, 80, 20],
  [251, 191, 36],
];

function sample(stops: readonly (readonly [number, number, number])[], t: number): readonly [number, number, number] {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i] ?? [0, 0, 0];
  const b = stops[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Magnitude colour for a 0..1 level. */
export function hotColor(t: number): readonly [number, number, number] {
  return sample(HOT, t);
}

/** Difference colour for a -1..1 signed level. */
export function diffColor(t: number): readonly [number, number, number] {
  return sample(COLD_HOT, (t + 1) / 2);
}

/**
 * Pixel row -> the bin range it covers, for a log frequency axis.
 *
 * Precomputed per repaint because the inner loop runs once per pixel and the
 * `exp` would otherwise dominate the frame.
 */
function binRanges(height: number, spec: Spectrogram, sampleRate: number): { lo: Int32Array; hi: Int32Array } {
  const fMax = fMaxFor(sampleRate);
  const decades = Math.log(fMax / F_MIN);
  const lo = new Int32Array(height);
  const hi = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    const top = F_MIN * Math.exp((decades * (height - y)) / height);
    const bottom = F_MIN * Math.exp((decades * (height - y - 1)) / height);
    lo[y] = Math.max(0, Math.floor(bottom / spec.binHz));
    hi[y] = Math.min(spec.bins - 1, Math.max(Math.floor(bottom / spec.binHz), Math.ceil(top / spec.binHz) - 1));
  }
  return { lo, hi };
}

/** Column range of the spectrogram that maps to canvas column `x`. */
function frameRange(x: number, width: number, frames: number): readonly [number, number] {
  const lo = Math.min(frames - 1, Math.floor((x * frames) / width));
  const hi = Math.min(frames - 1, Math.max(lo, Math.floor(((x + 1) * frames) / width) - 1));
  return [lo, hi];
}

/** Loudest value in the (frames × bins) rectangle a pixel covers. */
function cellMax(spec: Spectrogram, frameLo: number, frameHi: number, binLo: number, binHi: number): number {
  let db = spec.floorDb;
  for (let frame = frameLo; frame <= frameHi; frame++) {
    const base = frame * spec.bins;
    for (let bin = binLo; bin <= binHi; bin++) {
      const value = spec.data[base + bin] ?? spec.floorDb;
      if (value > db) db = value;
    }
  }
  return db;
}

/**
 * Render a spectrogram to an `ImageData`.
 *
 * Max, not mean, over each pixel's cell: a narrow resonance must stay visible
 * when one pixel row spans a dozen bins, which is the norm high up a log axis.
 */
export function spectrogramImage(
  image: ImageData,
  spec: Spectrogram,
  sampleRate: number,
): void {
  const { width, height, data } = image;
  const { lo, hi } = binRanges(height, spec, sampleRate);
  const range = -spec.floorDb;

  for (let x = 0; x < width; x++) {
    const [frameLo, frameHi] = frameRange(x, width, spec.frames);
    for (let y = 0; y < height; y++) {
      const db = cellMax(spec, frameLo, frameHi, lo[y] ?? 0, hi[y] ?? 0);
      const [r, g, b] = hotColor((db - spec.floorDb) / range);
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
}

/**
 * Render the signed difference of two spectrograms.
 *
 * @param rangeDb Difference that saturates the ramp, in dB.
 */
export function spectrogramDiffImage(
  image: ImageData,
  a: Spectrogram,
  b: Spectrogram,
  sampleRate: number,
  rangeDb = 30,
): void {
  const { width, height, data } = image;
  const { lo, hi } = binRanges(height, a, sampleRate);

  for (let x = 0; x < width; x++) {
    const [aLo, aHi] = frameRange(x, width, a.frames);
    const [bLo, bHi] = frameRange(x, width, b.frames);
    for (let y = 0; y < height; y++) {
      const binLo = lo[y] ?? 0;
      const binHi = hi[y] ?? 0;
      const av = cellMax(a, aLo, aHi, binLo, binHi);
      const bv = cellMax(b, bLo, bHi, binLo, binHi);
      // Where both are at the floor there is nothing to compare: keep it black
      // instead of letting rounding noise paint a colour.
      const silent = av <= a.floorDb + 1 && bv <= b.floorDb + 1;
      const [r, g, bl] = silent ? ([12, 14, 22] as const) : diffColor((av - bv) / rangeDb);
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = bl;
      data[p + 3] = 255;
    }
  }
}

/** A rectangle on the canvas, in device pixels. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Draw a min/max waveform inside `box`, centred on its own zero line. */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  samples: Float32Array,
  box: Box,
  color: string,
): void {
  const mid = box.y + box.h / 2;
  const half = box.h / 2;
  ctx.fillStyle = color;
  for (let x = 0; x < box.w; x++) {
    const from = Math.floor((x * samples.length) / box.w);
    const to = Math.max(from + 1, Math.floor(((x + 1) * samples.length) / box.w));
    let min = 0;
    let max = 0;
    for (let i = from; i < to && i < samples.length; i++) {
      const value = samples[i] ?? 0;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const top = mid - max * half;
    const bottom = mid - min * half;
    ctx.fillRect(box.x + x, top, 1, Math.max(1, bottom - top));
  }
}

/** Horizontal zero line plus the clipping rails, for scale. */
export function drawWaveformGuides(ctx: CanvasRenderingContext2D, box: Box, maxPeak: number, dpr: number): void {
  const mid = box.y + box.h / 2;
  ctx.strokeStyle = 'rgba(148,163,184,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(box.x, mid);
  ctx.lineTo(box.x + box.w, mid);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(248,113,113,0.3)';
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  for (const sign of [-1, 1]) {
    const y = mid - (sign * maxPeak * box.h) / 2;
    ctx.beginPath();
    ctx.moveTo(box.x, y);
    ctx.lineTo(box.x + box.w, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/** Decade gridlines with labels, matching the log axis of the spectrograms. */
export function drawFreqGrid(
  ctx: CanvasRenderingContext2D,
  box: Box,
  sampleRate: number,
  dpr: number,
): void {
  const fMax = fMaxFor(sampleRate);
  const decades = Math.log(fMax / F_MIN);
  ctx.font = `${String(10 * dpr)}px ui-monospace, monospace`;

  for (const hz of [100, 1000, 10000]) {
    if (hz >= fMax) continue;
    const y = box.y + box.h - (Math.log(hz / F_MIN) / decades) * box.h;
    ctx.strokeStyle = 'rgba(226,232,240,0.12)';
    ctx.beginPath();
    ctx.moveTo(box.x, y);
    ctx.lineTo(box.x + box.w, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(226,232,240,0.75)';
    ctx.fillText(hz >= 1000 ? `${String(hz / 1000)}k` : String(hz), box.x + 4 * dpr, y - 3 * dpr);
  }
}

/** Millisecond ruler across the bottom of `box`. */
export function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  box: Box,
  totalMs: number,
  dpr: number,
): void {
  if (totalMs <= 0) return;
  /* Aim for 6-10 labelled ticks on a 1-2-5 sequence. */
  const raw = totalMs / 8;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;

  ctx.font = `${String(10 * dpr)}px ui-monospace, monospace`;
  ctx.fillStyle = 'rgba(226,232,240,0.6)';
  ctx.strokeStyle = 'rgba(226,232,240,0.15)';
  for (let ms = 0; ms <= totalMs; ms += step) {
    const x = box.x + (ms / totalMs) * box.w;
    ctx.beginPath();
    ctx.moveTo(x, box.y);
    ctx.lineTo(x, box.y + 4 * dpr);
    ctx.stroke();
    ctx.fillText(`${String(Math.round(ms))}`, x + 2 * dpr, box.y + 12 * dpr);
  }
  ctx.fillText('ms', box.x + box.w - 16 * dpr, box.y + 12 * dpr);
}

/** A short label with a legible backing, for panel titles inside the plot. */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  dpr: number,
  color = 'rgba(226,232,240,0.9)',
): void {
  ctx.font = `${String(11 * dpr)}px ui-monospace, monospace`;
  const width = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(7,8,16,0.72)';
  ctx.fillRect(x - 3 * dpr, y - 11 * dpr, width + 6 * dpr, 15 * dpr);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
