/**
 * Differential evolution tests, on analytic functions.
 *
 * Audio is deliberately absent here. A search tested only through a renderer
 * cannot tell "the optimizer is broken" from "the fitness function is a poor
 * guide", and these functions have known minima: sphere is convex, Rastrigin is
 * a minefield of local minima, and both are cheap enough to run hundreds of
 * generations of in milliseconds.
 */

import { describe, expect, it } from 'vitest';
import { DE_DEFAULTS, differentialEvolution, stallWindowFor, type Vector } from '../src/index.js';

/** Minimum 0 at the centre of the cube. Convex — anything should solve it. */
const sphere = (centre: number) => async (v: Vector): Promise<number> =>
  v.reduce((sum, x) => sum + (x - centre) ** 2, 0) / Math.max(1, v.length);

/**
 * Rastrigin, rescaled to the unit cube with its minimum at 0.5.
 *
 * Local minima every 0.1 along every axis. A search that only ever walks downhill
 * gets stuck in the first one it finds.
 */
const rastrigin = async (v: Vector): Promise<number> => {
  const scaled = v.map((x) => (x - 0.5) * 10.24);
  const value = 10 * scaled.length + scaled.reduce((sum, x) => sum + x * x - 10 * Math.cos(2 * Math.PI * x), 0);
  return value / (10 * scaled.length + scaled.length * 40);
};

/* The convergence tests disable the stall cutoff: how well the search converges
   and when it decides to give up are two separate questions, and mixing them
   makes a change to the stopping policy look like a regression in the search. */
const NO_STALL = 10_000;

describe('convergence', () => {
  it('finds the minimum of a convex function', async () => {
    const result = await differentialEvolution(sphere(0.5), {
      dimensions: 4,
      seed: 7,
      generations: 60,
      stallGenerations: NO_STALL,
    });
    expect(result.bestFitness).toBeLessThan(1e-4);
    for (const x of result.best) expect(Math.abs(x - 0.5)).toBeLessThan(0.02);
  });

  it('escapes local minima', async () => {
    const result = await differentialEvolution(rastrigin, {
      dimensions: 3,
      seed: 3,
      generations: 120,
      stallGenerations: NO_STALL,
    });
    /* A hill-climber from a random start typically lands around 0.05-0.2 here. */
    expect(result.bestFitness).toBeLessThan(0.01);
  });

  it('finds a minimum in a corner, where clamping does the most damage', async () => {
    const result = await differentialEvolution(sphere(0), {
      dimensions: 5,
      seed: 11,
      generations: 80,
      stallGenerations: NO_STALL,
    });
    expect(result.bestFitness).toBeLessThan(1e-4);
  });
});

describe('determinism', () => {
  it('gives the same answer for the same seed', async () => {
    const run = () => differentialEvolution(rastrigin, { dimensions: 4, seed: 42, generations: 30 });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.best).toEqual(b.best);
    expect(a.bestFitness).toBe(b.bestFitness);
    expect(a.evaluations).toBe(b.evaluations);
  });

  it('gives different answers for different seeds', async () => {
    const a = await differentialEvolution(rastrigin, { dimensions: 4, seed: 1, generations: 5 });
    const b = await differentialEvolution(rastrigin, { dimensions: 4, seed: 2, generations: 5 });
    expect(a.best).not.toEqual(b.best);
  });
});

describe('the seed vector', () => {
  it('is kept in the population, so a hand-tuned recipe cannot be lost', async () => {
    /* A fitness that only rewards the seed: if the seed were dropped, nothing
       else in the cube could ever reach this value. */
    const seedVector = [0.123, 0.456, 0.789];
    const onlySeed = async (v: Vector): Promise<number> =>
      v.every((x, i) => x === seedVector[i]) ? 0 : 1;
    const result = await differentialEvolution(onlySeed, {
      dimensions: 3,
      seedVector,
      seed: 5,
      generations: 3,
    });
    expect(result.bestFitness).toBe(0);
    expect(result.best).toEqual(seedVector);
  });

  it('is clamped into the cube rather than trusted', async () => {
    const result = await differentialEvolution(sphere(0.5), {
      dimensions: 2,
      seedVector: [-3, 9],
      seed: 5,
      generations: 1,
    });
    for (const x of result.best) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });
});

