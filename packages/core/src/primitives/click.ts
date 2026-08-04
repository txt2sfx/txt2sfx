/**
 * `click <width>` — a single transient.
 *
 * The voice is only as long as the impulse, however long the envelope claims:
 * a click has no sustain to shape, so holding the source open past its width
 * would just extend silence. See `compile/buffers.ts` for why the impulse is a
 * windowed noise burst rather than a Dirac or a raised bump.
 *
 * @packageDocumentation
 */

import { numberOf } from './args.js';
import { primitiveSignature } from './signature.js';
import type { PrimitiveDef } from './types.js';

const signature = primitiveSignature('click');

/** Pure transient, no pitch of its own. */
export const click: PrimitiveDef = {
  signature,
  build(args, ctx) {
    const sec = numberOf(args, signature, 'width') / 1000;
    const buffer = ctx.ir.buffer({ kind: 'burst', seed: ctx.seed, sec });
    return ctx.ir.player(buffer, false, ctx.start, Math.min(ctx.stop, ctx.start + sec));
  },
};
