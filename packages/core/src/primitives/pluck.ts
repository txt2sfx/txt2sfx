/**
 * `pluck <freq> [damp] [bright]` — Karplus-Strong plucked string.
 *
 * @packageDocumentation
 */

import { numberOf, voiceSeconds } from './args.js';
import { primitiveSignature } from './signature.js';
import type { PrimitiveDef } from './types.js';

const signature = primitiveSignature('pluck');

/**
 * Amplitude time constant a `damp` value produces, in seconds.
 *
 * Kept in step with `fillPluck` in `compile/buffers.ts`; it is the same mapping,
 * needed here to size the buffer to the point where the string has actually
 * stopped ringing.
 */
function tauFor(damp: number): number {
  return 0.02 + 0.6 * (1 - damp);
}

/** A struck or plucked string: harp, koto, the tail of an arcade jingle. */
export const pluck: PrimitiveDef = {
  signature,
  build(args, ctx) {
    const freq = numberOf(args, signature, 'freq');
    const damp = numberOf(args, signature, 'damp');
    const bright = numberOf(args, signature, 'bright');
    // Eight time constants is -70 dB: past that the string is silence, and
    // generating it would only cost samples.
    const sec = Math.min(voiceSeconds(ctx), 8 * tauFor(damp));
    const buffer = ctx.ir.buffer({ kind: 'pluck', freq, damp, bright, seed: ctx.seed, sec });
    return ctx.ir.player(buffer, false, ctx.start, ctx.stop);
  },
};
