/**
 * `@txt2sfx/optimizer` — fitting a recipe's numbers to a target sound.
 *
 * This is the second half of the project's third principle: the language model
 * designs the topology — which layers, which primitives, which effects — and a
 * numerical search finds the numbers. {@link optimize} never changes structure.
 * It moves only the values the author marked with `~value[min..max]`, so its
 * output is always the same recipe, recognizably, with better numbers.
 *
 * ## What counts as better
 *
 * Fitness is the distance to the target, plus penalties:
 *
 * - A candidate that fails validation is **not rendered at all**. Spec-first,
 *   fail fast: a slot pushing a decay past its category limit produces a sound
 *   the project would refuse to emit, and rendering it to find out is a wasted
 *   millisecond per candidate.
 * - A candidate that clips is penalized past every clean one. The plan warned
 *   about this specifically: `explosion` has about 2 dB of headroom, and a search
 *   that is only told to match a spectrum will happily spend it.
 *
 * @example
 * ```ts
 * const result = await optimize({
 *   source,
 *   target: { profile: targetProfile, signal: targetSignal },
 *   render: (ast) => renderSignal(ast),
 * });
 * console.log(result.source);   // the improved soundline, ready to write out
 * ```
 *
 * @packageDocumentation
 */

import type { SoundAST, SoundProfile, ValidationIssue } from '@txt2sfx/shared';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { hasErrors, parse, validate } from '@txt2sfx/core';
import {
  extractProfile,
  profileDistance,
  soundDistance,
  type Signal,
} from '@txt2sfx/analyzer';
import { differentialEvolution, type DEResult, type GenerationReport, type Vector } from './de.js';
import { applyVector, collectSlots, positionToValue, seedVector, type Slot } from './slots.js';

export { DE_DEFAULTS, differentialEvolution } from './de.js';
export type { DEOptions, DEResult, Fitness, GenerationReport, Vector } from './de.js';

export {
  applyVector,
  collectSlots,
  positionToValue,
  seedVector,
  valueToPosition,
} from './slots.js';
export type { Slot } from './slots.js';

/**
 * What the candidate is being fitted to.
 *
 * `signal` is optional, and the difference is not cosmetic: with it the fitness
 * is {@link soundDistance}, which hears a partial in the wrong place; without it
 * only the profile fields can be compared. The recipe bank stores profiles and no
 * audio, so profile-only targets are the normal case for retrieval-driven work
 * and reference recordings are the case where the full metric applies.
 */
export interface Target {
  readonly profile: SoundProfile;
  readonly signal?: Signal;
}

/** How a candidate becomes audio. Injected — the optimizer owns no audio stack. */
export type RenderFn = (ast: SoundAST) => Promise<Signal> | Signal;

/** Options of {@link optimize}. */
export interface OptimizeOptions {
  /** The recipe to improve, as text. Its `~` slots are the search space. */
  readonly source: string;
  readonly target: Target;
  readonly render: RenderFn;
  readonly populationSize?: number;
  readonly generations?: number;
  readonly seed?: number;
  readonly targetFitness?: number;
  readonly stallGenerations?: number;
  /**
   * Reject candidates that fail validation without rendering them.
   *
   * Default true. Turn it off to measure how much the physical envelope is
   * costing a search, which is a debugging question, not a production one.
   */
  readonly respectValidator?: boolean;
  readonly onGeneration?: (report: GenerationReport) => void;
}

/** What a run produced. */
export interface OptimizeResult {
  /** The improved recipe, ready to write to a file or store in the bank. */
  readonly source: string;
  readonly ast: SoundAST;
  /** Distance to the target, penalties excluded — comparable across runs. */
  readonly distance: number;
  /** Fitness of the recipe as it arrived, for the improvement it represents. */
  readonly initialDistance: number;
  readonly slots: readonly Slot[];
  /** Final values, in each slot's own unit. */
  readonly values: readonly number[];
  readonly de: DEResult;
  /** Validation of the winner. Empty in the normal case. */
  readonly issues: readonly ValidationIssue[];
}

/**
 * Penalty for a candidate the validator rejects.
 *
 * Every distance is at most 1, so this puts an invalid candidate below every
 * valid one with room to spare. There is deliberately no gradient among invalid
 * candidates: the seed recipe is valid, so the population always contains a way
 * back, and a gradient through the invalid region would invite the search to
 * travel through it.
 */
const INVALID_PENALTY = 4;

/** Penalty for a candidate that clips. Ordered by distance, so it can improve. */
const CLIPPING_PENALTY = 2;

/**
 * Fit a recipe's slot values to a target.
 *
 * Returns the recipe unchanged when it has no slots — that is not a failure, it
 * is a recipe whose author left nothing to search, and the reported distance is
 * still the useful part of the answer.
 */
export async function optimize(options: OptimizeOptions): Promise<OptimizeResult> {
  const ast = parse(options.source);
  const slots = collectSlots(ast);
  const respectValidator = options.respectValidator ?? true;

  const distanceOf = async (candidate: SoundAST): Promise<{ distance: number; penalty: number }> => {
    if (respectValidator && hasErrors(validate(candidate))) {
      return { distance: 1, penalty: INVALID_PENALTY };
    }

    const signal = await options.render(candidate);
    const profile = extractProfile(signal);
    const distance =
      options.target.signal === undefined
        ? profileDistance(profile, options.target.profile)
        : soundDistance(
            { signal, profile },
            { signal: options.target.signal, profile: options.target.profile },
          );

    /* Peak is the invariant that cannot be read off the text (layers do not peak
       together, and a high-pass can push the peak above its input), so it is
       checked here, on the render, exactly as the validator's split expects. */
    let peak = 0;
    for (let i = 0; i < signal.samples.length; i++) {
      const abs = Math.abs(signal.samples[i] ?? 0);
      if (abs > peak) peak = abs;
    }
    const clipping = peak > GLOBAL_LIMITS.maxPeak ? CLIPPING_PENALTY : 0;

    return { distance, penalty: clipping };
  };

  const evaluate = async (positions: Vector): Promise<{ distance: number; total: number; ast: SoundAST }> => {
    const source = applyVector(options.source, slots, positions);
    let candidate: SoundAST;
    try {
      candidate = parse(source);
    } catch {
      /* A rounded value cannot make a soundline unparseable, but a caller may
         hand in slot bounds that serialize to something the lexer rejects, and
         losing a whole run to one bad coordinate would be worse than scoring it. */
      return { distance: 1, total: INVALID_PENALTY + 1, ast };
    }
    const { distance, penalty } = await distanceOf(candidate);
    return { distance, total: distance + penalty, ast: candidate };
  };

  const initial = await evaluate(seedVector(slots));

  const de = await differentialEvolution(async (candidate) => (await evaluate(candidate)).total, {
    dimensions: slots.length,
    seedVector: seedVector(slots),
    ...(options.populationSize === undefined ? {} : { populationSize: options.populationSize }),
    ...(options.generations === undefined ? {} : { generations: options.generations }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.targetFitness === undefined ? {} : { targetFitness: options.targetFitness }),
    ...(options.stallGenerations === undefined ? {} : { stallGenerations: options.stallGenerations }),
    ...(options.onGeneration === undefined ? {} : { onGeneration: options.onGeneration }),
  });

  const source = applyVector(options.source, slots, de.best);
  const winner = await evaluate(de.best);

  return {
    source,
    ast: winner.ast,
    distance: winner.distance,
    initialDistance: initial.distance,
    slots,
    values: slots.map((slot, index) => positionToValue(slot, de.best[index] ?? 0)),
    de,
    issues: validate(winner.ast),
  };
}
