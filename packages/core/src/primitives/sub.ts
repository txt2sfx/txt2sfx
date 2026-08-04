/**
 * `sub <freq>` — low-frequency body thump.
 *
 * A sine, always: at 30-90 Hz every other waveform's harmonics land in the range
 * where they stop being "weight" and start being "buzz", and the point of a sub
 * layer is the part you feel. Fixing the waveform also keeps the layer honest —
 * a `sub` cannot quietly become the sound's midrange.
 *
 * @packageDocumentation
 */

import { buildOscillator } from './oscillator.js';
import { primitiveSignature } from './signature.js';
import type { PrimitiveDef } from './types.js';

const signature = primitiveSignature('sub');

/** The thump under an impact, a blast or a rotor chop. */
export const sub: PrimitiveDef = {
  signature,
  build(args, ctx) {
    return buildOscillator(signature, args, ctx, 'sine');
  },
};
