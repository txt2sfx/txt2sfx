/**
 * `modal [material] <freq> [ratios] [Q]` — a bank of inharmonic partials.
 *
 * How metal, wood and glass ring: a struck body vibrates at a set of modes whose
 * frequencies are *not* integer multiples of a fundamental, and it is that
 * inharmonicity, far more than the spectrum's overall shape, that tells a
 * listener what the object is made of. The material presets below are the ratios
 * commonly used for each; `ratios` overrides them when a specific object is
 * wanted.
 *
 * @packageDocumentation
 */

import { listOf, numberOf, voiceSeconds } from './args.js';
import { enumOf } from './args.js';
import { primitiveSignature } from './signature.js';
import type { PrimitiveDef } from './types.js';

const signature = primitiveSignature('modal');

/**
 * Partial ratios per material.
 *
 * Three modes each: enough to place a material, few enough to stay cheap. The
 * grammar accepts up to five through `ratios`.
 */
export const MATERIAL_RATIOS: Readonly<Record<string, readonly number[]>> = {
  metal: [1, 2.41, 3.86],
  wood: [1, 2.57, 4.94],
  glass: [1, 2.76, 5.4],
  membrane: [1, 1.59, 2.14],
};

/** Struck bodies: bells, blades, planks, panes, drum heads. */
export const modal: PrimitiveDef = {
  signature,
  build(args, ctx) {
    const material = enumOf(args, signature, 'material');
    const freq = numberOf(args, signature, 'freq');
    const q = numberOf(args, signature, 'Q');
    const ratios = listOf(args, signature, 'ratios') ?? MATERIAL_RATIOS[material] ?? MATERIAL_RATIOS['metal'];
    if (ratios === undefined) throw new Error(`modal has no ratios for material '${material}'`);

    // The fundamental rings longest: with a fixed Q the decay constant is
    // Q / (pi * f), so higher partials die first. Ten of those is -87 dB.
    const tau = q / (Math.PI * freq);
    const sec = Math.min(voiceSeconds(ctx), 10 * tau + 0.01);
    const buffer = ctx.ir.buffer({ kind: 'modal', freq, ratios, q, sec });
    return ctx.ir.player(buffer, false, ctx.start, ctx.stop);
  },
};