describe('where generation 0 is drawn from', () => {
  /** Every candidate the fitness was shown, in order. */
  const recorder = (): { seen: Vector[]; fitness: (v: Vector) => Promise<number> } => {
    const seen: Vector[] = [];
    return {
      seen,
      fitness: async (v: Vector): Promise<number> => {
        seen.push([...v]);
        return 0.5;
      },
    };
  };

  const furthest = (seen: readonly Vector[], seed: readonly number[]): number => {
    let worst = 0;
    for (const candidate of seen) {
      for (let d = 0; d < candidate.length; d++) {
        worst = Math.max(worst, Math.abs((candidate[d] as number) - (seed[d] as number)));
      }
    }
    return worst;
  };

  const seed = [0.5, 0.5, 0.5, 0.5];

  it('spreads over the whole cube by default, because the answer could be anywhere', async () => {
    const { seen, fitness } = recorder();
    await differentialEvolution(fitness, {
      dimensions: 4,
      seedVector: seed,
      populationSize: 24,
      generations: 0,
      seed: 5,
    });
    expect(seen).toHaveLength(24);
    /* Uniform samples reach the corners: that is the point of them, and it is what
       makes recovering corrupted slot values possible at all. */
    expect(furthest(seen, seed)).toBeGreaterThan(0.4);
  });

  /**
   * The other half of the same decision, and the one this option was added for.
   *
   * A population sampled uniformly leaves the recipe as one individual in sixteen,
   * and DE draws its donors from wherever the population is — so within a few
   * generations the search is exploring a neighbourhood the recipe is not in. That
   * is correct for "find these numbers" and wrong for "refine this design", where
   * everywhere else in the cube is a different sound that happens to score well.
   */
  it('stays near the recipe when asked, so a design is refined rather than replaced', async () => {
    const { seen, fitness } = recorder();
    await differentialEvolution(fitness, {
      dimensions: 4,
      seedVector: seed,
      populationSize: 24,
      generations: 0,
      seed: 5,
      initialSpread: 0.05,
    });
    expect(seen).toHaveLength(24);
    /* Normal, so a tail is allowed — but nothing near a corner at four sigma. */
    expect(furthest(seen, seed)).toBeLessThan(0.3);
    /* The recipe itself is still individual zero. */
    expect(seen[0]).toEqual(seed);
  });

  it('ignores a spread it has no centre for', async () => {
    const { seen, fitness } = recorder();
    await differentialEvolution(fitness, {
      dimensions: 3,
      populationSize: 16,
      generations: 0,
      seed: 9,
      initialSpread: 0.01,
    });
    /* No seed vector, so "near the seed" is meaningless and the cube is the only
       honest default. A spread applied around 0.5 anyway would silently confine a
       search that asked for nothing of the kind. */
    expect(furthest(seen, [0.5, 0.5, 0.5])).toBeGreaterThan(0.3);
  });

  it('samples the same population twice for the same seed', async () => {
    const run = async (): Promise<Vector[]> => {
      const { seen, fitness } = recorder();
      await differentialEvolution(fitness, {
        dimensions: 5,
        seedVector: [0.2, 0.4, 0.6, 0.8, 0.1],
        generations: 0,
        seed: 13,
        initialSpread: 0.2,
      });
      return seen;
    };
    expect(await run()).toEqual(await run());
  });
});

/**
 * A plateau must not move the answer.
 *
 * Storn and Price accept a trial that merely ties, which costs nothing on a
 * continuous landscape. This one is quantized — slot values are rounded before they
 * are rendered — so equal scores are common, and with `<=` the population drifts
 * across the plateau for free, away from the recipe it started at, while the
 * reported best never worsens. The sound changes and the number does not, which is
 * the hardest kind of regression to see.
 */
describe('ties', () => {
  it('does not let an equally good candidate displace the incumbent', async () => {
    const seedVector = [0.2, 0.7, 0.45];
    const flat = async (): Promise<number> => 0.5;
    const result = await differentialEvolution(flat, {
      dimensions: 3,
      seedVector,
      seed: 6,
      generations: 12,
      stallGenerations: 10_000,
    });
    expect(result.best).toEqual(seedVector);
    expect(result.bestFitness).toBe(0.5);
  });
});

