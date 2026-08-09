/**
 * One button that answers "what else could this be?".
 *
 * A recipe's `~value[min..max]` slots are the author's own statement of where a
 * number may go without the sound stopping being itself. Rolling all of them at
 * once is therefore not a random mutation — it is a sample from the space the
 * recipe already declared, which is why this needs neither a model nor a bank
 * and why it cannot produce something the optimizer would refuse to consider.
 *
 * ## Why it reuses the optimizer's own machinery
 *
 * `collectSlots` and `applyVector` are the search space the fit runs in. Drawing
 * a vector and writing it back through the same two functions makes a variation
 * literally one point of that space, sampled instead of searched: the logarithmic
 * curve, the writing precision and the "candidate is text" property all come for
 * free, and there is no second definition of what a slot is to drift apart.
 *
 * ## Why the randomness is seeded
 *
 * A variation is a candidate a user may want back after trying two more. A seeded
 * generator makes "that one" reproducible from a single number, where
 * `Math.random()` inside the loop would make each result unrecoverable the moment
 * it is replaced.
 *
 * @packageDocumentation
 */

import { parseWithDiagnostics } from '@txt2sfx/core';
import { applyVector, collectSlots } from '@txt2sfx/optimizer';

/**
 * A small deterministic generator.
 *
 * Marsaglia's 32-bit xorshift (`Xorshift RNGs`, 2003) with his 13/17/5 triple:
 * three lines, no dependency, and far better distributed than the `sin`-based
 * one-liners that circulate for this job. Zero is the sequence's fixed point, so
 * a zero seed is replaced by the golden-ratio constant rather than returning a
 * stream of zeroes.
 */
function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/**
 * Re-roll every `~slot` inside its own range, deterministically from `seed`.
 *
 * Returns the input unchanged when the recipe has no slots — or does not parse,
 * which is the same statement: text that is not a recipe has no search space.
 */
export function vary(source: string, seed: number): string {
  const { ast } = parseWithDiagnostics(source);
  if (ast === null) return source;
  const slots = collectSlots(ast);
  if (slots.length === 0) return source;
  const random = xorshift32(seed);
  return applyVector(
    source,
    slots,
    slots.map(() => random()),
  );
}
