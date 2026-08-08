/**
 * The design tokens that JavaScript needs to know about.
 *
 * Everything the CSS can own lives in `styles.css` as a custom property. What is
 * here is the residue: colours that a *canvas* has to compute — a spectrogram
 * paints per pixel, and `getComputedStyle` per pixel is not a thing — and the
 * per-category hue, which is a function rather than a constant and is read by
 * both the CSS (through an inline `--hue`) and the drawing code.
 *
 * One rule keeps the two halves from drifting: colour in this file is expressed
 * as **a hue plus a role**, never as a literal. `catHue('laser')` and
 * `--hue: 265` are the same fact stated twice in the two languages that need it,
 * and a new category is one line here and none in the stylesheet.
 *
 * @packageDocumentation
 */

import type { SoundCategory } from '@txt2sfx/shared';

/**
 * Hue per sound category, in oklch degrees.
 *
 * Chosen so that neighbours in the gallery are distinguishable rather than to
 * mean anything: hue cannot carry "explosion" as a concept. What it does carry is
 * identity — the same sound is the same colour in the card, in the rail, in the
 * waveform and in the badge, so the eye can follow one recipe across four panels
 * without reading a label.
 */
const CATEGORY_HUE: Readonly<Record<SoundCategory, number>> = {
  ui: 195,
  pop: 340,
  pickup: 150,
  laser: 265,
  impact: 55,
  explosion: 25,
  foley: 120,
  cycle: 300,
  misc: 265,
};

/** Hue for a category, falling back to the neutral one for anything unknown. */
export function catHue(category: string | undefined): number {
  return CATEGORY_HUE[category as SoundCategory] ?? CATEGORY_HUE.misc;
}

/** A category colour at an explicit lightness and chroma. */
export function catColor(category: string | undefined, lightness = 0.78, chroma = 0.13): string {
  return `oklch(${String(lightness)} ${String(chroma)} ${String(catHue(category))})`;
}

/**
 * The three accent hues the screens are built on.
 *
 * They are not decoration: each names a *kind of thing being looked at*, and the
 * prompt row's border, the view tab and the transport button all take their hue
 * from whichever is active, so the colour of the page says what mode it is in.
 */
export const HUE = {
  /** The recipe — our own synthesis, and the app's primary. */
  recipe: 195,
  /** A model's render — the reference, never the deliverable. */
  model: 80,
  /** Comparison and sharing: what leaves the tool. */
  compare: 300,
  /**
   * Somebody else's recording, found in a library.
   *
   * The same angle as {@link HUE.ok}, and deliberately: green here means *available* —
   * a sound that already exists and can be had — which is the same claim a green dot
   * makes about a daemon. The two never appear in the same control, so one angle
   * carrying both readings costs nothing and keeps the palette at five.
   */
  library: 150,
  /** Something is fine. */
  ok: 150,
  /** Something is not. */
  bad: 25,
} as const;

/**
 * Per-layer colours, as canvas RGB triples.
 *
 * The same four hues as `--layer-N` in the stylesheet, in the same order, because
 * the lane label beside a waveform and the pixels of the `tracks` spectrogram
 * must agree about which layer is which — that agreement is the entire content of
 * that colour mode.
 */
export const LAYER_RGB: readonly (readonly [number, number, number])[] = [
  [74, 196, 224],
  [186, 148, 238],
  [230, 178, 78],
  [108, 208, 150],
];

/** CSS colour for layer `index`, wrapping like the RGB table. */
export function layerColor(index: number, lightness = 0.77, chroma = 0.13): string {
  const hues = [195, 300, 80, 150];
  return `oklch(${String(lightness)} ${String(chroma)} ${String(hues[index % hues.length] ?? 195)})`;
}

/** Layer colour as a canvas-ready `rgb()` string. */
export function layerRgb(index: number, alpha = 1): string {
  const [r, g, b] = LAYER_RGB[index % LAYER_RGB.length] ?? [74, 196, 224];
  return alpha === 1
    ? `rgb(${String(r)},${String(g)},${String(b)})`
    : `rgba(${String(r)},${String(g)},${String(b)},${String(alpha)})`;
}
