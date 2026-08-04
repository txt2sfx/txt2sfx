/**
 * `lp <freq> [Q]` — low-pass biquad.
 *
 * @packageDocumentation
 */

import { biquadEffect } from './filter.js';
import type { EffectDef } from '../types.js';

/** Removes air; ramp it down to make a sound recede. */
export const lp: EffectDef = biquadEffect('lp', 'lowpass');
