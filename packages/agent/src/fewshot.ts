/**
 * Choosing which stored recipes to show the model.
 *
 * ## The problem this solves
 *
 * The bank is the few-shot source, and the bank is allowed to contain a recipe the
 * validator rejects — `helicopter` rings for about four seconds behind a header
 * claiming 1.5, and the seeder loads it on purpose so the bank is not left without
 * its only looped texture (§8.2 of the plan). That is fine for a human reading the
 * gallery and wrong for a model reading examples: hand it `helicopter` and it may
 * imitate the flaw, then be refused by the same pipeline that supplied the example.
 *
 * ## The rule
 *
 * Prefer examples that pass validation. Fill the slate from clean recipes only; a
 * shorter example list is better than one the pipeline would refuse. Fall back to
 * flawed recipes **only when there are no clean ones at all** — a prompt with zero
 * examples teaches nothing about the shape of the language — and when that happens,
 * say which rule each one breaks so the model imitates the structure and not the
 * defect.
 *
 * This makes the question independent of what happens to `helicopter`: whether the
 * recipe is fixed, the invariant is relaxed, or neither, the agent stops learning
 * from an example the conveyor rejects.
 *
 * @packageDocumentation
 */

import type { Recipe } from '@txt2sfx/shared';
import { hasErrors, parse, validate } from '@txt2sfx/core';

/** One example, with the rules it breaks — empty for a clean recipe. */
export interface FewShotExample {
  readonly recipe: Recipe;
  /** Rule ids of the `error`-level issues, e.g. `duration.contract`. */
  readonly breaks: readonly string[];
}

/** A recipe left out, and why. */
export interface DroppedExample {
  readonly name: string;
  readonly breaks: readonly string[];
}

/** What {@link selectFewShot} decided. */
export interface FewShotSelection {
  /** Examples to show, best first. */
  readonly examples: readonly FewShotExample[];
  /** Flawed recipes excluded because clean ones were available. */
  readonly dropped: readonly DroppedExample[];
  /** True when every candidate was flawed and `examples` carries flaws. */
  readonly degraded: boolean;
}

/** Error-level rule ids of a stored recipe; `['parse-error']` if it does not parse. */
function breaksOf(recipe: Recipe): string[] {
  try {
    const issues = validate(parse(recipe.soundline));
    return hasErrors(issues)
      ? issues.filter((issue) => issue.severity === 'error').map((issue) => issue.rule)
      : [];
  } catch {
    /* Unreachable through `POST /api/recipes`, which parses before writing — but
       the bank is a file on disk and this function is the last line of defence
       before a broken example reaches a prompt. */
    return ['parse-error'];
  }
}

/**
 * Pick few-shot examples from retrieved recipes.
 *
 * @param recipes - Candidates in retrieval order (best match first).
 * @param k - How many to show. Three is the plan's number: enough to establish
 *   the shape, cheap enough to send in every prompt.
 */
export function selectFewShot(recipes: readonly Recipe[], k = 3): FewShotSelection {
  const clean: FewShotExample[] = [];
  const flawed: FewShotExample[] = [];

  for (const recipe of recipes) {
    const breaks = breaksOf(recipe);
    (breaks.length === 0 ? clean : flawed).push({ recipe, breaks });
  }

  if (clean.length > 0) {
    return {
      examples: clean.slice(0, k),
      dropped: flawed.map((example) => ({ name: example.recipe.name, breaks: example.breaks })),
      degraded: false,
    };
  }

  return { examples: flawed.slice(0, k), dropped: [], degraded: flawed.length > 0 };
}
