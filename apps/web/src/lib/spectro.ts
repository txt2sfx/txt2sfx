/**
 * Four ways to colour a spectrogram, and what each one is *for*.
 *
 * ## The problem a second colour mode solves
 *
 * A magnitude spectrogram has one channel of information — loud or quiet — painted
 * onto a ramp that runs dark to hot. It is the right default and it hides two
 * questions that come up constantly while tuning a recipe:
 *
 * - *Which layer is that?* A four-layer explosion is one orange cloud. The `crack`
 *   layer and the `rumble` layer are indistinguishable, so a slider that moves one
 *   of them changes a picture in no legible way.
 * - *Is that a tone or is it noise?* Two blobs of identical brightness at identical
 *   frequency, one a filtered noise band and one a resonant partial, are the same
 *   pixels — and they are the difference between a sound that reads as *metal* and
 *   one that reads as *air*.
 *
 * Each mode answers by spending a colour dimension on a *measurement* rather than on
 * aesthetics, and each is legible only because the legend beside it names the axes.
 * A colour scheme whose meaning has to be remembered is a decoration; these are
 * instruments, so {@link MODE_LEGEND} and {@link swatchesFor} ship with them and the
 * panel is not allowed to render one without the other.
 *
 * | mode | what colour means |
 * | --- | --- |
 * | `tracks` | hue = the layer with the most energy here · brightness = level |
 * | `channels` | R = noisiness · G = level · B = frequency height — a fixed axis per channel, so the colour itself names the character |
 * | `hsv` | hue = dominant layer · saturation = tonal vs noisy · brightness = level |
 * | `diff` | cyan = candidate louder than the reference · amber = quieter · grey = matched |
 *
 * ## Where the numbers come from
 *
 * Nothing here is inferred from the recipe's text. `tracks` and `hsv` need to know
 * which layer owns a pixel, and they find out by comparing *rendered* per-layer
 * spectrograms (see `lib/layers.ts`) — so an effect tail, a filter that removes the
 * attack and a delay that moves energy 70 ms to the right all land in the right
 * place. Tonality is measured per pixel as how far the cell stands above the
 * smoothed spectrum around it: a partial is a spike over its neighbours, noise is
 * level with them. That measure is local, so it survives a sweeping resonance,
 * which a per-frame flatness would smear.
 *
 * @packageDocumentation
 */

import type { Spectrogram } from './fft.js';
import { LAYER_RGB } from './design.js';
import { binRanges, cellMax, diffColor, frameRange, hotColor } from './draw.js';

/** Which question the spectrogram is being asked. */
export type ColourMode = 'tracks' | 'channels' | 'hsv' | 'diff';

/** The modes, in the order the picker offers them. */
export const COLOUR_MODES: readonly { readonly id: ColourMode; readonly label: string }[] = [
  { id: 'tracks', label: 'Tracks' },
  { id: 'channels', label: 'Channels' },
  { id: 'hsv', label: 'HSV' },
  { id: 'diff', label: 'Diff' },
];

/** One line under the picture, naming what colour means in the active mode. */
export const MODE_LEGEND: Readonly<Record<ColourMode, string>> = {
  tracks: 'hue = which layer owns this point · brightness = energy',
  channels:
    'R = noisiness · G = level · B = frequency height — a fixed axis per channel, so the colour itself names the character',
  hsv: 'hue = dominant layer · saturation = tonal vs noisy · brightness = energy',
  diff: 'cyan = candidate louder than the reference · amber = quieter · grey = matched',
};

/** A key beside the picture. */
export interface Swatch {
  readonly color: string;
  readonly label: string;
}

/**
 * The key for a mode.
 *
 * `tracks` and `hsv` key off the recipe's own layer names, because a fixed legend
 * would say "layer 1" where the picture is talking about `rumble`.
 */
export function swatchesFor(mode: ColourMode, layerNames: readonly string[]): readonly Swatch[] {
  const layers = layerNames.map((label, index) => {
    const [r, g, b] = LAYER_RGB[index % LAYER_RGB.length] ?? [74, 196, 224];
    return { color: `rgb(${String(r)},${String(g)},${String(b)})`, label };
  });

  switch (mode) {
    case 'tracks':
      return layers;
    case 'hsv':
      return [...layers, { color: 'rgb(120,120,126)', label: 'noisy / desaturated' }];
    case 'channels':
      return [
        { color: 'rgb(236,214,72)', label: 'loud + noisy' },
        { color: 'rgb(206,96,236)', label: 'noisy highs' },
        { color: 'rgb(96,236,140)', label: 'loud tonal lows' },
        { color: 'rgb(40,44,52)', label: 'silence' },
      ];
    case 'diff':
      return [
        { color: 'rgb(74,208,238)', label: 'A louder' },
        { color: 'rgb(34,37,44)', label: 'matched' },
        { color: 'rgb(236,176,72)', label: 'B louder' },
      ];
  }
}

