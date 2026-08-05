/**
 * `grains <freq> [rate] [width] [spread] [jitter]` — a field of short events.
 *
 * The gap this fills is structural rather than a matter of tuning. `noise` is
 * stationary and `chirp` is a single sweep, so nothing in the other eight
 * primitives produces a **dense scatter of individual events** — and water, rain,
 * gravel, fire, boiling and crowds are all exactly that. Measured against a
 * water-splash recording, a recipe built from four filtered noise layers converges
 * to a spectral flatness of about 0.42 where the reference sits at 0.58, and the
 * optimizer reports a true stall: the numbers are exhausted and the residual is the
 * missing shape.
 *
 * The buffer spans the whole voice, like `noise`, so playback never wraps: a short
 * looping grain field would put a periodicity at the loop point, and the analyzer
 * would read that as a spectral peak — a fake pitch in a sound that has none.
 *
 * See `compile/buffers.ts` for what one grain is (a damped sine with a slight
 * upward glide, Minnaert's bubble) and why the field normalizes to unit peak
 * instead of getting louder with density.
 *
 * @packageDocumentation
 */

import { numberOf, voiceSeconds } from './args.js';
import { primitiveSignature } from './signature.js';
import type { PrimitiveDef } from './types.js';

const signature = primitiveSignature('grains');

/** Water, rain, gravel, fire — anything made of many small events. */
export const grains: PrimitiveDef = {
  signature,
  build(args, ctx) {
    const buffer = ctx.ir.buffer({
      kind: 'grains',
      freq: numberOf(args, signature, 'freq'),
      rate: numberOf(args, signature, 'rate'),
      width: numberOf(args, signature, 'width') / 1000,
      spread: numberOf(args, signature, 'spread'),
      jitter: numberOf(args, signature, 'jitter'),
      bend: numberOf(args, signature, 'bend'),
      seed: ctx.seed,
      sec: voiceSeconds(ctx),
    });
    return ctx.ir.player(buffer, true, ctx.start, ctx.stop);
  },
};
