/**
 * A radix-2 FFT and a short-time spectrogram, in about a hundred lines.
 *
 * Written here rather than pulled in as a dependency because the playground is
 * the only consumer and the whole project's pitch is that this class of code is
 * small. Phase 3's analyzer will need its own spectral front-end with different
 * requirements (deterministic, Node-side, feeding `SoundProfile`); the two are
 * intentionally not shared yet — a single "utility" bent to serve a picture and a
 * metric at once would serve neither.
 *
 * @packageDocumentation
 */

/** Cached per-size tables: bit-reversal permutation and twiddle factors. */
interface Tables {
  readonly rev: Uint32Array;
  readonly cos: Float64Array;
  readonly sin: Float64Array;
}

const CACHE = new Map<number, Tables>();

function tablesFor(size: number): Tables {
  const cached = CACHE.get(size);
  if (cached !== undefined) return cached;
  if ((size & (size - 1)) !== 0) throw new RangeError(`FFT size must be a power of two, got ${String(size)}`);

  const bits = Math.log2(size);
  const rev = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }

  const half = size / 2;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / size);
    sin[i] = Math.sin((-2 * Math.PI * i) / size);
  }

  const tables: Tables = { rev, cos, sin };
  CACHE.set(size, tables);
  return tables;
}

/** In-place iterative FFT. `re`/`im` must both be `size` long. */
function fft(re: Float64Array, im: Float64Array): void {
  const size = re.length;
  const { rev, cos, sin } = tablesFor(size);

  for (let i = 0; i < size; i++) {
    const j = rev[i] ?? 0;
    if (j > i) {
      const tr = re[i] ?? 0;
      const ti = im[i] ?? 0;
      re[i] = re[j] ?? 0;
      im[i] = im[j] ?? 0;
      re[j] = tr;
      im[j] = ti;
    }
  }

  for (let span = 1; span < size; span <<= 1) {
    const step = size / (span << 1);
    for (let start = 0; start < size; start += span << 1) {
      for (let k = 0; k < span; k++) {
        const a = start + k;
        const b = a + span;
        const wr = cos[k * step] ?? 1;
        const wi = sin[k * step] ?? 0;
        const br = re[b] ?? 0;
        const bi = im[b] ?? 0;
        const tr = br * wr - bi * wi;
        const ti = br * wi + bi * wr;
        re[b] = (re[a] ?? 0) - tr;
        im[b] = (im[a] ?? 0) - ti;
        re[a] = (re[a] ?? 0) + tr;
        im[a] = (im[a] ?? 0) + ti;
      }
    }
  }
}

/**
 * Magnitude spectrum of one Hann-windowed slice, in linear magnitude.
 *
 * Used for the point measurements in `analysis.ts`. A short window is essential
 * there: 2048 samples span 46 ms, which is longer than a whole pop, and a single
 * sweeping resonance measured through a window that long smears into what looks
 * like a cluster of separate partials.
 */
export function spectrumAt(samples: Float32Array, offset: number, size: number): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    re[i] = (samples[offset + i] ?? 0) * w;
  }
  fft(re, im);
  const mags = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) mags[i] = Math.hypot(re[i] ?? 0, im[i] ?? 0);
  return mags;
}

/** A finished spectrogram: `frames` columns of `bins` magnitudes in dBFS. */
export interface Spectrogram {
  /** Column-major: `data[frame * bins + bin]`, in dB, floored at `floorDb`. */
  readonly data: Float32Array;
  readonly frames: number;
  readonly bins: number;
  /** Hz per bin. */
  readonly binHz: number;
  /** Seconds per column. */
  readonly hopSec: number;
  readonly floorDb: number;
}

/** Options of {@link spectrogram}. */
export interface SpectrogramOptions {
  readonly fftSize?: number;
  readonly hop?: number;
  readonly floorDb?: number;
}

/**
 * Short-time magnitude spectrum of one channel.
 *
 * Hann-windowed, magnitudes normalized by the window's coherent gain so a
 * full-scale sine reads about 0 dB rather than "some number that depends on the
 * FFT size".
 */
export function spectrogram(samples: Float32Array, sampleRate: number, options: SpectrogramOptions = {}): Spectrogram {
  const fftSize = options.fftSize ?? 1024;
  const hop = options.hop ?? 256;
  const floorDb = options.floorDb ?? -90;
  const bins = fftSize / 2;

  const window = new Float64Array(fftSize);
  let windowSum = 0;
  for (let i = 0; i < fftSize; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize);
    window[i] = w;
    windowSum += w;
  }

  const frames = Math.max(1, Math.ceil(Math.max(0, samples.length - fftSize) / hop) + 1);
  const data = new Float32Array(frames * bins);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  for (let frame = 0; frame < frames; frame++) {
    const offset = frame * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = (samples[offset + i] ?? 0) * (window[i] ?? 0);
      im[i] = 0;
    }
    fft(re, im);
    for (let bin = 0; bin < bins; bin++) {
      // 2/windowSum: two-sided spectrum folded to one side, window gain removed.
      const magnitude = (2 * Math.hypot(re[bin] ?? 0, im[bin] ?? 0)) / windowSum;
      const db = 20 * Math.log10(Math.max(magnitude, 1e-12));
      data[frame * bins + bin] = db < floorDb ? floorDb : db;
    }
  }

  return { data, frames, bins, binHz: sampleRate / fftSize, hopSec: hop / sampleRate, floorDb };
}
