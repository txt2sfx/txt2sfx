/**
 * How long a sound actually lasts, as opposed to how long its header claims.
 *
 * The signal order is `source -> envelope -> chain -> mix`, so a `delay` or
 * `verb` in the chain keeps sounding after the envelope has closed. Three
 * consumers need that number: the renderer, to allocate a buffer that contains
 * the whole sound; the phase-3 validator, to hold the header's duration contract
 * to the truth; and the phase-4 optimizer, to compare candidates over the same
 * span.
 *
 * @packageDocumentation
 */

import type { LayerNode, SoundAST } from '@txt2sfx/shared';
import { toMs } from '../grammar/units.js';
import { effectDef } from '../primitives/index.js';
import { envelopeTiming } from './envelope.js';

/** Extra time one effect keeps sounding after its input goes silent, in ms. */
export function effectTailMs(name: string, args: LayerNode['chain'][number]['args']): number {
  return effectDef(name).tailMs(args);
}

/**
 * Total tail of a layer's chain, in milliseconds.
 *
 * Tails add up along the chain: a delay feeding a reverb hands the reverb
 * something to work with well after the envelope closed.
 */
export function layerTailMs(layer: LayerNode): number {
  return layer.chain.reduce((total, effect) => total + effectTailMs(effect.name, effect.args), 0);
}

/** When a layer finally goes quiet, in milliseconds after the sound's onset. */
export function layerEndMs(layer: LayerNode): number {
  return envelopeTiming(layer.envelope).endSec * 1000 + layerTailMs(layer);
}

/** The header's duration contract, in milliseconds. */
export function declaredDurationMs(ast: SoundAST): number {
  return toMs(ast.duration);
}

/** When the whole sound goes quiet, in milliseconds. */
export function soundDurationMs(ast: SoundAST): number {
  return ast.layers.reduce((longest, layer) => Math.max(longest, layerEndMs(layer)), 0);
}
