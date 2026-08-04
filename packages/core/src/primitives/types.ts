/**
 * The contract every primitive and effect implements.
 *
 * Nothing here touches an `AudioContext`. A builder receives the layer's
 * arguments and an {@link IRBuilder}, emits nodes into it, and returns the id of
 * its output node. Whether those nodes become live `AudioNode`s or a string of
 * exported JavaScript is decided later, by the backend — see `compile/ir.ts`.
 *
 * Types live in their own module so that each primitive file can import the
 * contract without importing the registry that collects them.
 *
 * @packageDocumentation
 */

import type { NodeArgs, Signature } from '@txt2sfx/shared';
import type { IRBuilder } from '../compile/ir.js';

/**
 * Everything a builder needs to know about the layer it is building.
 *
 * `start` and `stop` come from the envelope, in seconds relative to the sound's
 * onset: a source is alive exactly as long as its amplitude contour is. Sources
 * whose length is their own business — a 2 ms click, a modal ring that has died
 * out — may stop earlier, never later.
 */
export interface BuildContext {
  /** Graph under construction. */
  readonly ir: IRBuilder;
  /**
   * Seed for this layer's stochastic buffers. Derived from the render seed and
   * the layer index, so two noise layers in one sound are decorrelated but both
   * are reproducible.
   */
  readonly seed: number;
  /** Voice start, in seconds relative to the sound onset. */
  readonly start: number;
  /** Voice end, in seconds relative to the sound onset. */
  readonly stop: number;
}

/** A sound source: the word that opens a layer. */
export interface PrimitiveDef {
  /** Imported from `grammar/signatures.ts` — never restated. */
  readonly signature: Signature;
  /** Emit the source; returns the id of its output node. */
  build(args: NodeArgs, ctx: BuildContext): number;
}

/** A processing stage: a word after `>>`. */
export interface EffectDef {
  /** Imported from `grammar/signatures.ts` — never restated. */
  readonly signature: Signature;
  /** Wrap `input`; returns the id of the new output node. */
  build(input: number, args: NodeArgs, ctx: BuildContext): number;
  /**
   * How long the effect keeps sounding after its input goes silent, in
   * milliseconds.
   *
   * This is what makes `delay` and `verb` tails count against the header's
   * duration contract: the signal order is `source -> envelope -> chain`, so a
   * tail outlives the decay by design and the renderer has to allocate for it.
   */
  tailMs(args: NodeArgs): number;
}
