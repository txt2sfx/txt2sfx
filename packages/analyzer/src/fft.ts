/**
 * Radix-2 FFT and the windowing around it. No dependencies, by policy.
 *
 * ## Why not reuse the playground's FFT
 *
 * `apps/web/src/lib/fft.ts` exists and computes the same transform. It is not
 * imported here on purpose. That one draws pictures: it may trade accuracy for
 * speed, it runs in a browser, and its output feeds a canvas. This one produces
 * the numbers a fitness function is optimized against and a recipe bank stores,
 * so it has to be deterministic, exact to the same bit on every run, and free of
 * platform assumptions. A shared "utility" would end up serving neither: every
 * change for the optimizer's benefit would be a change to what the playground
 * draws, and vice versa.
 *
 * ## Magnitude scaling
 *
 * {@link magnitudes} returns amplitudes in signal units: a sine of amplitude
 * 0.5 produces a peak bin of about 0.5, whatever the window size. That is worth
 * the two extra multiplications — every number the analyzer reports can then be
 * compared against a sample value or converted to dBFS without remembering
 * which normalization convention produced it.
 *
 * @packageDocumentation
 */

/** Whether a length is a power of two, which the transform requires. */
export function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Smallest power of two greater than or equal to `n` (at least 1). */
export function nextPow2(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

/** Largest power of two less than or equal to `n` (at least 1). */
export function prevPow2(n: number): number {
  let size = 1;
  while (size * 2 <= n) size *= 2;
  return size;
}

/**
 * In-place complex FFT, iterative Cooley-Tukey, decimation in time.
 *
 * Twiddle factors are computed per stage by repeated rotation rather than by a
 * `Math.cos` call per butterfly: the same values in the same order every time,
 * and about three times faster, which matters when the optimizer runs this a few
 * hundred thousand times.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length) throw new RangeError('fft: real and imaginary parts must have the same length');
  if (!isPow2(n)) throw new RangeError(`fft: length must be a power of two, got ${n}`);

  /* Bit-reversal permutation. */
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len *= 2) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const even = start + k;
        const odd = even + len / 2;
        const oRe = (re[odd] as number) * curRe - (im[odd] as number) * curIm;
        const oIm = (re[odd] as number) * curIm + (im[odd] as number) * curRe;
        re[odd] = (re[even] as number) - oRe;
        im[odd] = (im[even] as number) - oIm;
        re[even] = (re[even] as number) + oRe;
        im[even] = (im[even] as number) + oIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Hann windows, memoized by size — the analyzer reuses a handful of sizes. */
const windows = new Map<number, Float64Array>();

/**
 * Hann window of `size` points.
 *
 * Hann rather than Hamming or Blackman: its -31 dB sidelobes are enough to keep
 * a loud partial from smearing over a quiet one, and its narrow main lobe keeps
 * the short windows this analyzer favours useful. Short windows are not a
 * detail — measuring a 25 ms transient through a 43 ms window smears one
 * gliding tone into three phantom partials, which is exactly the mistake that
 * sent the project's reference pop recipe in the wrong direction once.
 */
export function hann(size: number): Float64Array {
  const cached = windows.get(size);
  if (cached !== undefined) return cached;
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  windows.set(size, window);
  return window;
}

/** Sum of a window's samples — its coherent gain. */
function windowSum(window: Float64Array): number {
  let sum = 0;
  for (const value of window) sum += value;
  return sum;
}

/**
 * Magnitude spectrum of `size` samples starting at `start`.
 *
 * Out-of-range samples read as zero, so a window may hang off either end of the
 * signal: a transient at sample 0 can still be measured with a window centred
 * on it. Returns `size / 2` bins; bin `i` is centred at `i * sampleRate / size`.
 */
export function magnitudes(samples: ArrayLike<number>, start: number, size: number): Float64Array {
  if (!isPow2(size)) throw new RangeError(`magnitudes: size must be a power of two, got ${size}`);
  const window = hann(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);

  for (let i = 0; i < size; i++) {
    const index = start + i;
    const sample = index >= 0 && index < samples.length ? samples[index] : 0;
    re[i] = (sample ?? 0) * (window[i] as number);
  }

  fft(re, im);

  const scale = 2 / windowSum(window);
  const out = new Float64Array(size / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.hypot(re[i] as number, im[i] as number) * scale;
  }
  return out;
}

/**
 * Frequency of a spectral peak, refined between bins.
 *
 * A 512-point window at 44.1 kHz has 86 Hz bins, and the difference the project
 * cares about — a reference pop peaking at 1055 Hz against a candidate at
 * 1098 Hz — is half a bin. Parabolic interpolation on the log magnitudes of the
 * peak and its neighbours recovers it: the log of a Hann-windowed main lobe is
 * close enough to a parabola that the vertex lands within a few hertz.
 */
export function refinePeakBin(mags: ArrayLike<number>, bin: number): number {
  if (bin <= 0 || bin >= mags.length - 1) return bin;
  const left = Math.log(Math.max(mags[bin - 1] ?? 0, 1e-12));
  const centre = Math.log(Math.max(mags[bin] ?? 0, 1e-12));
  const right = Math.log(Math.max(mags[bin + 1] ?? 0, 1e-12));
  const denominator = left - 2 * centre + right;
  if (denominator === 0) return bin;
  const offset = (0.5 * (left - right)) / denominator;
  return bin + Math.max(-0.5, Math.min(0.5, offset));
}

/** Index of the largest bin, ignoring DC. */
export function dominantBin(mags: ArrayLike<number>): number {
  let best = 1;
  for (let i = 1; i < mags.length; i++) {
    if ((mags[i] ?? 0) > (mags[best] ?? 0)) best = i;
  }
  return best;
}
