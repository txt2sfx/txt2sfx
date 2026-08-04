/**
 * Text helpers shared by the code emitters.
 *
 * Kept separate from `codegen.ts` so that `buffers.ts` can format numbers
 * without importing the whole emitter (and creating a cycle).
 *
 * @packageDocumentation
 */

/**
 * Shortest exact JavaScript literal for a number.
 *
 * `String(n)` already round-trips exactly in JavaScript, so this only shaves
 * the redundant leading zero (`0.6` -> `.6`), which is worth a byte per
 * occurrence and there are hundreds of them in an export. Exponential notation
 * is left alone — `1e-6` is both valid and shorter than the decimal form.
 *
 * The value must already be quantized (see `quantizeIR`): this function never
 * rounds, because rounding here and not in the reference renderer is exactly
 * how the two backends would drift apart.
 */
export function num(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`cannot emit non-finite number: ${String(value)}`);
  }
  const text = String(value);
  if (text.startsWith('0.')) return text.slice(1);
  if (text.startsWith('-0.')) return `-${text.slice(2)}`;
  return text;
}

/** Format a list of numbers as a JavaScript array literal. */
export function numList(values: readonly number[]): string {
  return `[${values.map(num).join(',')}]`;
}
