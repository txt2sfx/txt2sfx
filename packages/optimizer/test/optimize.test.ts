/**
 * End-to-end optimizer tests, on real renders.
 *
 * The headline case is the plan's acceptance criterion — take a reference recipe,
 * corrupt its slot values, and check that the search finds its way back — and it
 * is a good test for a reason that is easy to miss: the target is a render of the
 * *same recipe*, so a perfect score is known to exist inside the search space.
 * A run that cannot find it has a defect, not a hard problem.
 */

import { describe, expect, it } from 'vitest';
import { parse, serialize, validate } from '@txt2sfx/core';
import { extractProfile } from '@txt2sfx/analyzer';
import { applyVector, collectSlots, optimize, seedVector, valueToPosition } from '../src/index.js';
import { loadExample, renderSignal, targetFrom } from './helpers/render.js';

/** Push every slot to one end of its range — the corruption to recover from. */
const corrupt = (source: string, position: number): string => {
  const slots = collectSlots(parse(source));
  return applyVector(
    source,
    slots,
    slots.map(() => position),
  );
};

/** How far a result travelled from the recipe it started at, in cube units. */
const drift = (source: string, values: readonly number[]): number => {
  const slots = collectSlots(parse(source));
  const start = seedVector(slots);
  let sum = 0;
  slots.forEach((slot, index) => {
    sum += Math.abs(valueToPosition(slot, values[index] ?? slot.value) - (start[index] ?? 0));
  });
  return sum / Math.max(1, slots.length);
};

describe('recovery: the phase acceptance criterion', () => {
  it(
    'walks bubble-pop back from corrupted slots to its own render',
    async () => {
      const source = loadExample('bubble-pop');
      const target = await targetFrom(parse(source));
      const broken = corrupt(source, 1);

      const result = await optimize({
        source: broken,
        target,
        render: renderSignal,
        generations: 40,
        seed: 5,
        targetFitness: 0.02,
      });

      /* Better than where it started, close to the original, and inside the
         threshold the plan asked for — all three, because any one of them alone
         can be satisfied by an optimizer that is subtly broken. */
      expect(result.initialDistance).toBeGreaterThan(0.1);
      expect(result.distance).toBeLessThan(0.05);
      expect(result.distance).toBeLessThan(result.initialDistance / 3);
      expect(result.de.generations).toBeLessThanOrEqual(40);
    },
    120_000,
  );

  it(
    'recovers from the opposite corner too, so the win is not a lucky seed',
    async () => {
      const source = loadExample('bubble-pop');
      const target = await targetFrom(parse(source));

      const result = await optimize({
        source: corrupt(source, 0),
        target,
        render: renderSignal,
        generations: 30,
        seed: 17,
      });

      expect(result.distance).toBeLessThan(0.08);
      expect(result.distance).toBeLessThan(result.initialDistance / 2);
    },
    120_000,
  );

  it(
    'recovers a three-slot noise recipe, where the fitness is much flatter',
    async () => {
      const source = loadExample('footstep-gravel');
      const target = await targetFrom(parse(source));

      const result = await optimize({
        source: corrupt(source, 1),
        target,
        render: renderSignal,
        generations: 15,
        seed: 3,
      });

      expect(result.distance).toBeLessThan(result.initialDistance / 2);
    },
    180_000,
  );
});

