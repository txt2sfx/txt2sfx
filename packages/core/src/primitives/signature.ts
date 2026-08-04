/**
 * Strict lookups into the signature table.
 *
 * `PRIMITIVES['tone']` is `Signature | undefined` under
 * `noUncheckedIndexedAccess`, and every one of the fourteen builder modules
 * would otherwise open with the same three-line narrowing dance. A missing entry
 * here is a programming error, not user input, so it throws.
 *
 * @packageDocumentation
 */

import type { Signature } from '@txt2sfx/shared';
import { EFFECTS, ENVELOPE, PRIMITIVES } from '../grammar/signatures.js';

/** Signature of a primitive, by the word that opens a layer. */
export function primitiveSignature(name: string): Signature {
  const sig = PRIMITIVES[name];
  if (sig === undefined) throw new Error(`grammar/signatures.ts has no primitive '${name}'`);
  return sig;
}

/** Signature of an effect, by the word that follows `>>`. */
export function effectSignature(name: string): Signature {
  const sig = EFFECTS[name];
  if (sig === undefined) throw new Error(`grammar/signatures.ts has no effect '${name}'`);
  return sig;
}

/** Signature of the `| ...` envelope section. */
export const envelopeSignature: Signature = ENVELOPE;
