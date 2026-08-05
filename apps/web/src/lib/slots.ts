/**
 * Slot sliders: the `~value[min..max]` literals, turned into knobs.
 *
 * ## Why this edits text and not the AST
 *
 * A slider could mutate a copy of the AST and re-serialize it, but then the
 * editor would show the serializer's idea of the recipe rather than what the
 * author wrote. Instead every slider writes back into the source string at the
 * literal's own span, so the text in the editor stays the single source of truth
 * and comments, spacing and layer order survive untouched.
 *
 * The span to replace is `NumberLiteral.loc`, which covers the *number token
 * only* — `3200Hz` out of `~3200Hz[500..8000]`, because units are lexically part
 * of the number and the tilde and the range are separate tokens. So a slider
 * moves the value and leaves the optimizer's range exactly where the author put
 * it, which is what makes this safe to do on every mouse move.
 *
 * @packageDocumentation
 */

import type { ArgValue, Loc, NodeArgs, NumberLiteral, SoundAST, Unit } from '@txt2sfx/shared';
import { formatNumber, roundLiteral } from '@txt2sfx/core';

/** One optimizable value, ready to be bound to a range input. */
export interface Slot {
  /** Structural identity — stable across edits, unlike a source offset. */
  readonly id: string;
  /** Layer name, or `null` for the header's duration. */
  readonly layer: string | null;
  /** What the knob controls, e.g. `bp freq` or `gain decay`. */
  readonly label: string;
  readonly unit: Unit;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** Span of the number token in the source. */
  readonly loc: Loc;
}

/** Collect every slot in a sound, in source order. */
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
      push(`${id}.ramp${String(i)}.to`, layer, `${label} →${step}`, segment.to);
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
 * How many decimals to keep.
 *
 * Shared with the optimizer through `@txt2sfx/core`: both write computed numbers
 * back into a recipe, and two private copies of this table would eventually
 * disagree about how the same value is spelled.
 */
const round = roundLiteral;

/**
 * Whether the knob should travel logarithmically.
 *
 * Frequency and time are perceived on a log scale: on a linear `[500..8000]` Hz
 * slider the entire musically useful bottom octave lives in the first 5 % of the
 * travel, which makes tuning by ear impossible. Gains, Q and ratios stay linear.
 */
function isLogarithmic(slot: Slot): boolean {
  const perceptual = slot.unit === 'Hz' || slot.unit === 'kHz' || slot.unit === 'ms' || slot.unit === 's';
  return perceptual && slot.min > 0;
}

/** Slider position (0..1) -> value in the literal's unit. */
export function positionToValue(slot: Slot, position: number): number {
  const t = Math.min(1, Math.max(0, position));
  if (!isLogarithmic(slot)) return round(slot.min + (slot.max - slot.min) * t);
  return round(slot.min * Math.pow(slot.max / slot.min, t));
}

/** Value in the literal's unit -> slider position (0..1). */
export function valueToPosition(slot: Slot, value: number): number {
  const clamped = Math.min(slot.max, Math.max(slot.min, value));
  if (!isLogarithmic(slot)) return (clamped - slot.min) / (slot.max - slot.min);
  return Math.log(clamped / slot.min) / Math.log(slot.max / slot.min);
}

/**
 * Rewrite one slot's value in the source text.
 *
 * Only the number token is replaced, so `~` and `[min..max]` stay as written.
 * Offsets shift as soon as the replacement has a different length, which is why
 * callers must re-parse and re-collect after each call instead of applying two
 * edits against the same AST.
 */
export function applySlot(source: string, slot: Slot, value: number): string {
  const clamped = Math.min(slot.max, Math.max(slot.min, value));
  const text = `${formatNumber(round(clamped))}${slot.unit}`;
  return source.slice(0, slot.loc.offset) + text + source.slice(slot.loc.offset + slot.loc.length);
}
