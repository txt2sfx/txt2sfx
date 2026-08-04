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

/** Serialize a literal, including its optional `~value[min..max]` slot. */
export function formatLiteral(lit: NumberLiteral): string {
  const body = `${formatNumber(lit.value)}${lit.unit}`;
  if (lit.slot === undefined) return body;
  return `~${body}[${formatNumber(lit.slot.min)}..${formatNumber(lit.slot.max)}]`;
}
