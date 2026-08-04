/**
 * Dry/wet blending, shared by `dist`, `delay` and `verb`.
 *
 * The two extremes are handled by *not building* the split: at `mix 0` the
 * effect is a no-op and the dry signal is returned untouched, at `mix 1` the wet
 * path is returned with no summing bus. Both cases are common — `mix 1` is how
 * the helicopter example turns a delay into the sound itself — and each avoided
 * node is three nodes' worth of bytes out of the export.
 *
 * @packageDocumentation
 */

import { constantParam, type IRBuilder } from '../../compile/ir.js';

/**
 * Blend a wet path against the dry input.
 *
 * @param buildWet - Called with the input node id; must return the wet output.
 *   Passed as a callback so that at `mix 0` the wet nodes are never created.
 */
export function wetDry(
  ir: IRBuilder,
  input: number,
  mix: number,
  buildWet: (input: number) => number,
): number {
  if (mix <= 0) return input;
  const wet = buildWet(input);
  if (mix >= 1) return wet;

  const bus = ir.gain(constantParam(1));
  const dryGain = ir.gain(constantParam(1 - mix));
  const wetGain = ir.gain(constantParam(mix));
  ir.connect(input, dryGain);
  ir.connect(dryGain, bus);
  ir.connect(wet, wetGain);
  ir.connect(wetGain, bus);
  return bus;
}
