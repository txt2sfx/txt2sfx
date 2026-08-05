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
import { DE_DEFAULTS, differentialEvolution, type Vector } from '../src/index.js';

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