describe('what the optimizer is not allowed to do', () => {
  it(
    'never changes anything but the slot values',
    async () => {
      const source = loadExample('bubble-pop');
      const target = await targetFrom(parse(source));
      const result = await optimize({
        source,
        target,
        render: renderSignal,
        generations: 3,
        seed: 2,
      });

      const before = parse(source);
      const after = result.ast;
      expect(after.layers.map((l) => l.name)).toEqual(before.layers.map((l) => l.name));
      expect(after.layers.map((l) => l.source.name)).toEqual(before.layers.map((l) => l.source.name));
      expect(after.layers.map((l) => l.chain.map((e) => e.name))).toEqual(
        before.layers.map((l) => l.chain.map((e) => e.name)),
      );
      expect(after.category).toBe(before.category);
      /* Comments are part of the recipe and survive because the search edits
         spans rather than re-serializing a tree. */
      expect(result.source).toContain('# Game bubble pop');
    },
    120_000,
  );

  it(
    'returns a recipe that parses, round-trips and validates',
    async () => {
      const source = loadExample('laser');
      const target = await targetFrom(parse(source));
      const result = await optimize({
        source: corrupt(source, 0),
        target,
        render: renderSignal,
        generations: 8,
        seed: 4,
      });

      expect(serialize(parse(result.source))).toBe(result.source);
      expect(validate(result.ast).filter((i) => i.severity === 'error')).toEqual([]);
      expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    },
    120_000,
  );

  /**
   * The plan's warning, made a test: `explosion` has about 2 dB of headroom, and
   * a search told only to match a spectrum will happily spend it. A clipping
   * candidate is penalized past every clean one, so the winner cannot clip.
   */
  it(
    'does not buy a better match with clipping',
    async () => {
      const source = loadExample('explosion');
      /* Profile-only fitness here: the peak penalty is what is under test, and a
         spectral loss over 1.2 s of four-layer audio costs an order of magnitude
         more per candidate without touching the thing being checked. */
      const target = { profile: extractProfile(await renderSignal(parse(source))) };
      const result = await optimize({
        source: corrupt(source, 1),
        target,
        render: renderSignal,
        generations: 6,
        seed: 6,
      });

      const signal = await renderSignal(result.ast);
      let peak = 0;
      for (let i = 0; i < signal.samples.length; i++) peak = Math.max(peak, Math.abs(signal.samples[i] ?? 0));
      expect(peak).toBeLessThanOrEqual(0.95);
    },
    240_000,
  );

  it(
    'refuses candidates the validator rejects instead of rendering them',
    async () => {
      /* A decay slot whose upper bound is past what `pop` allows: the top of the
         range is unreachable, so the winner must sit below the limit. */
      const source =
        'sound "pop" 55ms pop\n  body: tone tri 900Hz | gain 0.8 decay ~30ms[10..300]\n';
      const target = await targetFrom(parse('sound "pop" 55ms pop\n  body: tone tri 900Hz | gain 0.8 decay 22ms\n'));

      const result = await optimize({
        source,
        target,
        render: renderSignal,
        generations: 10,
        seed: 8,
      });

      expect(result.values[0]).toBeLessThanOrEqual(40);
      expect(validate(result.ast).filter((i) => i.severity === 'error')).toEqual([]);
    },
    120_000,
  );
});

/**
 * "The same recipe, with better numbers" is a promise this module makes in its own
 * docblock, and for a long time nothing in the code kept it.
 *
 * The distance metric is scale-normalized and onset-aligned, so it cannot see the
 * difference between *this sound, closer* and *a different sound that happens to
 * score well*; a broadband wash with the right envelope and centroid trajectory
 * beats a recognizable version of what was asked for. Fitting a recipe against an
 * unrelated reference is that pressure at its worst, and it is exactly what the
 * playground does every time a model's design is fitted to a recording.
 */
describe('staying the recipe it was given', () => {
  it(
    'wanders less with an anchor than without one, fitted to an unrelated sound',
    async () => {
      const source = loadExample('bubble-pop');
      /* Gravel against a bubble pop: nothing in the search space is close, so the
         search is free to go looking anywhere, which is the whole problem. */
      const target = await targetFrom(parse(loadExample('footstep-gravel')));
      const settings = {
        source,
        target,
        render: renderSignal,
        generations: 12,
        populationSize: 10,
        seed: 4,
      } as const;

      const free = await optimize(settings);
      const held = await optimize({ ...settings, anchor: 0.25, initialSpread: 0.25 });

      const wandered = drift(source, free.values);
      const stayed = drift(source, held.values);
      expect(stayed).toBeLessThan(wandered);
      /* Not a wall, though: the point is a cost, not a cage. The anchored run still
         has to have improved on the recipe as written. */
      expect(held.distance).toBeLessThanOrEqual(held.initialDistance);
    },
    240_000,
  );

  it(
    'reports a distance the anchor is not folded into',
    async () => {
      const source = loadExample('bubble-pop');
      const target = await targetFrom(parse(source));
      const result = await optimize({
        source: corrupt(source, 1),
        target,
        render: renderSignal,
        generations: 4,
        populationSize: 6,
        seed: 8,
        anchor: 0.9,
      });

      /* A distance is a distance: comparable across runs, across anchors, and
         against the threshold the agent loop accepts on. Penalties belong to the
         search, and a reported number that quietly carried one would make an
         accepted recipe and a rejected one incomparable. */
      expect(result.distance).toBeGreaterThanOrEqual(0);
      expect(result.distance).toBeLessThanOrEqual(1);
      expect(result.de.bestFitness).toBeGreaterThanOrEqual(result.distance);
    },
    120_000,
  );
});

