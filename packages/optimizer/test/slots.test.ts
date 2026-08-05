/**
 * Slot tests.
 *
 * The contract these have to nail down is narrow but unforgiving: a vector of
 * positions must produce a recipe that still parses, still round-trips, still
 * says what the author wrote everywhere the optimizer did not touch, and — the
 * one that is easy to get wrong — must produce the *same* recipe whether it was
 * applied as one vector or one slot at a time.
 */

import { describe, expect, it } from 'vitest';
import { parse, serialize } from '@txt2sfx/core';
import {
  applyVector,
  collectSlots,
  positionToValue,
  seedVector,
  valueToPosition,
  type Slot,
} from '../src/index.js';
import { loadExample } from './helpers/render.js';

const POP =
  'sound "pop" 55ms pop\n' +
  '  body: tone tri ~700Hz[500..1400] -> 1120Hz in 14ms >> lp ~2200Hz[900..4000] Q1 | gain 0.8 decay 38ms\n';

describe('collectSlots', () => {
  it('finds every tilde and nothing else', () => {
    const slots = collectSlots(parse(POP));
    expect(slots.map((s) => s.label)).toEqual(['tone freq', 'lp freq']);
    expect(slots.map((s) => s.value)).toEqual([700, 2200]);
    expect(slots.map((s) => [s.min, s.max])).toEqual([
      [500, 1400],
      [900, 4000],
    ]);
  });

  it('returns them in source order, whatever order the args were written', () => {
    const slots = collectSlots(parse(POP));
    expect(slots[0]?.loc.offset).toBeLessThan(slots[1]?.loc.offset ?? 0);
  });

  it('includes ramp targets and ramp times', () => {
    const slots = collectSlots(
      parse('sound "zap" 180ms laser\n  z: chirp saw 1800Hz -> ~220Hz[80..600] in ~120ms[40..200] | gain 0.6 decay 150ms\n'),
    );
    expect(slots.map((s) => s.label)).toEqual(['chirp freq ->', 'chirp freq in']);
  });

  it('includes the header duration, which belongs to no layer', () => {
    const slots = collectSlots(parse('sound "hit" ~700ms[400..1200] impact\n  b: sub 80Hz | gain 0.6 decay 300ms\n'));
    expect(slots[0]?.layer).toBeNull();
    expect(slots[0]?.label).toBe('duration');
  });

  it('finds nothing in a recipe with no slots', () => {
    expect(collectSlots(parse('sound "pop" 35ms pop\n  b: tone sine 900Hz | gain 0.8 decay 25ms\n'))).toEqual([]);
  });

  it('spans the number token only, leaving the tilde and the range alone', () => {
    const slots = collectSlots(parse(POP));
    const first = slots[0];
    expect(first).toBeDefined();
    expect(POP.slice(first?.loc.offset ?? 0, (first?.loc.offset ?? 0) + (first?.loc.length ?? 0))).toBe('700Hz');
  });
});

