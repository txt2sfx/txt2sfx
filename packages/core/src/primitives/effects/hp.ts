/**
 * `hp <freq> [Q]` — high-pass biquad.
 *
 * @packageDocumentation
 */

import { biquadEffect } from './filter.js';
import type { EffectDef } from '../types.js';

/** Removes weight; the standard way to thin a transient. */
export const hp: EffectDef = biquadEffect('hp', 'highpass');
