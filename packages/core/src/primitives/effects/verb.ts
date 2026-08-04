/**
 * `verb <time> [mix] [damp]` — short procedural reverb.
 *
 * A convolver against a generated noise impulse response. A feedback-delay
 * network would be cheaper to export, but it colours the tail with its own comb
 * structure, and the whole reason a sound effect gets reverb is to place it in a
 * space rather than to add a resonance. `ConvolverNode` normalizes its response,
 * so the wet level does not jump when `time` changes.
 *
 * @packageDocumentation
 */

import { numberOf } from '../args.js';
import { effectSignature } from '../signature.js';
import type { EffectDef } from '../types.js';
import { wetDry } from './mix.js';

const signature = effectSignature('verb');

/** Tail length is the tail: the response ends, so the estimate is exact. */
export const verb: EffectDef = {
  signature,
  build(input, args, ctx) {
    const sec = numberOf(args, signature, 'time') / 1000;
    const mix = numberOf(args, signature, 'mix');
    const damp = numberOf(args, signature, 'damp');

    return wetDry(ctx.ir, input, mix, (wetIn) => {
      const response = ctx.ir.buffer({ kind: 'verb', sec, damp, seed: ctx.seed });
      const node = ctx.ir.convolver(response);
      ctx.ir.connect(wetIn, node);
      return node;
    });
  },
  tailMs(args) {
    return numberOf(args, signature, 'time');
  },
};