describe('position mapping', () => {
  it('round-trips a written value through position and back', () => {
    for (const slot of collectSlots(parse(POP))) {
      expect(positionToValue(slot, valueToPosition(slot, slot.value))).toBeCloseTo(slot.value, 0);
    }
  });

  it('maps the ends of the range to the ends of the interval', () => {
    const [slot] = collectSlots(parse(POP));
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    expect(positionToValue(slot, 0)).toBe(500);
    expect(positionToValue(slot, 1)).toBe(1400);
  });

  it('clamps a position outside the cube instead of extrapolating', () => {
    const [slot] = collectSlots(parse(POP));
    if (slot === undefined) return;
    expect(positionToValue(slot, -5)).toBe(500);
    expect(positionToValue(slot, 5)).toBe(1400);
  });

  /**
   * The reason the axis is logarithmic: on a linear `[500..1400]` Hz axis the
   * midpoint is 950 Hz, which is most of an octave away from the geometric
   * middle a listener would call halfway.
   */
  it('puts the perceptual middle of a frequency range at position 0.5', () => {
    const [slot] = collectSlots(parse(POP));
    if (slot === undefined) return;
    expect(positionToValue(slot, 0.5)).toBeCloseTo(Math.sqrt(500 * 1400), 0);
  });

  it('keeps dimensionless ranges linear', () => {
    const slots = collectSlots(parse('sound "hit" 700ms impact\n  b: sub 80Hz >> dist drive ~4[0..8] | gain 0.6 decay 300ms\n'));
    const slot = slots[0];
    if (slot === undefined) return;
    expect(positionToValue(slot, 0.5)).toBe(4);
  });

  it('rounds to what a recipe is written with', () => {
    const [slot] = collectSlots(parse(POP));
    if (slot === undefined) return;
    /* No 3218.7431640625Hz in a source file. */
    expect(Number.isInteger(positionToValue(slot, 0.371))).toBe(true);
  });

  /**
   * The parser refuses a range that does not increase, so this cannot arrive
   * through `parse`. The guard exists for a `Slot` built by hand — the type is
   * public — where the log map would otherwise divide by zero and hand the search
   * a NaN coordinate that quietly poisons every candidate derived from it.
   */
  it('rejects a degenerate range at the parser, and survives one built by hand', () => {
    expect(() => parse('sound "hit" 700ms impact\n  b: sub ~80Hz[80..80] | gain 0.6 decay 300ms\n')).toThrow(
      /must increase/,
    );

    const degenerate: Slot = {
      id: 'x',
      layer: 'b',
      label: 'sub freq',
      unit: 'Hz',
      value: 80,
      min: 80,
      max: 80,
      loc: { line: 1, column: 1, offset: 0, length: 4 },
    };
    expect(positionToValue(degenerate, 0.5)).toBe(80);
    expect(valueToPosition(degenerate, 80)).toBe(0);
  });
});

describe('applyVector', () => {
  it('writes every slot and leaves the rest of the text untouched', () => {
    const slots = collectSlots(parse(POP));
    const out = applyVector(POP, slots, [1, 0]);
    expect(out).toContain('~1400Hz[500..1400]');
    expect(out).toContain('~900Hz[900..4000]');
    expect(out).toContain('-> 1120Hz in 14ms');
    expect(out).toContain('| gain 0.8 decay 38ms');
  });

  it('produces text that parses and round-trips', () => {
    const slots = collectSlots(parse(POP));
    const out = applyVector(POP, slots, [0.3, 0.7]);
    expect(serialize(parse(out))).toBe(out);
  });

  /**
   * The offsets collected against the original text shift as soon as a
   * replacement changes length, which is why the edits go last-to-first. Applying
   * two slots at once must equal applying them one at a time.
   */
  it('agrees with applying one slot at a time', () => {
    const slots = collectSlots(parse(POP));
    const atOnce = applyVector(POP, slots, [0.9, 0.1]);

    let step = applyVector(POP, [slots[1]!], [0.1]);
    step = applyVector(step, collectSlots(parse(step)).slice(0, 1), [0.9]);
    expect(atOnce).toBe(step);
  });

  it('is a no-op for the seed vector, rounding aside', () => {
    const slots = collectSlots(parse(POP));
    expect(applyVector(POP, slots, seedVector(slots))).toBe(POP);
  });

  it('fills in missing coordinates from the source rather than writing NaN', () => {
    const slots = collectSlots(parse(POP));
    const out = applyVector(POP, slots, [0.5]);
    expect(out).toContain('~2200Hz[900..4000]');
    expect(out).not.toContain('NaN');
  });

  it('leaves a recipe with no slots exactly as it was', () => {
    const plain = 'sound "pop" 35ms pop\n  b: tone sine 900Hz | gain 0.8 decay 25ms\n';
    expect(applyVector(plain, [], [])).toBe(plain);
  });
});

describe('on the reference recipes', () => {
  it.each(['bubble-pop', 'helicopter', 'footstep-gravel', 'laser', 'powerup'])(
    '%s survives a full sweep of its slots to both extremes',
    (name) => {
      const source = loadExample(name);
      const slots = collectSlots(parse(source));
      expect(slots.length).toBeGreaterThan(0);
      for (const position of [0, 0.5, 1]) {
        const out = applyVector(source, slots, slots.map(() => position));
        expect(() => parse(out)).not.toThrow();
        expect(serialize(parse(out))).toBe(out);
      }
    },
  );
});