/** What {@link paintSpectrogram} needs. */
export interface PaintInput {
  readonly mode: ColourMode;
  /** The sound being painted — the candidate, or side A. */
  readonly spec: Spectrogram;
  readonly sampleRate: number;
  /**
   * Per-layer spectrograms of the same sound, in source order.
   *
   * Required by `tracks` and `hsv`; absent means those modes fall back to the
   * magnitude ramp rather than inventing an ownership they cannot know.
   */
  readonly layers?: readonly (Spectrogram | null)[];
  /** Side B. Required by `diff`. */
  readonly other?: Spectrogram | null;
  /** Difference in dB that saturates the diverging ramp. */
  readonly rangeDb?: number;
}

/** Colour below which a cell is treated as silence rather than as very quiet data. */
const SILENT_MARGIN_DB = 1;

/** dB by which a partial must stand above its neighbourhood to read as fully tonal. */
const TONAL_RANGE_DB = 18;

/** Ambient colour of a silent cell. Not pure black: a plot with no floor reads as broken. */
const FLOOR: readonly [number, number, number] = [16, 19, 24];

/**
 * How wide a neighbourhood the tonality measure compares against, in bins.
 *
 * Wide enough that a single partial does not raise its own baseline, narrow enough
 * that a broadband band edge is not read as a peak.
 */
const TONALITY_SPAN = 6;

/**
 * How far a cell stands above the smoothed spectrum around it, as 0..1.
 *
 * 1 is a lone partial, 0 is a cell no louder than its neighbours. This is the
 * measurement that lets a filtered noise band and a resonance be told apart at
 * equal level and equal frequency, which no magnitude ramp can do.
 */
function tonality(spec: Spectrogram, frame: number, bin: number, value: number): number {
  const base = frame * spec.bins;
  let sum = 0;
  let count = 0;
  for (let offset = -TONALITY_SPAN; offset <= TONALITY_SPAN; offset++) {
    if (offset === 0) continue;
    const at = bin + offset;
    if (at < 0 || at >= spec.bins) continue;
    sum += spec.data[base + at] ?? spec.floorDb;
    count++;
  }
  if (count === 0) return 0;
  const above = value - sum / count;
  return above <= 0 ? 0 : above >= TONAL_RANGE_DB ? 1 : above / TONAL_RANGE_DB;
}

/** HSV -> RGB, hue in degrees, s and v in 0..1. Written out because it is used per pixel. */
function hsv(hue: number, saturation: number, value: number): readonly [number, number, number] {
  const c = value * saturation;
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = value - c;
  const table: readonly (readonly [number, number, number])[] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = table[Math.min(5, Math.floor(h))] ?? [c, x, 0];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** The hues of {@link LAYER_RGB}, precomputed, so `hsv` mode can rotate to them. */
const LAYER_HUE: readonly number[] = [192, 278, 42, 152];

/**
 * Which layer has the most energy in a cell, and how much of the total it holds.
 *
 * Returns `null` when nothing is above the floor — a pixel with no owner must be
 * painted as silence rather than assigned to layer 0 by the tie-break, or a
 * four-layer sound comes out with a solid cyan background.
 */
function owner(
  layers: readonly (Spectrogram | null)[],
  frameLo: number,
  frameHi: number,
  binLo: number,
  binHi: number,
): { readonly index: number; readonly share: number } | null {
  let best = -Infinity;
  let index = -1;
  let total = 0;
  let floor = -Infinity;

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (layer === undefined || layer === null) continue;
    const db = cellMax(layer, frameLo, frameHi, binLo, binHi);
    if (layer.floorDb > floor) floor = layer.floorDb;
    /* Sum in linear magnitude: adding decibels would make two equally loud layers
       look like one twice as loud, and `share` would then be meaningless. */
    const linear = Math.pow(10, db / 20);
    total += linear;
    if (db > best) {
      best = db;
      index = i;
    }
  }

  if (index < 0 || best <= floor + SILENT_MARGIN_DB) return null;
  const strongest = Math.pow(10, best / 20);
  return { index, share: total === 0 ? 1 : strongest / total };
}

/**
 * Paint a spectrogram into an `ImageData`.
 *
 * One pass per pixel, and the pixel loop is why the axis tables come precomputed
 * from `draw.ts` — a 1120 × 150 plot is 168 000 iterations and it repaints when a
 * slider moves.
 */
