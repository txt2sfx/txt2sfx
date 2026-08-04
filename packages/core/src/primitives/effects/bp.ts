/**
 * `bp <freq> [Q]` — band-pass biquad.
 *
 * @packageDocumentation
 */

import { biquadEffect } from './filter.js';
import type { EffectDef } from '../types.js';

/** Turns flat noise into a pitched-sounding snap. */
export const bp: EffectDef = biquadEffect('bp', 'bandpass');
