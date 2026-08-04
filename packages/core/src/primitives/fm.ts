/**
 * `fm <freq> [ratio] [index]` — two-operator FM.
 *
 * A modulator sine drives the carrier's frequency. What a soundline writes is
 * the modulation *index*, the dimensionless quantity that actually predicts the
 * timbre: the carrier's frequency deviation is `index * modulatorFrequency`, so
 * an index of 3 sounds equally bright at 200 Hz and at 2 kHz, whereas a fixed
 * deviation in hertz would not. The conversion happens here, in the `scale`
 * argument to {@link paramOf}, which is also why ramping the index works — the
 * ramp is applied to the deviation with the same factor.
 *
 * @packageDocumentation
 */

import { constantParam } from '../compile/ir.js';
import { numberOf, paramOf } from './args.js';
import { primitiveSignature } from './signature.js';
import type { PrimitiveDef } from './types.js';

const signature = primitiveSignature('fm');

/** Bells, sparkle, grit — two oscillators pretending to be an orchestra. */
export const fm: PrimitiveDef = {
  signature,
  build(args, ctx) {
    const carrierHz = numberOf(args, signature, 'freq');
    const ratio = numberOf(args, signature, 'ratio');
    const modulatorHz = carrierHz * ratio;

    const carrier = ctx.ir.osc('sine', paramOf(args, signature, 'freq', ctx.start), ctx.start, ctx.stop);
    const modulator = ctx.ir.osc('sine', constantParam(modulatorHz), ctx.start, ctx.stop);
    const deviation = ctx.ir.gain(paramOf(args, signature, 'index', ctx.start, modulatorHz));

    ctx.ir.connect(modulator, deviation);
    ctx.ir.connect(deviation, { node: carrier, param: 'freq' });
    return carrier;
  },
};