describe('stopping a fit', () => {
  it(
    'returns the best recipe it had reached when the signal fires',
    async () => {
      const source = loadExample('bubble-pop');
      const target = await targetFrom(parse(source));
      const controller = new AbortController();
      const seen: number[] = [];

      const result = await optimize({
        source: corrupt(source, 1),
        target,
        render: renderSignal,
        generations: 200,
        populationSize: 8,
        seed: 5,
        stallGenerations: 10_000,
        signal: controller.signal,
        onGeneration: (report) => {
          seen.push(report.generation);
          if (report.generation === 3) controller.abort();
        },
      });

      expect(result.de.stopped).toBe('aborted');
      /* 200 generations were authorised and four were spent. Before the signal
         reached the search, this is precisely what a cancelled run kept doing. */
      expect(seen.length).toBeLessThanOrEqual(4);
      /* And the wait was not wasted: what comes back is a recipe, and a better one. */
      expect(serialize(parse(result.source))).toBe(result.source);
      expect(result.distance).toBeLessThan(result.initialDistance);
    },
    120_000,
  );

  it(
    'hands each generation the leader as something that can be played',
    async () => {
      const source = loadExample('bubble-pop');
      const target = await targetFrom(parse(source));
      const reports: { source: string; distance: number; bestFitness: number }[] = [];

      await optimize({
        source: corrupt(source, 1),
        target,
        render: renderSignal,
        generations: 4,
        populationSize: 6,
        seed: 11,
        stallGenerations: 100,
        anchor: 0.2,
        onGeneration: (report) =>
          reports.push({
            source: report.source,
            distance: report.distance,
            bestFitness: report.bestFitness,
          }),
      });

      expect(reports).toHaveLength(4);
      for (const report of reports) {
        /* Renderable as it stands — a number cannot be listened to, and the failure
           this exists to catch is inaudible in the number. */
        expect(() => validate(parse(report.source))).not.toThrow();
        expect(report.source).toContain('sound "bubble pop"');
        /* The honest distance, so a live line and the final verdict agree. */
        expect(report.distance).toBeLessThanOrEqual(report.bestFitness + 1e-9);
      }
      /* Best-so-far, so the leader can only improve. */
      for (let i = 1; i < reports.length; i++) {
        expect(reports[i]?.bestFitness).toBeLessThanOrEqual(reports[i - 1]?.bestFitness ?? 1);
      }
    },
    120_000,
  );
});

describe('degenerate and cheap paths', () => {
  /**
   * Quantization means a neighbourhood of positions is one recipe, and DE proposes
   * the same recipe over and over — which used to be paid for in renders, the most
   * expensive thing in the loop, for an answer already known.
   */
  it(
    'renders each distinct recipe once, however many times it is proposed',
    async () => {
      /* One slot, two millimetres wide: 21 distinct recipes exist at the precision
         a soundline is written with, and the search will ask for far more than 21
         candidates. */
      const source = 'sound "pop" 55ms pop\n  body: tone tri 900Hz | gain 0.8 decay ~30ms[29..31]\n';
      const target = await targetFrom(parse('sound "pop" 55ms pop\n  body: tone tri 900Hz | gain 0.8 decay 30ms\n'));

      let renders = 0;
      const result = await optimize({
        source,
        target,
        render: (ast) => {
          renders++;
          return renderSignal(ast);
        },
        generations: 20,
        populationSize: 8,
        seed: 3,
        stallGenerations: 10_000,
      });

      expect(result.de.evaluations).toBeGreaterThan(100);
      expect(renders).toBeLessThanOrEqual(21);
    },
    120_000,
  );

  it(
    'reports the distance of a recipe with no slots and leaves it alone',
    async () => {
      const source = 'sound "pop" 35ms pop\n  b: tone sine 900Hz | gain 0.8 decay 25ms\n';
      const target = await targetFrom(parse(source));
      const result = await optimize({ source, target, render: renderSignal });

      expect(result.source).toBe(source);
      expect(result.slots).toEqual([]);
      expect(result.distance).toBe(0);
      expect(result.de.evaluations).toBe(1);
    },
    60_000,
  );

  it(
    'works from a profile alone, which is all the recipe bank stores',
    async () => {
      const source = loadExample('bubble-pop');
      const profile = extractProfile(await renderSignal(parse(source)));

      const result = await optimize({
        source: corrupt(source, 1),
        target: { profile },
        render: renderSignal,
        generations: 20,
        seed: 9,
      });

      expect(result.distance).toBeLessThan(result.initialDistance / 2);
    },
    120_000,
  );

  it(
    'is deterministic: the same seed gives the same recipe',
    async () => {
      const source = loadExample('bubble-pop');
      const target = await targetFrom(parse(source));
      const run = () =>
        optimize({ source: corrupt(source, 0), target, render: renderSignal, generations: 6, seed: 21 });

      const [a, b] = [await run(), await run()];
      expect(a.source).toBe(b.source);
      expect(a.distance).toBe(b.distance);
      expect(a.values).toEqual(b.values);
    },
    180_000,
  );

  it(
    'reports progress generation by generation',
    async () => {
      const source = loadExample('bubble-pop');
      const target = await targetFrom(parse(source));
      const seen: number[] = [];
      await optimize({
        source: corrupt(source, 1),
        target,
        render: renderSignal,
        generations: 5,
        seed: 12,
        stallGenerations: 100,
        onGeneration: (report) => seen.push(report.bestFitness),
      });
      expect(seen).toHaveLength(5);
      for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1] as number);
    },
    120_000,
  );
});