export function paintSpectrogram(image: ImageData, input: PaintInput): void {
  const { width, height, data } = image;
  const { spec, sampleRate, mode } = input;
  const { lo, hi } = binRanges(height, spec, sampleRate);
  const range = -spec.floorDb;
  const layers = input.layers ?? [];
  const other = input.other ?? null;
  const rangeDb = input.rangeDb ?? 30;
  /* `tracks` and `hsv` without per-layer renders would be a guess dressed as a
     measurement. Fall back to the plain ramp instead, which is at least true. */
  const canAttribute = layers.some((layer) => layer !== null && layer !== undefined);
  const effective: ColourMode =
    (mode === 'tracks' || mode === 'hsv') && !canAttribute
      ? 'channels'
      : mode === 'diff' && other === null
        ? 'channels'
        : mode;

  for (let x = 0; x < width; x++) {
    const [frameLo, frameHi] = frameRange(x, width, spec.frames);
    for (let y = 0; y < height; y++) {
      const binLo = lo[y] ?? 0;
      const binHi = hi[y] ?? 0;
      const db = cellMax(spec, frameLo, frameHi, binLo, binHi);
      const level = (db - spec.floorDb) / range;
      const silent = db <= spec.floorDb + SILENT_MARGIN_DB;

      let colour: readonly [number, number, number];

      switch (effective) {
        case 'diff': {
          const [bLo, bHi] = frameRange(x, width, (other as Spectrogram).frames);
          const bDb = cellMax(other as Spectrogram, bLo, bHi, binLo, binHi);
          const bothSilent = silent && bDb <= (other as Spectrogram).floorDb + SILENT_MARGIN_DB;
          /* Note the sign, which is inverted relative to the old compare panel. That
             panel painted "A louder" amber; here it is cyan, because everywhere else in
             this view A *is* cyan and B *is* amber — the play buttons, the plot labels,
             the two metric columns. A diff picture whose colours contradict the rest of
             the panel makes every reader check the legend twice, and the one who does
             not check draws the opposite conclusion. `diffColor` runs cyan at −1 to
             amber at +1, so B minus A is the expression that agrees with the legend. */
          colour = bothSilent ? FLOOR : diffColor((bDb - db) / rangeDb);
          break;
        }

        case 'channels': {
          /* A fixed meaning per channel is the point: the reader learns three axes
             once and can then name a colour without consulting a ramp. Level gates
             the other two so silence stays black instead of glowing blue at the top
             of the plot, where "high frequency" is true of nothing. */
          const gate = Math.min(1, level * 2.2);
          const noisy = 1 - tonality(spec, frameLo, Math.round((binLo + binHi) / 2), db);
          const heightShare = 1 - y / height;
          colour = silent
            ? FLOOR
            : [noisy * 255 * gate, Math.pow(level, 0.75) * 255, heightShare * 255 * gate];
          break;
        }

        case 'tracks': {
          const own = owner(layers, frameLo, frameHi, binLo, binHi);
          if (silent || own === null) {
            colour = FLOOR;
            break;
          }
          const [r, g, b] = LAYER_RGB[own.index % LAYER_RGB.length] ?? [74, 196, 224];
          /* Two curves, meeting at mid level: dark-to-hue below, hue-to-white above.
             Without the upper half the loudest 6 dB of every layer is the same colour
             as its body and the attack disappears — which is the part being tuned. */
          const t = Math.pow(level, 0.8);
          colour =
            t < 0.5
              ? [
                  FLOOR[0] + (r - FLOOR[0]) * (t * 2),
                  FLOOR[1] + (g - FLOOR[1]) * (t * 2),
                  FLOOR[2] + (b - FLOOR[2]) * (t * 2),
                ]
              : [r + (255 - r) * (t - 0.5) * 1.4, g + (255 - g) * (t - 0.5) * 1.4, b + (255 - b) * (t - 0.5) * 1.4];
          break;
        }

        case 'hsv': {
          const own = owner(layers, frameLo, frameHi, binLo, binHi);
          if (silent || own === null) {
            colour = FLOOR;
            break;
          }
          const tonal = tonality(spec, frameLo, Math.round((binLo + binHi) / 2), db);
          /* Saturation carries tonality and never reaches zero: a fully grey pixel
             would be indistinguishable from the plot's own background, and "this is
             broadband" is information, not absence. */
          colour = hsv(
            LAYER_HUE[own.index % LAYER_HUE.length] ?? 192,
            0.15 + 0.85 * tonal,
            Math.pow(level, 0.7),
          );
          break;
        }
      }

      const p = (y * width + x) * 4;
      data[p] = colour[0];
      data[p + 1] = colour[1];
      data[p + 2] = colour[2];
      data[p + 3] = 255;
    }
  }
}

/** The plain magnitude ramp, for a side that has no layers to attribute (a reference). */
export function paintMagnitude(image: ImageData, spec: Spectrogram, sampleRate: number): void {
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
