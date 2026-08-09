/**
 * The Variation button, held to the promise its name makes.
 *
 * A variation has to be *the same recipe with other numbers*: every value inside
 * the range its author declared, every structural word untouched, and the result
 * still a document the compiler accepts. It also has to be reproducible from its
 * seed — a candidate a user liked and then replaced is only recoverable if the
 * same number gives the same sound back.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { parse, serialize } from '@txt2sfx/core';
import { collectSlots } from '@txt2sfx/optimizer';
import { vary } from '../src/lib/variation.js';

const SOURCE = [
  '# a comment that must survive',
  'sound "bubble pop" 55ms pop',
  '  body: tone tri ~700Hz[500..1400] -> 1120Hz in 14ms >> lp ~2200Hz[900..4000] Q1 | gain 0.8 hold 3ms decay 38ms',
  '  edge: click 1ms >> bp ~2800Hz[1200..6000] Q1 | gain 0.38 attack 0ms decay 6ms',
  '',
].join('\n');

const NO_SLOTS = 'sound "ui click" 45ms ui\n  tick: click 2ms >> hp 1200Hz | gain 0.6 decay 25ms\n';

describe('vary', () => {
  it('is deterministic in its seed, and different seeds differ', () => {
    expect(vary(SOURCE, 7)).toBe(vary(SOURCE, 7));
    expect(vary(SOURCE, 7)).not.toBe(vary(SOURCE, 8));
  });

  it('lands every value inside the range its author declared', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const slots = collectSlots(parse(vary(SOURCE, seed)));
      expect(slots).toHaveLength(3);
      for (const slot of slots) {
        expect(slot.value).toBeGreaterThanOrEqual(slot.min);
        expect(slot.value).toBeLessThanOrEqual(slot.max);
      }
    }
  });

  it('keeps the ranges, the structure and the comments exactly as written', () => {
    const before = parse(SOURCE);
    const after = parse(vary(SOURCE, 12345));

    expect(after.name).toBe(before.name);
    expect(after.category).toBe(before.category);
    expect(after.leading).toEqual(before.leading);
    expect(after.layers.map((l) => l.name)).toEqual(before.layers.map((l) => l.name));
    expect(after.layers.map((l) => l.chain.map((f) => f.name))).toEqual(
      before.layers.map((l) => l.chain.map((f) => f.name)),
    );
    expect(collectSlots(after).map((s) => [s.min, s.max])).toEqual(
      collectSlots(before).map((s) => [s.min, s.max]),
    );
  });

  it('leaves the numbers that carry no tilde alone', () => {
    const varied = vary(SOURCE, 99);
    /* The ramp target, the ramp time, the click width and every envelope number
       are not slots — a variation that moved them would be editing the design. */
    expect(varied).toContain('-> 1120Hz in 14ms');
    expect(varied).toContain('| gain 0.8 hold 3ms decay 38ms');
    expect(varied).toContain('edge: click 1ms');
  });

  it('produces a document that is still canonical', () => {
    const varied = vary(SOURCE, 4242);
    expect(serialize(parse(varied))).toBe(varied);
  });

  it('returns the input when there is nothing to roll', () => {
    expect(vary(NO_SLOTS, 1)).toBe(NO_SLOTS);
  });

  /* Text that does not parse has no search space; the recipe card is already
     reporting the error, so the button is a no-op rather than a crash. */
  it('returns the input when the recipe does not parse', () => {
    const broken = 'sound "s" 40ms pop\n  a: tone\n';
    expect(vary(broken, 1)).toBe(broken);
  });
});
