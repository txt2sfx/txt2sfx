/**
 * `dist <drive> [mix]` — waveshaper.
 *
 * @packageDocumentation
 */

import { numberOf } from '../args.js';
import { effectSignature } from '../signature.js';
import type { EffectDef } from '../types.js';
import { wetDry } from './mix.js';

const signature = effectSignature('dist');

/** Adds harmonics and glues transients; also raises perceived loudness. */
export const dist: EffectDef = {
  signature,
  build(input, args, ctx) {
    const drive = numberOf(args, signature, 'drive');
    const mix = numberOf(args, signature, 'mix');
    return wetDry(ctx.ir, input, mix, (wetIn) => {
      const shaper = ctx.ir.shaper(drive);
      ctx.ir.connect(wetIn, shaper);
      return shaper;
    });
  },
  tailMs() {
    return 0;
  },
};
