/**
 * One sound, taken apart into its layers — and put back together as pictures.
 *
 * ## Why a layer is rendered rather than modelled
 *
 * The studio shows a lane per layer under the master waveform, and the `tracks`
 * and `hsv` spectrograms colour every pixel by *which layer owns it*. Both need to
 * know what each layer sounds like alone. There is an obvious cheap way to get
 * that — read `decay`, `delay` and a centre frequency off the AST and draw an
 * exponential — and it is the wrong way, because the picture would then be a
 * drawing of the recipe's *arguments* rather than of its sound. A `verb` tail, a
 * recirculating `delay`, a filter that eats the attack: all invisible.
 *
 * So a layer is rendered. `single` builds a one-layer `SoundAST` out of the real
 * one and hands it to the same renderer the master uses, which means a lane is
 * the layer, measured, with every effect in its chain applied.
 *
 * ## Why the results are cached
 *
 * A four-layer sound is five offline renders, and the editor re-parses on every
 * keystroke. The cache is keyed by the serialized layer plus the seed, so it is
 * correct by construction — two identical layers share an entry, and an edit to
 * layer 2 does not invalidate layer 0. Bounded, because a long editing session
 * would otherwise hold every intermediate state of the recipe in memory.
 *
 * @packageDocumentation
 */

import type { SoundAST } from '@txt2sfx/shared';
import { serializeLayer, type RenderResult } from '@txt2sfx/core';
import { render } from './engine.js';

/**
 * The sound with only layer `index` in it.
 *
 * The header is kept verbatim — same declared duration, same category, same loop
 * flag — because the lane has to share a time axis with the master or the two
 * pictures cannot be read against each other. Note that the result is *not*
 * something to validate: a single layer of a four-layer explosion may well breach
 * an invariant on its own, and that says nothing about the sound it came from.
 */
export function single(ast: SoundAST, index: number): SoundAST | null {
  const layer = ast.layers[index];
  if (layer === undefined) return null;
  return { ...ast, layers: [layer] };
}

/** Largest number of layer renders kept alive. Five recipes' worth. */
const CACHE_LIMIT = 24;

const cache = new Map<string, Promise<RenderResult>>();

/** Insertion-ordered eviction: a `Map` iterates oldest first, which is all we need. */
function remember(key: string, value: Promise<RenderResult>): Promise<RenderResult> {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
  return value;
}

/**
 * Render layer `index` alone.
 *
 * Rejections are cached too, deliberately: a layer whose chain cannot compile will
 * fail identically every time, and retrying it once per repaint would turn one bad
 * effect argument into a stalled UI.
 */
export function renderLayer(ast: SoundAST, index: number, seed: number): Promise<RenderResult> | null {
  const layer = ast.layers[index];
  if (layer === undefined) return null;
  const solo = single(ast, index);
  if (solo === null) return null;

  const key = `${String(seed)}|${String(ast.duration.value)}${ast.duration.unit}|${serializeLayer(layer)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  return remember(key, render(solo, { seed }));
}

/** Every layer of a sound, rendered, in source order. `null` where one failed. */
export async function renderLayers(
  ast: SoundAST,
  seed: number,
): Promise<readonly (RenderResult | null)[]> {
  return Promise.all(
    ast.layers.map((_, index) => {
      const pending = renderLayer(ast, index, seed);
      return pending === null ? Promise.resolve(null) : pending.catch(() => null);
    }),
  );
}

/* ------------------------------------------------------------------------- *
 * Bars
 * ------------------------------------------------------------------------- */

/**
 * A buffer reduced to `count` bar heights, each 0..1.
 *
 * Peak per bucket, not RMS. The gallery card is 44 bars wide for a 1.8-second
 * sound, so a bucket is 40 ms — long enough that RMS would flatten a click into
 * nothing and show an empty card for a sound that is *only* a click.
 *
 * Normalized against the buffer's own peak so a quiet recipe is still legible;
 * the actual level is a number elsewhere on the same card, and a picture that
 * shows nothing is not a more honest picture.
 */
export function bars(buffer: AudioBuffer, count: number): Float32Array {
  const samples = buffer.getChannelData(0);
  const out = new Float32Array(count);
  let peak = 0;

  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * samples.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / count));
    let max = 0;
    for (let s = from; s < to && s < samples.length; s++) {
      const abs = Math.abs(samples[s] ?? 0);
      if (abs > max) max = abs;
    }
    out[i] = max;
    if (max > peak) peak = max;
  }

  if (peak > 0) for (let i = 0; i < count; i++) out[i] = (out[i] ?? 0) / peak;
  return out;
}

/**
 * Bars for a sound nobody has rendered yet.
 *
 * Used for the empty state and for a card whose render has not landed, and shaped
 * like a decaying burst so it reads as "a sound goes here" rather than as data.
 * Deterministic in `key`, so a card does not reshuffle itself on every repaint.
 */
export function ghostBars(key: string, count: number): Float32Array {
  let state = 2166136261;
  for (let i = 0; i < key.length; i++) {
    state ^= key.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    state = Math.imul(state ^ (state >>> 15), 2246822507);
    const noise = ((state >>> 8) & 0xffff) / 0xffff;
    const t = i / Math.max(1, count - 1);
    out[i] = Math.max(0.04, Math.exp(-2.6 * t) * (0.45 + 0.55 * noise));
  }
  return out;
}
