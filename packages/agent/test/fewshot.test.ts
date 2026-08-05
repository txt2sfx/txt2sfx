/**
 * Which recipes are allowed to become examples.
 *
 * This closes the review's warning about the bank feeding the agent its own
 * rejects: the bank holds `helicopter`, on which `validate` reports an error, and
 * an agent that imitates it gets refused by the same pipeline that showed it the
 * example. The rule is "prefer what validates", which resolves the contradiction
 * without deciding anything about the recipe itself.
 */

import { describe, expect, it } from 'vitest';
import { hasErrors, parse, validate } from '@txt2sfx/core';
import { selectFewShot } from '../src/index.js';
import { loadExample, storedRecipe } from './helpers/fixtures.js';

const CLEAN = ['coin', 'ui-click', 'bubble-pop', 'laser'].map((name) =>
  storedRecipe({ name, soundline: loadExample(name) }),
);
const HELICOPTER = storedRecipe({ name: 'helicopter', soundline: loadExample('helicopter') });

describe('selectFewShot', () => {
  /* Guards the premise. If `helicopter` ever becomes valid — by a DSP change, a
     relaxed invariant, or a raised category ceiling — this test says so instead of
     the suite silently testing nothing. */
  it('is testing against a bank recipe that really does fail validation', () => {
    expect(hasErrors(validate(parse(HELICOPTER.soundline)))).toBe(true);
    for (const recipe of CLEAN) {
      expect(hasErrors(validate(parse(recipe.soundline)))).toBe(false);
    }
  });

  it('drops the flawed recipe when clean ones are available', () => {
    const selection = selectFewShot([HELICOPTER, ...CLEAN], 3);
    expect(selection.examples.map((example) => example.recipe.name)).toEqual([
      'coin',
      'ui-click',
      'bubble-pop',
    ]);
    expect(selection.degraded).toBe(false);
    expect(selection.dropped).toEqual([
      { name: 'helicopter', breaks: ['duration.contract'] },
    ]);
  });

  it('keeps retrieval order among the clean ones', () => {
    const reversed = [...CLEAN].reverse();
    const selection = selectFewShot(reversed, 2);
    expect(selection.examples.map((example) => example.recipe.name)).toEqual(['laser', 'bubble-pop']);
  });

  /* Fewer examples beats an example the conveyor would refuse. */
  it('returns fewer than k rather than padding with flawed recipes', () => {
    const selection = selectFewShot([...CLEAN.slice(0, 1), HELICOPTER], 3);
    expect(selection.examples).toHaveLength(1);
  });

  /* But a prompt with no examples at all teaches nothing about the language, so a
     bank of nothing but flawed recipes still yields examples — labelled. */
  it('falls back to flawed examples only when there is no clean one, and says which rule', () => {
    const selection = selectFewShot([HELICOPTER], 3);
    expect(selection.degraded).toBe(true);
    expect(selection.examples).toHaveLength(1);
    expect(selection.examples[0]?.breaks).toEqual(['duration.contract']);
  });

  it('treats an unparseable stored recipe as flawed instead of throwing', () => {
    const broken = storedRecipe({ name: 'broken', soundline: 'sound "x" ???\n' });
    const selection = selectFewShot([broken], 3);
    expect(selection.examples[0]?.breaks).toEqual(['parse-error']);
  });

  it('answers an empty bank with an empty selection', () => {
    expect(selectFewShot([], 3)).toEqual({ examples: [], dropped: [], degraded: false });
  });
});