describe('stopping', () => {
  it('stops on reaching the target and says so', async () => {
    const result = await differentialEvolution(sphere(0.5), {
      dimensions: 3,
      seed: 9,
      generations: 200,
      targetFitness: 0.01,
    });
    expect(result.stopped).toBe('target');
    expect(result.bestFitness).toBeLessThanOrEqual(0.01);
    expect(result.generations).toBeLessThan(200);
  });

  /**
   * The distinction the agent loop branches on: only a stalled search justifies
   * asking a model to change the topology. A search that merely ran out of
   * budget should be given more budget instead.
   */
  it('reports a stall separately from running out of budget', async () => {
    const flat = async (): Promise<number> => 0.5;
    const stalled = await differentialEvolution(flat, {
      dimensions: 2,
      seed: 4,
      generations: 100,
      stallGenerations: 5,
    });
    expect(stalled.stopped).toBe('stalled');
    expect(stalled.generations).toBe(5);

    const budget = await differentialEvolution(sphere(0.5), {
      dimensions: 6,
      seed: 4,
      generations: 4,
      stallGenerations: 100,
    });
    expect(budget.stopped).toBe('budget');
    expect(budget.generations).toBe(4);
  });

  /**
   * The stall window scales with the budget, and it has to.
   *
   * A caller that shortens a run — the playground does, to keep a browser
   * responsive — used to inherit the window sized for 60 generations. A window
   * larger than the budget can never be reached, so `stopped` could only ever be
   * `'target'` or `'budget'`, and the agent loop's "the numbers cannot rescue this
   * structure, redesign it" branch became unreachable without a word of warning.
   */
  it('derives the stall window from the budget rather than the default budget', async () => {
    expect(stallWindowFor(60)).toBe(DE_DEFAULTS.stallGenerations);
    expect(stallWindowFor(44)).toBe(15);
    /* Never larger than the budget it has to fit inside. */
    for (const generations of [14, 20, 30, 44, 60, 120]) {
      expect(stallWindowFor(generations), `budget ${String(generations)}`).toBeLessThan(generations);
    }
    /* A plateau shorter than six generations is noise on any budget. */
    expect(stallWindowFor(3)).toBe(6);

    const flat = async (): Promise<number> => 0.5;
    const short = await differentialEvolution(flat, { dimensions: 2, seed: 4, generations: 14 });
    expect(short.stopped).toBe('stalled');
    expect(short.generations).toBe(stallWindowFor(14));
  });

  /**
   * The stall contract, checked as an invariant rather than on one lucky seed: if a
   * run stopped because it stalled, the last `stallGenerations` reports must show
   * the same best fitness. Anything else means the counter counted a generation
   * that improved — and a false stall is the expensive direction, since it is what
   * tells the agent loop to send a language model off to redesign a topology.
   */
  it('never reports a stall while the best fitness is still improving', async () => {
    const window = 20;
    let stalledRuns = 0;

    for (const seed of [3, 8, 12, 15, 21, 29, 34, 42]) {
      const result = await differentialEvolution(rastrigin, {
        dimensions: 6,
        seed,
        generations: 200,
        stallGenerations: window,
      });
      if (result.stopped !== 'stalled') continue;
      stalledRuns++;

      const tail = result.history.slice(-window);
      const settled = tail[0]?.bestFitness;
      for (const report of tail) {
        expect(report.bestFitness).toBe(settled);
      }
    }

    /* The assertion above is vacuous if nothing stalled, so make sure something did. */
    expect(stalledRuns).toBeGreaterThan(0);
  });

  /**
   * Stop has to mean stop, and it has to keep the answer.
   *
   * One evaluation here is one render in the real caller, and a whole generation of
   * them is what the playground was spending after a cancelled run: the signal
   * reached the model call and nothing else, so the search kept working on a thread
   * whose owner had given up on it. Checking before every evaluation is the only
   * granularity that makes a Stop button believable.
   */
  it('stops between evaluations and returns the best it had reached', async () => {
    const controller = new AbortController();
    let calls = 0;
    const countdown = async (v: Vector): Promise<number> => {
      calls++;
      if (calls === 40) controller.abort();
      return sphere(0.5)(v);
    };

    const result = await differentialEvolution(countdown, {
      dimensions: 3,
      seed: 4,
      populationSize: 8,
      generations: 200,
      stallGenerations: 10_000,
      signal: controller.signal,
    });

    expect(result.stopped).toBe('aborted');
    /* At most one more evaluation than the one that pulled the trigger. 200
       generations of eight would have been 1608. */
    expect(result.evaluations).toBeLessThanOrEqual(41);
    expect(result.generations).toBeLessThan(200);
    /* The wait produced something, and it is handed back rather than discarded.
       0.25 is what a corner of the cube scores on this landscape. */
    expect(result.bestFitness).toBeLessThan(0.25);
    expect(result.best).toHaveLength(3);
  });

  it('survives being stopped before generation 0 is even measured', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fitness = async (v: Vector): Promise<number> => {
      calls++;
      if (calls === 3) controller.abort();
      return sphere(0.5)(v);
    };

    const result = await differentialEvolution(fitness, {
      dimensions: 2,
      seedVector: [0.9, 0.9],
      populationSize: 16,
      generations: 50,
      seed: 2,
      signal: controller.signal,
    });

    expect(result.stopped).toBe('aborted');
    expect(result.generations).toBe(0);
    expect(result.history).toEqual([]);
    /* Three individuals were measured, so the best of three is a real answer. */
    expect(result.evaluations).toBe(3);
    expect(Number.isFinite(result.bestFitness)).toBe(true);
  });

  it('does not report an abandoned generation as a stall', async () => {
    const controller = new AbortController();
    let calls = 0;
    const flat = async (): Promise<number> => {
      calls++;
      /* Halfway through generation 1, which on a flat landscape is also the
         generation that trips a stall window of one. */
      if (calls === 12) controller.abort();
      return 0.5;
    };

    const result = await differentialEvolution(flat, {
      dimensions: 2,
      seed: 4,
      populationSize: 8,
      generations: 100,
      stallGenerations: 1,
      signal: controller.signal,
    });

    /* Both conditions are true and only one of them is informative. An abandoned
       generation says nothing about the landscape, and `stalled` is what tells the
       agent loop to send a language model off to redesign a topology — on the
       strength, here, of a measurement nobody finished. */
    expect(result.stopped).toBe('aborted');
    expect(result.generations).toBe(1);
  });

  it('never spends more evaluations than population times generations plus one', async () => {
    const result = await differentialEvolution(sphere(0.5), {
      dimensions: 3,
      seed: 8,
      populationSize: 8,
      generations: 10,
      stallGenerations: 100,
    });
    expect(result.evaluations).toBeLessThanOrEqual(8 * 11);
  });
});

