/**
 * Where few-shot examples come from.
 *
 * An interface rather than an HTTP client with a hard-coded URL, because the three
 * callers are in three different positions: the playground talks to a bank over
 * the network, the benchmark may run with no bank at all, and a test wants a fixed
 * list of recipes with no server in the way. `retrieve` is the only thing the loop
 * asks for.
 *
 * Note what is *not* here: the contract document. The agent builds that locally
 * from the same tables the parser uses ({@link llmsText}), so the text is always in
 * step with the installed code and needs no round trip. `GET /api/llms.txt` exists
 * for agents that have not installed anything.
 *
 * @packageDocumentation
 */

import type { Recipe } from '@txt2sfx/shared';
import type { FetchLike } from './provider.js';

/** What a retrieval answered. */
export interface RetrievedRecipes {
  readonly recipes: readonly Recipe[];
  /**
   * True when nothing matched the prompt and these are top-rated recipes instead.
   *
   * Passed through rather than hidden: the loop still wants examples of the
   * language, but a caller that mistook a fallback for a match would report the
   * wrong thing about retrieval quality in the benchmark.
   */
  readonly fallback: boolean;
}

/** A source of stored recipes. */
export interface RecipeSource {
  retrieve(prompt: string, k: number): Promise<RetrievedRecipes>;
}

/** Recognize a recipe well enough to keep a malformed one out of a prompt. */
function isRecipe(value: unknown): value is Recipe {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['name'] === 'string' &&
    typeof candidate['soundline'] === 'string' &&
    typeof candidate['prompt'] === 'string'
  );
}

/**
 * A {@link RecipeSource} backed by a running bank server.
 *
 * Failures are swallowed into an empty result on purpose. Retrieval is an
 * improvement to the prompt, not a precondition for it: a bank that is down, slow
 * or serving something unexpected should cost the run its examples, not the run.
 * The contract document — the part the model cannot work without — is generated
 * locally and needs no server.
 *
 * @param baseUrl - Origin of the bank, e.g. `http://127.0.0.1:8787`.
 */
export function httpBank(baseUrl: string, options: { fetch?: FetchLike } = {}): RecipeSource {
  const origin = baseUrl.replace(/\/$/, '');
  const fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  return {
    async retrieve(prompt: string, k: number): Promise<RetrievedRecipes> {
      const url = `${origin}/api/retrieve?prompt=${encodeURIComponent(prompt)}&k=${String(k)}`;
      try {
        const response = await fetchImpl(url, { method: 'GET' });
        if (!response.ok) return { recipes: [], fallback: false };
        const body = (await response.json()) as { recipes?: unknown; fallback?: unknown };
        const recipes = Array.isArray(body.recipes) ? body.recipes.filter(isRecipe) : [];
        return { recipes, fallback: body.fallback === true };
      } catch {
        return { recipes: [], fallback: false };
      }
    },
  };
}

/** A {@link RecipeSource} over a fixed list — tests, and any offline caller. */
export function staticBank(recipes: readonly Recipe[]): RecipeSource {
  return {
    retrieve(_prompt: string, k: number): Promise<RetrievedRecipes> {
      return Promise.resolve({ recipes: recipes.slice(0, k), fallback: false });
    },
  };
}
