/**
 * The `| gain attack hold decay curve delay` section, turned into timing and a
 * gain trajectory.
 *
 * @packageDocumentation
 */

import type { EnvelopeNode } from '@txt2sfx/shared';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { ENVELOPE } from '../grammar/signatures.js';
import { enumOf, numberOf } from '../primitives/args.js';
import { EXP_EPSILON, type IRParam, type IRParamEvent } from './ir.js';

/** Resolved envelope, in seconds relative to the sound onset. */
export interface EnvelopeTiming {
  /** Peak linear gain. */
  readonly peak: number;
  readonly attackSec: number;
  readonly holdSec: number;
  readonly decaySec: number;
  readonly curve: 'exp' | 'lin';
  /** Layer onset — the envelope's `delay`. */
  readonly startSec: number;
  /** End of the decay; the source stops here. */
  readonly endSec: number;
}

/** Read an envelope, applying the signature's defaults. */
export function envelopeTiming(node: EnvelopeNode): EnvelopeTiming {
  const peak = numberOf(node.args, ENVELOPE, 'gain');
  const attackSec = numberOf(node.args, ENVELOPE, 'attack') / 1000;
  const holdSec = numberOf(node.args, ENVELOPE, 'hold') / 1000;
  const decaySec = numberOf(node.args, ENVELOPE, 'decay') / 1000;
  const startSec = numberOf(node.args, ENVELOPE, 'delay') / 1000;
  const curve = enumOf(node.args, ENVELOPE, 'curve') === 'lin' ? 'lin' : 'exp';
  return {
    peak,
    attackSec,
    holdSec,
    decaySec,
    curve,
    startSec,
    endSec: startSec + attackSec + holdSec + decaySec,
  };
}

/**
 * Floor an exponential decay may fall to.
 *
 * `GLOBAL_LIMITS.minExpTarget` is -60 dBFS — an absolute floor, not a relative
 * one, which is deliberate: a layer at `gain 0.06` reaching 0.001 is still
 * inaudible in the mix, and holding it to -60 dB *below its own peak* would make
 * quiet layers decay for longer than loud ones. The branch only exists for
 * layers quieter than the floor itself, where the ramp would otherwise rise.
 */
function decayFloor(peak: number): number {
  const floor = GLOBAL_LIMITS.minExpTarget;
  return peak > floor * 2 ? floor : Math.max(peak / 1000, EXP_EPSILON);
}

/**
 * Gain trajectory of an envelope.
 *
 * The attack is always a linear ramp, because an exponential one cannot start at
 * zero and an attack that starts anywhere else clicks. The decay defaults to
 * exponential because that is how physical energy dissipates; `curve lin` is
 * available and sounds synthetic, which is occasionally the point.
 */
export function envelopeParam(timing: EnvelopeTiming): IRParam {
  const { peak, attackSec, holdSec, decaySec, curve, startSec } = timing;
  const events: IRParamEvent[] = [];

  if (attackSec <= 0) {
    events.push({ type: 'set', value: peak, at: startSec });
  } else {
    events.push({ type: 'set', value: 0, at: startSec });
    events.push({ type: 'lin', value: peak, at: startSec + attackSec });
  }
  if (holdSec > 0) events.push({ type: 'set', value: peak, at: startSec + attackSec + holdSec });

  const end = startSec + attackSec + holdSec + decaySec;
  if (curve === 'lin') events.push({ type: 'lin', value: 0, at: end });
  else events.push({ type: 'exp', value: decayFloor(peak), at: end });

  return { events };
}
