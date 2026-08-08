/**
 * Unit handling for soundline literals.
 *
 * Numbers are stored exactly as written (`1.8kHz` stays 1.8 with unit `kHz`)
 * so that serialization is byte-identical to the source. Conversion to the
 * canonical unit — Hz, ms, linear gain — happens only when a consumer asks for
 * it, which keeps the round-trip lossless and the compiler unambiguous.
 *
 * @packageDocumentation
 */

import type { NumberLiteral, ParamKind, Unit } from '@txt2sfx/shared';

/** Units accepted for each parameter kind, in the order shown in errors. */
export const UNITS_FOR_KIND: Readonly<Record<ParamKind, readonly Unit[]>> = {
  freq: ['Hz', 'kHz'],
  time: ['ms', 's'],
  level: ['', 'dB'],
  ratio: [''],
  enum: [],
  list: [''],
};

/** Human/LLM-readable rendering of the accepted units, e.g. `Hz|kHz`. */
export function describeUnits(kind: ParamKind): string {
  const units = UNITS_FOR_KIND[kind].filter((u) => u !== '');
  return units.length > 0 ? units.join('|') : 'no unit';
}

/** Whether a unit is acceptable for a parameter kind. */
export function unitAllowed(kind: ParamKind, unit: Unit): boolean {
  return UNITS_FOR_KIND[kind].includes(unit);
}

/**
 * Units related to the canonical unit of their kind by a plain multiplication.
 *
 * `dB` and `s` are both "second units of their kind", but only one of them can be
 * rescaled: 1 s is 1000 ms whatever the value, while -6 dB is a *ratio* of the
 * value it applies to. That difference is why {@link convertUnit} converts one
 * and refuses the other rather than treating "same kind" as "interchangeable".
 */
const SCALE_TO_CANONICAL: Partial<Record<Unit, readonly [ParamKind, number]>> = {
  Hz: ['freq', 1],
  kHz: ['freq', 1000],
  ms: ['time', 1],
  s: ['time', 1000],
};

/**
 * Rewrite a value written in `from` so that it means the same thing read as `to`,
 * e.g. `1` in `s` becomes `1000` in `ms`.
 *
 * Returns `undefined` when no such rewriting exists — different kinds (`ms` into
 * `Hz`), or a logarithmic relation (`dB` into linear gain). The result is rounded
 * to writing precision because it lands back in the source text: an unrounded
 * `1.1kHz -> 1100.0000000000002Hz` would serialize into a recipe no human reads.
 */
export function convertUnit(value: number, from: Unit, to: Unit): number | undefined {
  if (from === to) return value;
  const source = SCALE_TO_CANONICAL[from];
  const target = SCALE_TO_CANONICAL[to];
  if (source === undefined || target === undefined || source[0] !== target[0]) return undefined;
  return roundLiteral((value * source[1]) / target[1]);
}

/** Frequency of a literal in hertz. */
export function toHz(lit: NumberLiteral): number {
  return lit.unit === 'kHz' ? lit.value * 1000 : lit.value;
}

/** Duration of a literal in milliseconds. */
export function toMs(lit: NumberLiteral): number {
  return lit.unit === 's' ? lit.value * 1000 : lit.value;
}

/** Level of a literal as a linear gain (`-6dB` becomes ~0.501). */
export function toLinear(lit: NumberLiteral): number {
  return lit.unit === 'dB' ? 10 ** (lit.value / 20) : lit.value;
}

/**
 * Value of a literal in the canonical unit of its parameter kind:
 * Hz for `freq`, ms for `time`, linear gain for `level`, as-written otherwise.
 */
export function canonicalValue(lit: NumberLiteral, kind: ParamKind): number {
  switch (kind) {
    case 'freq':
      return toHz(lit);
    case 'time':
      return toMs(lit);
    case 'level':
      return toLinear(lit);
    default:
      return lit.value;
  }
}

/**
 * Format a number the way the serializer writes it: shortest exact decimal,
 * never exponential notation (`1e-7` in a soundline would be unreadable and
 * would not survive a re-parse as a single number token).
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`cannot serialize non-finite number: ${String(n)}`);
  if (Number.isInteger(n)) return String(n);
  const s = String(n);
  if (!s.includes('e') && !s.includes('E')) return s;
  return n.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Round a value to the precision a soundline is written with.
 *
 * Anything that computes a number and puts it back into the source has to agree
 * on this, or the same value serializes two ways: a slider writing
 * `3218.7431640625Hz` turns a readable recipe into noise, and an optimizer that
 * searches at full float precision and *then* rounds ships a recipe that is not
 * the candidate it measured. The precision is capped at what the ear can tell
 * apart for the magnitude in question, so rounding is inaudible by construction.
 */
export function roundLiteral(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 100) return Math.round(value);
  if (abs >= 10) return Math.round(value * 10) / 10;
  if (abs >= 1) return Math.round(value * 100) / 100;
  return Math.round(value * 1000) / 1000;
}

/** Serialize a literal, including its optional `~value[min..max]` slot. */
export function formatLiteral(lit: NumberLiteral): string {
  const body = `${formatNumber(lit.value)}${lit.unit}`;
  if (lit.slot === undefined) return body;
  return `~${body}[${formatNumber(lit.slot.min)}..${formatNumber(lit.slot.max)}]`;
}
