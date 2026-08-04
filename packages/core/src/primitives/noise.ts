/**
 * `noise <color>` — broadband noise.
 *
 * The buffer is sized to the layer's whole voice, so playback never wraps and
 * the loop flag is only a safety net against rounding. That matters more than
 * memory: a short looping noise buffer has a periodicity at the loop point that
 * the analyzer would happily report as a spectral peak.
 *
 * @packageDocumentation
 */

import type { IRNoiseColor } from '../compile/ir.js';
import { enumOf, voiceSeconds } from './args.js';
import { primitiveSignature } from './signature.js';
import type { PrimitiveDef } from './types.js';

const signature = primitiveSignature('noise');

/** The texture behind crunches, blasts and hiss. */
export const noise: PrimitiveDef = {
  signature,
  build(args, ctx) {
    const color = enumOf(args, signature, 'color') as IRNoiseColor;
    const buffer = ctx.ir.buffer({ kind: 'noise', color, seed: ctx.seed, sec: voiceSeconds(ctx) });
    return ctx.ir.player(buffer, true, ctx.start, ctx.stop);
  },
};
