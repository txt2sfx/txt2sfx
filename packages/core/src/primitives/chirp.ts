/**
 * `chirp [wave] <freq> -> <freq> in <time>` — a fast frequency sweep.
 *
 * Mechanically the same oscillator as `tone`; it exists as its own word because
 * a sweep and a steady note are different intentions, and because naming the
 * intention lets the validator hold sweeps to category-specific limits. A chirp
 * without a ramp is just a saw tone — legal, and the grammar's own doc string
 * says so.
 *
 * @packageDocumentation
 */

import { buildOscillator } from './oscillator.js';
import { primitiveSignature } from './signature.js';
import type { PrimitiveDef } from './types.js';

const signature = primitiveSignature('chirp');

/** Lasers, zaps, whooshes. */
export const chirp: PrimitiveDef = {
  signature,
  build(args, ctx) {
    return buildOscillator(signature, args, ctx);
  },
};
