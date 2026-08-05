/**
 * The search space: every `~value[min..max]` literal in a soundline.
 *
 * ## The candidate is text, not an AST
 *
 * The plan called for writing a vector of values back into the AST. This writes
 * it into the source string instead, at each literal's own span, and re-parses.
 * Three reasons, in order of how much they matter:
 *
 * 1. **The measured candidate is the shipped candidate.** A soundline is written
 *    at the precision `roundLiteral` allows. An optimizer that searched at full
 *    float precision and rounded only at the end would ship a recipe that is not
 *    the one it scored — the winner would be a number nobody ever rendered.
 *    Rounding on the way in makes the search space exactly the set of recipes
 *    that can be written down.
 * 2. **It costs nothing.** A parse is microseconds; the render it feeds is
 *    milliseconds. Parsing per candidate is noise next to the audio.
 * 3. **There is no second tree-rewriting code path to keep correct.** Rebuilding
 *    a `SoundAST` with substituted literals means touching every readonly node
 *    type, and a bug there produces a valid-looking AST that says something other
 *    than the text it came from.
 *
 * ## Why the search happens in a unit cube
 *
 * Positions are 0..1 and map to values through the same logarithmic curve the
 * playground's sliders use. Frequency and time are perceived as ratios: on a
 * linear `[500..8000]` Hz axis, every value below 1 kHz lives in the first 7 % of
 * the interval, so a population sampled uniformly would put almost nothing in the
 * range where most SFX energy actually sits.
 *
 * @packageDocumentation
 */

import type { ArgValue, Loc, NodeArgs, NumberLiteral, SoundAST, Unit } from '@txt2sfx/shared';
import { formatNumber, roundLiteral } from '@txt2sfx/core';

/** One optimizable number. */
export interface Slot {
  /** Structural identity, stable across value edits: `L0.src.freq.head`. */
  readonly id: string;
  /** Layer name, or `null` for the header's duration. */
  readonly layer: string | null;
  /** What it controls, e.g. `bp freq` or `env decay`. */
  readonly label: string;
  readonly unit: Unit;
  /** The value written in the source — the optimizer's seed. */
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** Span of the number token, without the `~` or the `[min..max]`. */
  readonly loc: Loc;
}

/**
 * Every slot in a sound, in source order.
 *
 * Ramp targets and ramp times are included — a sweep's destination and its
 * duration are exactly the kind of number a model is unsure about — as is the
 * header duration, which is why `layer` is nullable.
 */
export function collectSlots(ast: SoundAST): Slot[] {
  const slots: Slot[] = [];

  const push = (id: string, layer: string | null, label: string, lit: NumberLiteral): void => {
    if (lit.slot === undefined) return;
    slots.push({
      id,
      layer,
      label,
      unit: lit.unit,
      value: lit.value,
      min: lit.slot.min,
      max: lit.slot.max,
      loc: lit.loc,
    });
  };

  const walkArg = (id: string, layer: string | null, label: string, arg: ArgValue): void => {
    if (arg.kind !== 'number') return;
    push(`${id}.head`, layer, label, arg.head);
    arg.ramp.forEach((segment, i) => {
      const step = arg.ramp.length > 1 ? ` ${String(i + 1)}` : '';
      push(`${id}.ramp${String(i)}.to`, layer, `${label} ->${step}`, segment.to);
      push(`${id}.ramp${String(i)}.in`, layer, `${label} in${step}`, segment.time);
    });
  };

  const walkArgs = (id: string, layer: string | null, owner: string, args: NodeArgs): void => {
    for (const [name, arg] of Object.entries(args)) {
      walkArg(`${id}.${name}`, layer, `${owner} ${name}`, arg);
    }
  };

  push('duration', null, 'duration', ast.duration);

  ast.layers.forEach((layer, index) => {
    const base = `L${String(index)}`;
    walkArgs(`${base}.src`, layer.name, layer.source.name, layer.source.args);
    layer.chain.forEach((effect, i) => {
      walkArgs(`${base}.fx${String(i)}`, layer.name, effect.name, effect.args);
    });
    walkArgs(`${base}.env`, layer.name, 'env', layer.envelope.args);
  });

  return slots.sort((a, b) => a.loc.offset - b.loc.offset);
}

/**
 * Whether a slot's axis is logarithmic.
 *
 * Frequencies and times are ratios to the ear; gains, Q and other dimensionless
 * ratios are not. A degenerate range (`min <= 0`) falls back to linear because
 * the log map is undefined there.
 */
function isLogarithmic(slot: Slot): boolean {
  const perceptual = slot.unit === 'Hz' || slot.unit === 'kHz' || slot.unit === 'ms' || slot.unit === 's';
  return perceptual && slot.min > 0;
}

/** Position in 0..1 to a value in the literal's own unit, rounded as written. */
export function positionToValue(slot: Slot, position: number): number {
  const t = position < 0 ? 0 : position > 1 ? 1 : position;
  if (slot.max === slot.min) return roundLiteral(slot.min);
  if (!isLogarithmic(slot)) return roundLiteral(slot.min + (slot.max - slot.min) * t);
  return roundLiteral(slot.min * Math.pow(slot.max / slot.min, t));
}

/** A value in the literal's unit to its position in 0..1. */
export function valueToPosition(slot: Slot, value: number): number {
  const clamped = Math.min(slot.max, Math.max(slot.min, value));
  if (slot.max === slot.min) return 0;
  if (!isLogarithmic(slot)) return (clamped - slot.min) / (slot.max - slot.min);
  return Math.log(clamped / slot.min) / Math.log(slot.max / slot.min);
}

/** Where the recipe already sits in the search space — the optimizer's seed. */
export function seedVector(slots: readonly Slot[]): number[] {
  return slots.map((slot) => valueToPosition(slot, slot.value));
}

/**
 * Write a whole vector of positions into the source text.
 *
 * Edits are applied from the last span to the first. Every earlier offset then
 * still refers to the same character it did when the slots were collected, which
 * is what lets a whole vector be applied against one parse instead of re-parsing
 * between every edit.
 */
export function applyVector(source: string, slots: readonly Slot[], positions: readonly number[]): string {
  const ordered = slots
    .map((slot, index) => ({ slot, position: positions[index] ?? valueToPosition(slot, slot.value) }))
    .sort((a, b) => b.slot.loc.offset - a.slot.loc.offset);

  let out = source;
  for (const { slot, position } of ordered) {
    const text = `${formatNumber(positionToValue(slot, position))}${slot.unit}`;
    out = out.slice(0, slot.loc.offset) + text + out.slice(slot.loc.offset + slot.loc.length);
  }
  return out;
}
