/**
 * Differential evolution over the unit cube.
 *
 * ## Why DE and not gradient descent
 *
 * There is no gradient. A candidate's fitness comes from rendering audio and
 * measuring it; the map from a filter frequency to a spectral distance is not
 * differentiable in any form available here, and it is not convex either — two
 * filters can trade places and reach the same sound. DE needs only the ability to
 * evaluate, handles a dozen dimensions on a budget of a few hundred evaluations,
 * and has one property that matters more than its convergence rate: its step size
 * is the spread of the population itself, so it explores widely while the
 * population is diverse and refines automatically once it has agreed.
 *
 * ## Determinism
 *
 * The PRNG is MINSTD, the same generator the synthesis engine uses, seeded from
 * the options. Two runs with the same seed produce the same recipe. That is not a
 * nicety: without it a regression in the fitness function is indistinguishable
 * from bad luck, and a recipe committed to the bank could never be reproduced.
 *
 * @packageDocumentation
 */

/** A point in the unit cube. */
export type Vector = readonly number[];

/** What DE is told about each candidate. Lower is better. */
export type Fitness = (candidate: Vector) => Promise<number>;

/** Tuning of {@link differentialEvolution}. */
export interface DEOptions {
  /** Dimensions of the search space. */
  readonly dimensions: number;
  /** Starting point, usually the recipe as written. Included in generation 0. */
  readonly seedVector?: Vector;
  /** Individuals per generation. */
  readonly populationSize?: number;
  /** Generations to run, unless `targetFitness` is reached first. */
  readonly generations?: number;
  /** PRNG seed. */
  readonly seed?: number;
  /** Differential weight, the scale of the mutation step. */
  readonly F?: number;
  /** Crossover rate: the share of coordinates taken from the mutant. */
  readonly CR?: number;
  /** Stop as soon as the best fitness is at or below this. */
  readonly targetFitness?: number;
  /**
   * Stop after this many generations with no improvement.
   *
   * The agent loop needs to know the difference between "the numbers are as good
   * as they get" and "the run ran out of budget": only the first justifies asking
   * a model to change the topology.
   */
  readonly stallGenerations?: number;
  /** Called after each generation, for progress reporting. */
  readonly onGeneration?: (report: GenerationReport) => void;
}

/** State after one generation. */
export interface GenerationReport {
  readonly generation: number;
  readonly bestFitness: number;
  readonly best: Vector;
  /** Mean pairwise spread of the population, 0 when it has converged. */
  readonly diversity: number;
  readonly evaluations: number;
}

/** Outcome of a run. */
export interface DEResult {
  readonly best: Vector;
  readonly bestFitness: number;
  readonly generations: number;
  readonly evaluations: number;
  /** Why the run stopped — the agent loop branches on this. */
  readonly stopped: 'target' | 'stalled' | 'budget';
  readonly history: readonly GenerationReport[];
}

/**
 * Defaults.
 *
 * Population 24 and 60 generations come from the plan; together they cap a run
 * at about 1500 renders, which is seconds rather than minutes. `F` 0.7 and `CR`
 * 0.9 are the standard robust pair for a problem with no known structure — high
 * crossover because the coordinates here are not independent (a filter and the
 * source it filters have to move together), and a differential weight below 1 to
 * keep the population from scattering out of the cube on every step.
 *
 * `stallGenerations` is 20 — a third of the budget — because the costs on either
 * side of that decision are wildly asymmetric. Stalling early wastes a few
 * hundred renders; declaring a stall wrongly tells the agent loop the numbers are
 * as good as they get, which sends a language model off to redesign a topology
 * that did not need redesigning. Measured: on a 3-dimensional Rastrigin landscape
 * a threshold of 12 stopped at more than twice the error the same run reached
 * when allowed to continue — plateaus of a dozen generations are ordinary
 * mid-search, not a verdict.
 */
export const DE_DEFAULTS = {
  populationSize: 24,
  generations: 60,
  seed: 1,
  F: 0.7,
  CR: 0.9,
  stallGenerations: 20,
} as const;

/**
 * The stall window for a budget: a third of it, never below six.
 *
 * "A third of the budget" is the rule the paragraph above argues for;
 * `DE_DEFAULTS.stallGenerations` is that rule evaluated for the default 60. Baking
 * only the evaluated number in was a trap, and it caught the playground: a caller
 * that shortens the run to 14 generations to keep a browser responsive gets a
 * stall window of 20, which **cannot be reached**, so `stopped` is never
 * `'stalled'` — and the agent loop's one mechanism for "the numbers are as good as
 * this structure allows, redesign it" becomes unreachable. The failure is silent
 * and expensive: the loop reports a distance and quietly stops asking.
 *
 * Six is the floor because a plateau shorter than that is noise on any budget.
 */
export function stallWindowFor(generations: number): number {
  return Math.max(6, Math.round(generations / 3));
}

