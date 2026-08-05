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
  /**
   * Spread of generation 0 around {@link seedVector}, as a standard deviation in
   * cube units. Omitted means the classical thing: uniform over the whole cube.
   *
   * The two settings answer two different questions, and conflating them is how a
   * search ends up solving the wrong one. *Recover these numbers from scratch* —
   * a corrupted recipe, a bank entry being re-fitted — wants a population spread
   * over everything, because the answer could be anywhere. *Refine this design* —
   * a topology a model just wrote, against a reference — wants a population near
   * the design, because everywhere else in the cube is a different sound that
   * happens to score well, and DE/rand/1/bin draws its donors from wherever the
   * population is. With fifteen uniform individuals against one seed, the
   * population's centre of mass is not the recipe after the first few generations,
   * and no amount of budget brings it back.
   *
   * Ignored without a `seedVector`: there is then no centre to spread around.
   */
  readonly initialSpread?: number;
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
  /**
   * Stop the search where it stands.
   *
   * Checked before every evaluation, not once per generation: one evaluation is a
   * render, one generation is a population of them, and a Stop button that takes a
   * whole generation to answer is a Stop button nobody believes. The run returns
   * normally with `stopped: 'aborted'` and the best individual found so far —
   * abandoning it would throw away the only thing the user has to show for the
   * wait, and they pressed Stop *because* they wanted that thing.
   */
  readonly signal?: AbortSignal;
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
  readonly stopped: 'target' | 'stalled' | 'budget' | 'aborted';
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

/**
 * Standard normal from two uniforms, Box-Muller.
 *
 * Only the first of the pair is used and the second is thrown away, which wastes
 * half the draws and does not matter: these are consumed once per coordinate of
 * generation 0. Keeping a cached second value would make the number of PRNG calls
 * depend on how many coordinates were asked for previously, and two runs of the
 * same seed have to sample the same population.
 */
function gaussian(random: () => number): number {
  /* `random()` can return exactly 0 — MINSTD's first output is (1-1)/m — and
     log(0) is -Infinity, which clamps to a cube edge instead of failing loudly. */
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

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

  /* Generation 0: the recipe as written, plus samples around it. The seed is kept
     because a hand-tuned recipe is usually a good starting point, and losing it to
     a random population would be a regression the caller cannot see. Whether the
     rest of the population is drawn from the whole cube or from a neighbourhood of
     the seed is `initialSpread`, and it is the difference between recovering a set
     of numbers and refining a design — see the option. */
  const seed = options.seedVector?.map(clamp01);
  const spread = options.initialSpread;
  const near = seed !== undefined && spread !== undefined && spread > 0;
  const population: number[][] = [];
  if (seed !== undefined) population.push(seed);
  while (population.length < size) {
    population.push(
      near
        ? Array.from({ length: dimensions }, (_, d) =>
            clamp01((seed[d] ?? 0.5) + spread * gaussian(random)),
          )
        : Array.from({ length: dimensions }, () => random()),
    );
  }

  let evaluations = 0;
  const scores: number[] = [];
  for (const individual of population) {
    /* Never before the first: a run that returns no evaluated individual at all
       has nothing to report, and the caller asked for the best so far. */
    if (evaluations > 0 && options.signal?.aborted === true) break;
    scores.push(await fitness(individual));
    evaluations++;
  }

  let bestIndex = 0;
  for (let i = 1; i < scores.length; i++) if ((scores[i] as number) < (scores[bestIndex] as number)) bestIndex = i;

  if (scores.length < population.length) {
    /* Aborted while generation 0 was still being measured. There is a best of
       what was seen, and no history, which is exactly what happened. */
    return {
      best: population[bestIndex] as number[],
      bestFitness: scores[bestIndex] as number,
      generations: 0,
      evaluations,
      stopped: 'aborted',
      history: [],
    };
  }

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
    let aborted = false;

    for (let i = 0; i < size; i++) {
      if (options.signal?.aborted === true) {
        aborted = true;
        break;
      }
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
      /**
       * Strictly better, not as-good-as.
       *
       * Storn and Price accept ties, and on a continuous landscape that is free:
       * exact equality is a measure-zero event. This landscape is not continuous.
       * Slot values are quantized by `roundLiteral` before they are rendered, so a
       * whole neighbourhood of positions produces the *same audio* and therefore
       * the same score — and with `<=` every one of those trials replaces its
       * parent. The population then random-walks across the plateau at no cost in
       * fitness, and since nothing else anchors it, what it walks away from is the
       * recipe. The reported best never worsens while the sound quietly becomes a
       * different sound; that is precisely the failure this was found through.
       */
      if (score < (scores[i] as number)) {
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
    /* An abandoned generation is not evidence about the landscape: reporting it as
       a stall would tell the agent loop the numbers are as good as this structure
       allows and send a model off to redesign a topology nobody finished measuring. */
    if (aborted) stopped = 'aborted';
    else if (target !== undefined && report.bestFitness <= target) stopped = 'target';
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