describe('degenerate inputs', () => {
  it('reports the fitness of a recipe with nothing to optimize', async () => {
    const result = await differentialEvolution(async () => 0.42, { dimensions: 0 });
    expect(result.bestFitness).toBe(0.42);
    expect(result.evaluations).toBe(1);
    expect(result.best).toEqual([]);
  });

  it('raises a population too small to draw three donors from', async () => {
    const result = await differentialEvolution(sphere(0.5), {
      dimensions: 2,
      populationSize: 2,
      seed: 1,
      generations: 3,
    });
    /* Silently clamped to four rather than looping forever looking for donors. */
    expect(result.evaluations).toBeGreaterThanOrEqual(4);
  });

  it('records a history a caller can plot', async () => {
    const seen: number[] = [];
    const result = await differentialEvolution(sphere(0.5), {
      dimensions: 3,
      seed: 6,
      generations: 8,
      stallGenerations: 100,
      onGeneration: (report) => seen.push(report.bestFitness),
    });
    expect(seen).toHaveLength(8);
    expect(result.history).toHaveLength(8);
    /* Best-so-far can only improve: the population keeps the winner. */
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1] as number);
  });

  it('reports diversity collapsing as the population agrees', async () => {
    const result = await differentialEvolution(sphere(0.5), {
      dimensions: 3,
      seed: 6,
      generations: 60,
      stallGenerations: 100,
    });
    const first = result.history[0]?.diversity ?? 0;
    const last = result.history[result.history.length - 1]?.diversity ?? 0;
    expect(last).toBeLessThan(first / 10);
  });
});

describe('defaults', () => {
  it('match the plan: population 24, 60 generations', () => {
    expect(DE_DEFAULTS.populationSize).toBe(24);
    expect(DE_DEFAULTS.generations).toBe(60);
  });
});