/** MINSTD. Full period, no weak low bits, and no dependency. */
function makeRandom(seed: number): () => number {
  let state = Math.abs(Math.trunc(seed)) % 2147483647;
  if (state === 0) state = 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Mean absolute deviation from the population centroid, averaged over axes. */
function diversityOf(population: readonly Vector[]): number {
  const dimensions = population[0]?.length ?? 0;
  if (dimensions === 0 || population.length === 0) return 0;
  let total = 0;
  for (let d = 0; d < dimensions; d++) {
    let mean = 0;
    for (const individual of population) mean += individual[d] ?? 0;
    mean /= population.length;
    let spread = 0;
    for (const individual of population) spread += Math.abs((individual[d] ?? 0) - mean);
    total += spread / population.length;
  }
  return total / dimensions;
}

/**
 * DE/rand/1/bin.
 *
 * One classical detail worth keeping: the crossover forces at least one
 * coordinate to come from the mutant. Without it, a run with a low `CR` can
 * produce trials identical to their parents, and the population stops moving
 * while still burning a full render per individual per generation.
 */
export async function differentialEvolution(fitness: Fitness, options: DEOptions): Promise<DEResult> {
  const dimensions = options.dimensions;
  /* Four is the floor, not a nicety: the donor draw below needs three distinct
     individuals other than the target, and a smaller population would spin
     forever looking for them. */
  const size = Math.max(4, options.populationSize ?? DE_DEFAULTS.populationSize);
  const generations = options.generations ?? DE_DEFAULTS.generations;
  const F = options.F ?? DE_DEFAULTS.F;
  const CR = options.CR ?? DE_DEFAULTS.CR;
  const stallLimit = options.stallGenerations ?? stallWindowFor(generations);
  const random = makeRandom(options.seed ?? DE_DEFAULTS.seed);

  if (dimensions === 0) {
    /* Nothing to optimize. Evaluating the empty vector once still reports the
       recipe's own fitness, which is what a caller wants to know. */
    const only = await fitness([]);
    return {
      best: [],
      bestFitness: only,
      generations: 0,
      evaluations: 1,
      stopped: 'target',
      history: [],
    };
  }

  /* Generation 0: the recipe as written, plus uniform samples around it. The
     seed is kept because a hand-tuned recipe is usually a good starting point,
     and losing it to a random population would be a regression the caller
     cannot see. */
  const population: number[][] = [];
  if (options.seedVector !== undefined) population.push(options.seedVector.map(clamp01));
  while (population.length < size) {
    population.push(Array.from({ length: dimensions }, () => random()));
  }

  let evaluations = 0;
  const scores: number[] = [];
  for (const individual of population) {
    scores.push(await fitness(individual));
    evaluations++;
  }

  let bestIndex = 0;
  for (let i = 1; i < scores.length; i++) if ((scores[i] as number) < (scores[bestIndex] as number)) bestIndex = i;

  const history: GenerationReport[] = [];
  let stalled = 0;
  let stopped: DEResult['stopped'] = 'budget';

  const target = options.targetFitness;
  if (target !== undefined && (scores[bestIndex] as number) <= target) stopped = 'target';

  for (let generation = 1; generation <= generations && stopped === 'budget'; generation++) {
    /**
     * Progress is measured by comparing the best fitness before and after the
     * generation, not by watching for a replacement that happens to beat the
     * incumbent.
     *
     * The obvious version of this — setting a flag inside the acceptance branch
     * when `score < scores[bestIndex]` — is wrong in the one case that matters
     * most. When the individual being replaced *is* the incumbent best, its score
     * has already been updated by the time that comparison runs, so the test reads
     * `score < score` and the flag stays clear. The best fitness then improves,
     * generation after generation, while the stall counter climbs — and the run is
     * declared stalled in the middle of converging. Measured before this was fixed:
     * 8 of 60 seeded 6-dimensional runs stopped that way, one of them still
     * improving two generations before it gave up.
     */
    const previousBest = scores[bestIndex] as number;

    for (let i = 0; i < size; i++) {
      /* Three distinct donors, none of them the target. */
      const picks: number[] = [];
      while (picks.length < 3) {
        const candidate = Math.floor(random() * size);
        if (candidate !== i && !picks.includes(candidate) && candidate < size) picks.push(candidate);
      }
      const [a, b, c] = picks as [number, number, number];
      const base = population[a] as number[];
      const plus = population[b] as number[];
      const minus = population[c] as number[];
      const parent = population[i] as number[];

      const forced = Math.floor(random() * dimensions);
      const trial: number[] = [];
      for (let d = 0; d < dimensions; d++) {
        const take = d === forced || random() < CR;
        trial.push(
          take
            ? clamp01((base[d] as number) + F * ((plus[d] as number) - (minus[d] as number)))
            : (parent[d] as number),
        );
      }

      const score = await fitness(trial);
      evaluations++;
      if (score <= (scores[i] as number)) {
        population[i] = trial;
        scores[i] = score;
        if (score < (scores[bestIndex] as number)) bestIndex = i;
      }
    }

    const report: GenerationReport = {
      generation,
      bestFitness: scores[bestIndex] as number,
      best: population[bestIndex] as number[],
      diversity: diversityOf(population),
      evaluations,
    };
    history.push(report);
    options.onGeneration?.(report);

    stalled = (scores[bestIndex] as number) < previousBest ? 0 : stalled + 1;
    if (target !== undefined && report.bestFitness <= target) stopped = 'target';
    else if (stalled >= stallLimit) stopped = 'stalled';
  }

  return {
    best: population[bestIndex] as number[],
    bestFitness: scores[bestIndex] as number,
    generations: history.length,
    evaluations,
    stopped,
    history,
  };
}
