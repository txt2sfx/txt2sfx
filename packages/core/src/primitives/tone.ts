/**
 * `tone <wave> <freq>` — a single oscillator.
 *
 * @packageDocumentation
 */

import { buildOscillator } from './oscillator.js';
import { primitiveSignature } from './signature.js';
import type { PrimitiveDef } from './types.js';

const signature = primitiveSignature('tone');

/** The tonal backbone of a layer: bodies, blips, hums. */
export const tone: PrimitiveDef = {
  signature,
  build(args, ctx) {
    return buildOscillator(signature, args, ctx);
  },
};
