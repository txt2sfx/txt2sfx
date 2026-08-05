/**
 * The bench targets are data, and data in a repository rots.
 *
 * These tests are cheap (no renders, no optimizer) and guard the two ways a target
 * file goes quietly wrong: it stops parsing against the current grammar, or it stops
 * exercising the stage it was written for. A benchmark whose targets no longer
 * exercise anything still prints a table full of passes.
 */

import { describe, expect, it } from 'vitest';
import { hasErrors, parse, validate } from '@txt2sfx/core';
import { collectSlots } from '@txt2sfx/optimizer';
import { loadTargets } from '../src/targets.js';

const targets = loadTargets();

describe('bench targets', () => {
  it('there are targets, and each one names a reference recipe that exists', () => {
    expect(targets.length).toBeGreaterThanOrEqual(5);
    for (const target of targets) {
      /* `loadTargets` reads the reference from `examples/`, so a missing file would
         already have thrown — this asserts it was actually read. */
      expect(target.referenceSource).toContain('sound "');
      expect(() => parse(target.referenceSource)).not.toThrow();
    }
  });

  it('has unique names, so a row in the report identifies a file', () => {
    const names = targets.map((target) => target.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every scripted attempt parses against the current grammar', () => {
    for (const target of targets) {
      for (const [index, attempt] of target.scripted.entries()) {
        expect(() => parse(attempt), `${target.name} attempt ${String(index + 1)}`).not.toThrow();
      }
    }
  });

  /* The last attempt is the one the loop is expected to accept. If it stops
     validating, the target measures the repair loop's patience instead of the
     pipeline. */
  it('the final attempt of each target passes validation', () => {
    for (const target of targets) {
      const issues = validate(parse(target.scripted.at(-1) ?? ''));
      expect(hasErrors(issues), `${target.name}: ${issues.map((issue) => issue.rule).join(', ')}`).toBe(false);
    }
  });

  /* A multi-attempt target exists to exercise a repair path; identical attempts
     would exercise nothing and still pass. */
  it('multi-attempt targets really do change between attempts', () => {
    for (const target of targets.filter((candidate) => candidate.scripted.length > 1)) {
      const unique = new Set(target.scripted);
      expect(unique.size, target.name).toBe(target.scripted.length);
    }
  });

  it('single-attempt targets leave the optimizer something to fit', () => {
    for (const target of targets.filter((candidate) => candidate.scripted.length === 1)) {
      const slots = collectSlots(parse(target.scripted[0] ?? ''));
      expect(slots.length, target.name).toBeGreaterThan(0);
    }
  });

  it('states a threshold that is neither free nor impossible, and says what it exercises', () => {
    for (const target of targets) {
      expect(target.maxDistance, target.name).toBeGreaterThan(0);
      /* Different reference sounds sit at 0.36–0.60 in the plan's measured matrix;
         a threshold up there would pass on any sound at all. */
      expect(target.maxDistance, target.name).toBeLessThan(0.3);
      expect(target.exercises.length, target.name).toBeGreaterThan(20);
      expect(target.prompt.length, target.name).toBeGreaterThan(10);
    }
  });

  it('rejects an unknown --targets name instead of silently running nothing', () => {
    expect(() => loadTargets(['not-a-target'])).toThrow(/unknown target/);
    expect(loadTargets([targets[0]?.name ?? ''])).toHaveLength(1);
  });
});
