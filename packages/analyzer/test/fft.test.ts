/**
 * FFT tests.
 *
 * Checked against closed forms rather than against a reference implementation:
 * an impulse has a known flat spectrum, a bin-centred sine has a known single
 * peak, and Parseval's theorem ties the two domains together. Those three catch
 * every scaling and indexing mistake a hand-written transform can make.
 */

import { describe, expect, it } from 'vitest';
import { dominantBin, fft, hann, isPow2, magnitudes, nextPow2, prevPow2, refinePeakBin } from '../src/index.js';
import { RATE, sine } from './helpers/signals.js';

describe('powers of two', () => {
  it('recognizes them', () => {
    expect([1, 2, 256, 4096].every(isPow2)).toBe(true);
    expect([0, 3, 100, 4095].some(isPow2)).toBe(false);
  });

  it('rounds in both directions', () => {
    expect(nextPow2(1000)).toBe(1024);
    expect(prevPow2(1000)).toBe(512);
    expect(nextPow2(1024)).toBe(1024);
    expect(prevPow2(1024)).toBe(1024);
  });
});

describe('fft', () => {
  it('turns a unit impulse into a flat unit spectrum', () => {
    const re = new Float64Array(64);
    const im = new Float64Array(64);
    re[0] = 1;
    fft(re, im);
    for (let i = 0; i < 64; i++) {
      expect(Math.hypot(re[i] as number, im[i] as number)).toBeCloseTo(1, 12);
    }
  });

  it('turns a constant into a single DC bin', () => {
    const re = new Float64Array(32).fill(1);
    const im = new Float64Array(32);
    fft(re, im);
    expect(re[0]).toBeCloseTo(32, 10);
    for (let i = 1; i < 32; i++) expect(Math.hypot(re[i] as number, im[i] as number)).toBeCloseTo(0, 10);
  });

  it('preserves energy (Parseval)', () => {
    const size = 128;
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    let state = 7;
    let timeEnergy = 0;
    for (let i = 0; i < size; i++) {
      state = (state * 16807) % 2147483647;
      const value = (state / 2147483647) * 2 - 1;
      re[i] = value;
      timeEnergy += value * value;
    }
    fft(re, im);
    let freqEnergy = 0;
    for (let i = 0; i < size; i++) freqEnergy += (re[i] as number) ** 2 + (im[i] as number) ** 2;
    expect(freqEnergy / size).toBeCloseTo(timeEnergy, 8);
  });

  it('rejects a length that is not a power of two', () => {
    expect(() => fft(new Float64Array(100), new Float64Array(100))).toThrow(/power of two/);
  });

  it('rejects mismatched real and imaginary parts', () => {
    expect(() => fft(new Float64Array(64), new Float64Array(32))).toThrow(/same length/);
  });

  it('is bit-identical across runs', () => {
    const run = (): number[] => {
      const re = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const im = new Float64Array(8);
      fft(re, im);
      return [...re, ...im];
    };
    expect(run()).toEqual(run());
  });
});

describe('hann', () => {
  it('starts at zero and peaks in the middle', () => {
    const window = hann(8);
    expect(window[0]).toBe(0);
    expect(window[4]).toBeCloseTo(1, 12);
  });

  it('returns the same cached instance for a size', () => {
    expect(hann(256)).toBe(hann(256));
  });
});

describe('magnitudes', () => {
  it('reports a sine at its own amplitude', () => {
    /* 689.0625 Hz is bin 8 of a 512-point window at 44.1 kHz — exactly on a bin,
       so no leakage and the amplitude can be checked against the source. */
    const binHz = RATE / 512;
    const signal = sine(binHz * 8, 100, 0.5);
    const mags = magnitudes(signal.samples, 1000, 512);
    expect(dominantBin(mags)).toBe(8);
    expect(mags[8] as number).toBeCloseTo(0.5, 2);
  });

  it('is independent of window size, which is the point of the scaling', () => {
    const signal = sine(1378.125, 200, 0.4);
    for (const size of [512, 1024, 2048]) {
      const mags = magnitudes(signal.samples, 2000, size);
      expect(mags[dominantBin(mags)] as number).toBeCloseTo(0.4, 2);
    }
  });

  it('zero-pads a window that hangs off the start of the signal', () => {
    const signal = sine(1000, 50);
    const mags = magnitudes(signal.samples, -256, 512);
    expect(mags.every((m) => Number.isFinite(m))).toBe(true);
    expect(mags[dominantBin(mags)] as number).toBeGreaterThan(0);
  });

  it('rejects a size that is not a power of two', () => {
    expect(() => magnitudes(new Float64Array(1000), 0, 500)).toThrow(/power of two/);
  });
});

describe('refinePeakBin', () => {
  /**
   * The measurement this exists for: 86 Hz bins have to resolve a 43 Hz
   * difference, because that is the gap between the project's reference pop and
   * a candidate that sounds wrong.
   */
  it('recovers a frequency that falls between bins', () => {
    const size = 512;
    const binHz = RATE / size;
    for (const target of [1055, 1098, 3210]) {
      const signal = sine(target, 200, 0.7);
      const mags = magnitudes(signal.samples, 4000, size);
      const refined = refinePeakBin(mags, dominantBin(mags)) * binHz;
      expect(Math.abs(refined - target)).toBeLessThan(binHz / 4);
    }
  });

  it('leaves the edges alone rather than reading out of bounds', () => {
    const mags = new Float64Array([1, 2, 3]);
    expect(refinePeakBin(mags, 0)).toBe(0);
    expect(refinePeakBin(mags, 2)).toBe(2);
  });
});
