/**
 * Shared body of the three biquad effects, `lp` / `hp` / `bp`.
 *
 * @packageDocumentation
 */

import type { IRFilterType } from '../../compile/ir.js';
import { numberOf, paramOf } from '../args.js';
import { effectSignature } from '../signature.js';
import type { EffectDef } from '../types.js';

/**
 * Build the {@link EffectDef} for one biquad response.
 *
 * The cutoff ramp is timed from the layer's own onset, so `lp 1200Hz -> 180Hz in
 * 700ms` inside a layer that starts 120 ms late sweeps across its own 700 ms, not
 * the sound's. A biquad adds no tail of its own — its ringing is part of the
 * signal it is filtering, not an extension of it.
 */
export function biquadEffect(name: string, filter: IRFilterType): EffectDef {
  const signature = effectSignature(name);
  return {
    signature,
    build(input, args, ctx) {
      const node = ctx.ir.filter(filter, paramOf(args, signature, 'freq', ctx.start), numberOf(args, signature, 'Q'));
      ctx.ir.connect(input, node);
      return node;
    },
    tailMs() {
      return 0;
    },
  };
}
