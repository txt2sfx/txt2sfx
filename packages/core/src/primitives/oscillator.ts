/**
 * Shared oscillator body behind `tone`, `chirp` and `sub`.
 *
 * The three differ only in what the grammar lets you write — `chirp` defaults to
 * a saw and expects a ramp, `sub` has no waveform at all — so they share one
 * builder rather than three copies of the same four lines.
 *
 * @packageDocumentation
 */

import type { NodeArgs, Signature } from '@txt2sfx/shared';
import type { IROscWave } from '../compile/ir.js';
import { paramOf } from './args.js';
import type { BuildContext } from './types.js';

/** soundline waveform names mapped to Web Audio's `OscillatorType`. */
export const WAVE_MAP: Readonly<Record<string, IROscWave>> = {
  sine: 'sine',
  tri: 'triangle',
  saw: 'sawtooth',
  square: 'square',
};

/**
 * Emit a single oscillator whose frequency follows the layer's `freq` argument,
 * ramps included.
 *
 * @param forcedWave - Set for primitives with no `wave` parameter (`sub`).
 */
export function buildOscillator(
  sig: Signature,
  args: NodeArgs,
  ctx: BuildContext,
  forcedWave?: IROscWave,
): number {
  const wave = forcedWave ?? WAVE_MAP[enumWave(sig, args)] ?? 'sine';
  const freq = paramOf(args, sig, 'freq', ctx.start);
  return ctx.ir.osc(wave, freq, ctx.start, ctx.stop);
}

function enumWave(sig: Signature, args: NodeArgs): string {
  const arg = args['wave'];
  if (arg !== undefined && arg.kind === 'enum') return arg.value;
  const spec = sig.params.find((p) => p.name === 'wave');
  return typeof spec?.default === 'string' ? spec.default : 'sine';
}
