/**
 * Retrieval, and the line it must not cross.
 *
 * Every case here is one of the two honesty rules in `lib/retrieval.ts`: a bank answer
 * flagged `fallback` is a *miss* (top-rated recipes are not an answer to a prompt), and
 * nothing matching at all is `null` (the closest of a set of unrelated recipes is the
 * same lie with a local accent).
 */

import { describe, expect, it } from 'vitest';
import type { Recipe } from '@txt2sfx/shared';
import type { RecipeSource, RetrievedRecipes } from '@txt2sfx/agent';
import { retrieveBundled, retrieveForPrompt } from '../src/lib/retrieval.js';

const recipe = (name: string): Recipe =>
  ({
    id: 1,
    name,
    prompt: `${name} from the bank`,
    soundline: `sound "${name}" 40ms pop\n`,
    category: 'pop',
    tags: [],
    durationMs: 40,
    rating: 0,
    profile: {},
    createdAt: '2026-08-05T00:00:00.000Z',
  }) as unknown as Recipe;

/** A bank that answers with exactly what the test wants, and records what it was asked. */
function bankOf(answer: RetrievedRecipes): { source: RecipeSource; asked: { prompt: string; k: number }[] } {
  const asked: { prompt: string; k: number }[] = [];
  return {
    asked,
    source: {
      retrieve(prompt: string, k: number): Promise<RetrievedRecipes> {
        asked.push({ prompt, k });
        return Promise.resolve(answer);
      },
    },
  };
}

describe('retrieveForPrompt', () => {
  it("answers with the bank's top hit, asking for three", async () => {
    const bank = bankOf({ recipes: [recipe('metal-door'), recipe('runner-up')], fallback: false });
    const hit = await retrieveForPrompt('a heavy metal door slamming', bank.source);
    expect(hit).toEqual({
      name: 'metal-door',
      soundline: 'sound "metal-door" 40ms pop\n',
      prompt: 'metal-door from the bank',
      origin: 'bank',
    });
    expect(bank.asked).toEqual([{ prompt: 'a heavy metal door slamming', k: 3 }]);
  });

  /* The whole reason this module exists rather than a one-line call to `retrieve`. */
  it('treats a flagged fallback as a miss and searches the bundle instead', async () => {
    const bank = bankOf({ recipes: [recipe('top-rated-but-unrelated')], fallback: true });
    const hit = await retrieveForPrompt('sci-fi laser pistol zap', bank.source);
    expect(hit?.origin).toBe('bundled');
    expect(hit?.name).toBe('laser-pistol');
  });

  it('falls back to the bundle when the bank answered with nothing', async () => {
    const bank = bankOf({ recipes: [], fallback: false });
    const hit = await retrieveForPrompt('sci-fi laser pistol zap', bank.source);
    expect(hit?.origin).toBe('bundled');
  });

  it('searches the bundle when there is no bank at all', async () => {
    const hit = await retrieveForPrompt('crunching footstep in snow', null);
    expect(hit).toMatchObject({ name: 'footstep-snow', origin: 'bundled' });
    /* The preset's own declared prompt travels with it — it is what the honest note
       beside the recipe shows, and it is not the prompt that was typed. */
    expect(hit?.prompt).toContain('snow');
  });

  it('answers null when nothing overlaps, rather than with the least bad recipe', async () => {
    await expect(retrieveForPrompt('quokka origami', null)).resolves.toBeNull();
    /* Not a search term in any language this scorer can tokenize: an empty query must
       not match the first document by accident. */
    await expect(retrieveForPrompt('щупальца', null)).resolves.toBeNull();
    await expect(retrieveForPrompt('   ', null)).resolves.toBeNull();
  });
});

describe('the bundled search', () => {
  /* Presets are what makes the offline half worth having: they declare a prompt and
     tags, where an example only has a name and a comment. */
  it("ranks a preset's tags above an example's prose", () => {
    expect(retrieveBundled('sci-fi laser pistol zap')?.name).toBe('laser-pistol');
    /* …and still finds the reference set when that is what the words point at. */
    expect(retrieveBundled('blaster chirp')?.name).toBe('laser');
  });

  it("finds something for a preset's own declared prompt", () => {
    /* A preset whose prompt retrieves nothing is a preset nobody can reach without a
       key — the exact hole this phase exists to close. */
    for (const prompt of ['gentle notification ping', 'steady wind loop', 'wooden chest creaking open']) {
      expect(retrieveBundled(prompt)).not.toBeNull();
    }
  });
});
