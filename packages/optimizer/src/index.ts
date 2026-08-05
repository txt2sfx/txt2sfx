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
 * - With an `anchor`, a candidate that has wandered far from the recipe as written
 *   pays for the distance. "Closest to the target" and "this design, with better
 *   numbers" are different objectives; only the second is what this function
 *   promises, and the metric alone does not encode it.
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

export { DE_DEFAULTS, differentialEvolution, stallWindowFor } from './de.js';
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

/**
 * A generation, plus the recipe that is currently winning it.
 *
 * The text is the point. A caller watching a fit has a number to show and nothing
 * to *listen to*, and a number is not a sound: the loop's own worst failure — a
 * search that improves the metric while walking away from the sound the user
 * wanted — is invisible in the fitness curve and obvious in one playback. So the
 * leader is handed over ready to render, and `distance` beside it is the honest
 * distance, penalties excluded, so the live line and the final verdict agree.
 */
export type FitReport = GenerationReport & {
  /** The best individual as a writable recipe. */
  readonly source: string;
  /** Its distance to the target, without the penalties in `bestFitness`. */
  readonly distance: number;
};

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
   * How firmly the search is held to the recipe as written. Default 0: not at all.
   *
   * A weight on the mean distance from the seed vector, in cube units, added to
   * the fitness as a penalty and excluded from the reported distance. At `0.25` a
   * candidate half a cube away from the recipe carries about 0.12 — enough to lose
   * to a near neighbour that matches slightly worse, not enough to trap the search
   * where it started.
   *
   * It exists because "closest to the target" and "the recipe the model designed,
   * with better numbers" are different objectives, and only the second one is what
   * this package promises. The metric is scale-normalized and onset-aligned, so a
   * broadband wash with the right envelope and centroid can score better than a
   * recognizable version of the intended sound; without a term for staying itself,
   * the search takes that trade every time, and the user hears a stranger.
   *
   * Zero by default because the other use of this function — recovering slot values
   * from a corrupted recipe, re-fitting a bank entry — genuinely wants the whole
   * cube, and there the seed carries no information worth protecting.
   */
  readonly anchor?: number;
  /** Spread of generation 0 around the recipe. See {@link DEOptions.initialSpread}. */
  readonly initialSpread?: number;
  /** Stop the search and return the best so far. See {@link DEOptions.signal}. */
  readonly signal?: AbortSignal;
  /**
   * Reject candidates that fail validation without rendering them.
   *
   * Default true. Turn it off to measure how much the physical envelope is
   * costing a search, which is a debugging question, not a production one.
   */
  readonly respectValidator?: boolean;
  readonly onGeneration?: (report: FitReport) => void;
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
  const anchor = options.anchor ?? 0;
  const seed = seedVector(slots);

  /**
   * What each candidate *recipe* measured, keyed by its text.
   *
   * Not a micro-optimization: `roundLiteral` quantizes every slot on the way into
   * the source, so a neighbourhood of positions collapses onto one recipe, and DE
   * re-proposes recipes it has already rendered constantly — the same plateau that
   * used to let the population drift for free. Rendering them again buys nothing,
   * since a render is deterministic in its seed. It also means the per-generation
   * report can name the leader's honest distance without a render of its own.
   *
   * Unbounded on purpose: a browser-sized run measures a few hundred distinct
   * recipes, and evicting entries would trade audio for bytes at a ratio nobody
   * would accept.
   */
  const measured = new Map<string, { distance: number; penalty: number }>();

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

  /**
   * How far a candidate has wandered from the recipe, in cube units.
   *
   * The mean rather than the sum, so the weight means the same thing whether a
   * recipe has three slots or thirty — a sum would make `anchor` a leash that
   * tightens with every `~` the model writes.
   */
  const drift = (positions: Vector): number => {
    if (positions.length === 0) return 0;
    let sum = 0;
    for (let d = 0; d < positions.length; d++) sum += Math.abs((positions[d] ?? 0) - (seed[d] ?? 0));
    return sum / positions.length;
  };

  const evaluate = async (
    positions: Vector,
  ): Promise<{ distance: number; total: number; ast: SoundAST; source: string }> => {
    const source = applyVector(options.source, slots, positions);
    const cached = measured.get(source);
    if (cached !== undefined) {
      /* The anchor is a property of the position, not of the recipe: two position
         vectors can round to the same text from different distances away. */
      return {
        distance: cached.distance,
        total: cached.distance + cached.penalty + anchor * drift(positions),
        ast: parse(source),
        source,
      };
    }

    let candidate: SoundAST;
    try {
      candidate = parse(source);
    } catch {
      /* A rounded value cannot make a soundline unparseable, but a caller may
         hand in slot bounds that serialize to something the lexer rejects, and
         losing a whole run to one bad coordinate would be worse than scoring it. */
      return { distance: 1, total: INVALID_PENALTY + 1, ast, source };
    }
    const { distance, penalty } = await distanceOf(candidate);
    measured.set(source, { distance, penalty });
    return { distance, total: distance + penalty + anchor * drift(positions), ast: candidate, source };
  };

  const initial = await evaluate(seed);

  const de = await differentialEvolution(async (candidate) => (await evaluate(candidate)).total, {
    dimensions: slots.length,
    seedVector: seed,
    ...(options.populationSize === undefined ? {} : { populationSize: options.populationSize }),
    ...(options.generations === undefined ? {} : { generations: options.generations }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.targetFitness === undefined ? {} : { targetFitness: options.targetFitness }),
    ...(options.stallGenerations === undefined ? {} : { stallGenerations: options.stallGenerations }),
    ...(options.initialSpread === undefined ? {} : { initialSpread: options.initialSpread }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onGeneration === undefined
      ? {}
      : {
          onGeneration: (report: GenerationReport): void => {
            const source = applyVector(options.source, slots, report.best);
            /* Present by construction — the leader was measured to become the
               leader — but a fallback beats a crash if that ever stops being true. */
            const distance = measured.get(source)?.distance ?? report.bestFitness;
            options.onGeneration?.({ ...report, source, distance });
          },
        }),
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
