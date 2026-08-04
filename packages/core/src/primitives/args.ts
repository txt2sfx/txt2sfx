/**
 * Reading arguments out of an AST node against its signature.
 *
 * The parser puts only the arguments that were *written* into the AST — that is
 * what keeps `serialize(parse(src))` byte-identical. Defaults therefore have to
 * be applied somewhere, and this is that somewhere: every primitive and effect
 * asks for a parameter by name and gets either the written value or the default
 * declared in `grammar/signatures.ts`. Nothing restates a parameter list.
 *
 * @packageDocumentation
 */

import type { NodeArgs, ParamSpec, Signature } from '@txt2sfx/shared';
import { canonicalValue, toMs } from '../grammar/units.js';
import { constantParam, safeExpTarget, type IRParam, type IRParamEvent } from '../compile/ir.js';
import type { BuildContext } from './types.js';

function specOf(sig: Signature, name: string): ParamSpec {
  const spec = sig.params.find((p) => p.name === name);
  if (spec === undefined) {
    throw new Error(`${sig.name} has no parameter '${name}' — primitives must match their signature`);
  }
  return spec;
}

/**
 * Numeric value of a parameter in its canonical unit (Hz, ms, linear gain),
 * falling back to the signature default.
 *
 * Only the head value is read; use {@link paramOf} when a ramp matters.
 */
export function numberOf(args: NodeArgs, sig: Signature, name: string): number {
  const spec = specOf(sig, name);
  const arg = args[name];
  if (arg !== undefined && arg.kind === 'number') return canonicalValue(arg.head, spec.kind);
  if (typeof spec.default === 'number') return spec.default;
  throw new Error(`${sig.name}.${name} was omitted and has no default`);
}

/** Enum value of a parameter, falling back to the signature default. */
export function enumOf(args: NodeArgs, sig: Signature, name: string): string {
  const spec = specOf(sig, name);
  const arg = args[name];
  if (arg !== undefined && arg.kind === 'enum') return arg.value;
  if (typeof spec.default === 'string') return spec.default;
  throw new Error(`${sig.name}.${name} was omitted and has no default`);
}

/** List value of a parameter, or `undefined` when it was not written. */
export function listOf(args: NodeArgs, sig: Signature, name: string): readonly number[] | undefined {
  specOf(sig, name);
  const arg = args[name];
  if (arg !== undefined && arg.kind === 'list') return arg.values;
  return undefined;
}

/**
 * Full trajectory of a parameter as {@link IRParam}.
 *
 * @param startSec - When the layer's voice begins; every event is offset by it,
 *   because a ramp written in a soundline is relative to that layer's onset, not
 *   to the sound's.
 * @param scale - Multiplies every value. Used by `fm`, where the soundline
 *   writes a modulation *index* but the graph needs a frequency deviation.
 */
export function paramOf(
  args: NodeArgs,
  sig: Signature,
  name: string,
  startSec: number,
  scale = 1,
): IRParam {
  const spec = specOf(sig, name);
  const arg = args[name];
  if (arg === undefined || arg.kind !== 'number') {
    return constantParam(numberOf(args, sig, name) * scale);
  }

  const events: IRParamEvent[] = [{ type: 'set', value: canonicalValue(arg.head, spec.kind) * scale, at: startSec }];
  let at = startSec;
  for (const segment of arg.ramp) {
    at += toMs(segment.time) / 1000;
    events.push({
      type: segment.curve === 'lin' ? 'lin' : 'exp',
      value: canonicalValue(segment.to, spec.kind) * scale,
      at,
    });
  }

  // An exponential ramp is illegal if either end sits at zero, and the model
  // does write `-> 0` (a pitch drop to nothing, an FM index fading out). Clamp
  // both ends rather than reject: the intent is audible, the literal zero is not.
  for (let i = 1; i < events.length; i++) {
    const event = events[i];
    const previous = events[i - 1];
    if (event === undefined || previous === undefined || event.type !== 'exp') continue;
    events[i] = { ...event, value: safeExpTarget(event.value) };
    events[i - 1] = { ...previous, value: safeExpTarget(previous.value) };
  }
  return { events };
}

/**
 * Length of a layer's voice in seconds, clamped to a usable buffer size.
 *
 * Buffer-backed primitives size their sample table from this. The lower clamp
 * keeps a degenerate 0 ms envelope from asking for an empty buffer; the upper one
 * caps memory for a layer that declares a multi-second decay.
 */
export function voiceSeconds(ctx: BuildContext, maxSec = 5): number {
  return Math.min(Math.max(ctx.stop - ctx.start, 0.01), maxSec);
}

/** Whether an argument was written explicitly (as opposed to defaulted). */
export function wasWritten(args: NodeArgs, name: string): boolean {
  return args[name] !== undefined;
}

/**
 * Total time a parameter's ramp takes, in milliseconds.
 *
 * The phase-3 validator uses this for the anti-"pew" rule: a 120 ms frequency
 * sweep on something labelled `pop` is not a pop.
 */
export function rampSpanMs(args: NodeArgs, name: string): number {
  const arg = args[name];
  if (arg === undefined || arg.kind !== 'number') return 0;
  return arg.ramp.reduce((total, segment) => total + toMs(segment.time), 0);
}
