/**
 * The four colour modes, and the one rule they all obey.
 *
 * The rule: **a mode may never invent an attribution it cannot measure.** `tracks` and
 * `hsv` colour a pixel by which layer owns it, and if the per-layer renders are missing
 * they must fall back to something true rather than paint layer 0 everywhere — a picture
 * that confidently assigns every pixel to `body` is worse than a plain magnitude ramp,
 * because it looks like an answer.
 *
 * The rest of what is checked here is the arithmetic that is easy to get subtly wrong
 * and impossible to notice by eye: that silence stays at the floor, that a louder cell
 * is a brighter pixel, and that the diff ramp points the way the legend says it does.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { spectrogram, type Spectrogram } from '../src/lib/fft.js';
import {
  colourModes,
  modeLegend,
  paintMagnitude,
  paintSpectrogram,
  swatchesFor,
  type ColourMode,
} from '../src/lib/spectro.js';

const RATE = 44100;

/** A sine at `hz`, `ms` long. */
function tone(hz: number, ms: number, amplitude = 0.8): Float32Array {
  const length = Math.round((ms / 1000) * RATE);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

function silence(ms: number): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * RATE));
}

/** A blank `ImageData` without a DOM. */
function image(width: number, height: number): ImageData {
  return { width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' } as ImageData;
}

/** Mean luminance of a painted image, 0..255. */
function brightness(target: ImageData): number {
  let sum = 0;
  for (let i = 0; i < target.data.length; i += 4) {
    sum += ((target.data[i] ?? 0) + (target.data[i + 1] ?? 0) + (target.data[i + 2] ?? 0)) / 3;
  }
  return sum / (target.data.length / 4);
}

const OPTIONS = { fftSize: 512, hop: 64 } as const;
const LOUD: Spectrogram = spectrogram(tone(1000, 60), RATE, OPTIONS);
const QUIET: Spectrogram = spectrogram(tone(1000, 60, 0.05), RATE, OPTIONS);
const SILENT: Spectrogram = spectrogram(silence(60), RATE, OPTIONS);

describe('the colour modes', () => {
  it('names a legend and a full alpha channel for every mode it offers', () => {
    for (const mode of colourModes()) {
      expect(modeLegend(mode.id)).toBeTruthy();
      const target = image(24, 16);
      paintSpectrogram(target, { mode: mode.id, spec: LOUD, sampleRate: RATE, other: QUIET, layers: [LOUD] });
      for (let i = 3; i < target.data.length; i += 4) expect(target.data[i]).toBe(255);
    }
  });

  it('paints silence dark and a loud tone bright, in every mode', () => {
    for (const mode of colourModes()) {
      const quiet = image(24, 16);
      const loud = image(24, 16);
      paintSpectrogram(quiet, { mode: mode.id, spec: SILENT, sampleRate: RATE, other: SILENT, layers: [SILENT] });
      paintSpectrogram(loud, { mode: mode.id, spec: LOUD, sampleRate: RATE, other: SILENT, layers: [LOUD] });
      expect(brightness(loud)).toBeGreaterThan(brightness(quiet));
    }
  });

  /* The rule this file exists for. Without per-layer renders there is no ownership to
     colour by, and inventing one would produce a confident, wrong picture. */
  it('falls back rather than attributing pixels it cannot attribute', () => {
    for (const mode of ['tracks', 'hsv'] as const) {
      const withLayers = image(24, 16);
      const without = image(24, 16);
      paintSpectrogram(withLayers, { mode, spec: LOUD, sampleRate: RATE, layers: [LOUD] });
      paintSpectrogram(without, { mode, spec: LOUD, sampleRate: RATE, layers: [] });
      expect([...without.data]).not.toEqual([...withLayers.data]);
      /* And what it fell back to is a real picture, not a black rectangle. */
      expect(brightness(without)).toBeGreaterThan(1);
    }
  });

  it('falls back when diff is asked for with no B side', () => {
    const target = image(24, 16);
    paintSpectrogram(target, { mode: 'diff', spec: LOUD, sampleRate: RATE, other: null });
    expect(brightness(target)).toBeGreaterThan(1);
  });

  /* Cyan where A is louder, amber where B is: the legend says so, and a reader — human
     or vision model — who has the direction backwards draws the opposite conclusion. */
  it('points the diff ramp the way the legend claims', () => {
    const aLouder = image(24, 16);
    const bLouder = image(24, 16);
    paintSpectrogram(aLouder, { mode: 'diff', spec: LOUD, sampleRate: RATE, other: QUIET });
    paintSpectrogram(bLouder, { mode: 'diff', spec: QUIET, sampleRate: RATE, other: LOUD });

    const blueness = (target: ImageData): number => {
      let sum = 0;
      for (let i = 0; i < target.data.length; i += 4) sum += (target.data[i + 2] ?? 0) - (target.data[i] ?? 0);
      return sum;
    };
    expect(blueness(aLouder)).toBeGreaterThan(blueness(bLouder));
    expect(modeLegend('diff')).toContain('cyan');
  });

  it('keys tracks and hsv off the recipe’s own layer names', () => {
    expect(swatchesFor('tracks', ['body', 'edge']).map((s) => s.label)).toEqual(['body', 'edge']);
    /* hsv adds one more, because desaturation carries a meaning no layer owns. */
    expect(swatchesFor('hsv', ['body']).map((s) => s.label)).toEqual(['body', 'noisy / desaturated']);
    expect(swatchesFor('diff', ['body']).length).toBe(3);
    expect(swatchesFor('channels', []).length).toBe(4);
  });

  it('gives two distinct layers two distinct colours', () => {
    const low = spectrogram(tone(200, 60), RATE, OPTIONS);
    const high = spectrogram(tone(6000, 60), RATE, OPTIONS);
    const both = spectrogram(
      Float32Array.from(tone(200, 60), (value, i) => value + (tone(6000, 60)[i] ?? 0)),
      RATE,
      OPTIONS,
    );
    const target = image(32, 48);
    paintSpectrogram(target, { mode: 'tracks', spec: both, sampleRate: RATE, layers: [low, high] });

    const colours = new Set<string>();
    for (let i = 0; i < target.data.length; i += 4) {
      const r = target.data[i] ?? 0;
      const g = target.data[i + 1] ?? 0;
      const b = target.data[i + 2] ?? 0;
      if (r + g + b > 90) colours.add(`${Math.round(r / 40)}-${Math.round(g / 40)}-${Math.round(b / 40)}`);
    }
    expect(colours.size).toBeGreaterThan(1);
  });

  it('paints the plain magnitude ramp for a side with no layers to attribute', () => {
    const target = image(24, 16);
    paintMagnitude(target, LOUD, RATE);
    expect(brightness(target)).toBeGreaterThan(1);
    for (let i = 3; i < target.data.length; i += 4) expect(target.data[i]).toBe(255);
  });

  it('offers exactly the four modes the panel has legends for', () => {
    const ids = colourModes().map((mode) => mode.id);
    expect(ids).toEqual(['tracks', 'channels', 'hsv', 'diff'] satisfies ColourMode[]);
  });
});
