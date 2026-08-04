/**
 * `delay <time> [feedback] [mix]` — feedback delay.
 *
 * @packageDocumentation
 */

import { constantParam } from '../../compile/ir.js';
import { numberOf } from '../args.js';
import { effectSignature } from '../signature.js';
import type { EffectDef } from '../types.js';
import { wetDry } from './mix.js';

const signature = effectSignature('delay');

/**
 * Ceiling on the estimated tail, in milliseconds.
 *
 * At `feedback 0.95` a 90 ms delay technically rings for twelve seconds. Nobody
 * asking for a 1.5 s helicopter wants a twelve-second render, and the phase-3
 * validator will flag the overshoot against the header contract anyway — so the
 * estimate is capped and the truth is reported by the validator, not by an
 * enormous buffer.
 */
const MAX_TAIL_MS = 4000;

/** Short times and high feedback make this a resonator, not an echo. */
export const delay: EffectDef = {
  signature,
  build(input, args, ctx) {
    const timeSec = numberOf(args, signature, 'time') / 1000;
    const feedback = numberOf(args, signature, 'feedback');
    const mix = numberOf(args, signature, 'mix');

    return wetDry(ctx.ir, input, mix, (wetIn) => {
      const line = ctx.ir.delay(timeSec + 0.01, timeSec);
      ctx.ir.connect(wetIn, line);
      if (feedback > 0) {
        const loop = ctx.ir.gain(constantParam(feedback));
        ctx.ir.connect(line, loop);
        ctx.ir.connect(loop, line);
      }
      return line;
    });
  },
  tailMs(args) {
    const time = numberOf(args, signature, 'time');
    const feedback = numberOf(args, signature, 'feedback');
    if (feedback <= 0) return time;
    // Number of round trips until the echo has fallen 60 dB.
    const repeats = Math.log(0.001) / Math.log(Math.min(feedback, 0.999));
    return Math.min(time * repeats, MAX_TAIL_MS);
  },
};
