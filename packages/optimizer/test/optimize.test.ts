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
import { applyVector, collectSlots, optimize } from '../src/index.js';
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

describe('degenerate and cheap paths', () => {
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
