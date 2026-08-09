/**
 * Answering a prompt with a recipe that already exists.
 *
 * ## Why this is not generation, and never says it is
 *
 * There used to be a `mock` provider that handed back a stored recipe under the name of
 * a new one, and it was removed for a reason written down in `lib/agent.ts`: an offer to
 * answer with something already in the catalog is not the same thing as generating, and a
 * playground that blurs the two teaches the wrong thing about what the pipeline does.
 *
 * This module is the honest version of the same convenience. It searches — and every
 * surface that reaches it says *search*: the button reads `Find in bank`, the log line
 * says `retrieved, not generated`, and a bank answer flagged `fallback` is treated as a
 * miss rather than as an answer (see below). Those three places are the whole of the
 * boundary; if a fourth surface appears it says the same thing or this module is wrong.
 *
 * ## Two sources, in that order
 *
 * 1. **The bank**, through the same {@link RecipeSource} the agent loop retrieves
 *    few-shot examples with — FTS over prompts and tags, which is exactly the index a
 *    natural-language request wants. Its `fallback: true` means *nothing matched, here
 *    are the top-rated recipes instead*. Loading one of those as the answer to a prompt
 *    is precisely the blurring described above, so it counts as a miss.
 * 2. **The bundle**, when the bank is offline or missed: `examples/` and `presets/`, both
 *    compiled into the page. The presets are what make this worth having — each declares
 *    a `# prompt:` and `# tags:` (see `presets/README.md`), so the offline search ranks
 *    against the same kind of text the bank's index holds, rather than against ten file
 *    names.
 *
 * Nothing matched means `null`. The alternative — the closest of a set of unrelated
 * recipes — is the bank's `fallback` in local clothes.
 *
 * @packageDocumentation
 */

import type { RecipeSource } from '@txt2sfx/agent';
import { parseWithDiagnostics } from '@txt2sfx/core';
import { bundledRecipes } from './examples.js';
import { bundledPresets } from './presets.js';

/** A recipe found for a prompt, with where it was found. */
export interface RetrievalHit {
  readonly name: string;
  readonly soundline: string;
  /** The prompt this recipe answers where it is stored — shown beside the honest note. */
  readonly prompt: string;
  /** `bank` is the running server; `bundled` is `examples/` and `presets/` in the page. */
  readonly origin: 'bank' | 'bundled';
}

/**
 * How many candidates the bank is asked for.
 *
 * Three, matching the agent loop's few-shot budget: the request is one round trip
 * either way, and seeing the runner-up in the response is what makes a bad top hit
 * debuggable from the network tab instead of from the server.
 */
const RETRIEVE_K = 3;

/**
 * Shortest word that is allowed to be a search term.
 *
 * Two characters and under is where English keeps its function words — `a`, `an`, `of`,
 * `in`, `to` — and a term that appears in most descriptions ranks everything equally,
 * which is the same as ranking nothing.
 */
const MIN_TOKEN = 3;

/**
 * The three- and four-letter function words the length rule lets through.
 *
 * Deliberately tiny. A long stop list is a second vocabulary to maintain, and the
 * scoring here is a tie-breaker between fifty short descriptions, not a search engine.
 */
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'out', 'its', 'sound']);

/**
 * A hit on a name or a tag counts double.
 *
 * A name and a tag are labels somebody chose for the sound; the prompt and the leading
 * comment are prose, and prose matches incidentally — "short" appears in a third of the
 * descriptions in `presets/` and in nobody's tags.
 */
const LABEL_WEIGHT = 2;

/** One searchable recipe, reduced to the two token sets that are scored. */
interface Document {
  readonly name: string;
  readonly source: string;
  readonly prompt: string;
  /** Tokens from the name and the tags — the author's chosen labels. */
  readonly labels: ReadonlySet<string>;
  /** Tokens from the prompt and any leading comment. */
  readonly prose: ReadonlySet<string>;
}

/** Words worth matching on, lowercased and de-duplicated by the caller's `Set`. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_TOKEN && !STOP.has(word));
}

/**
 * The bundled corpus, built once.
 *
 * Lazily and then cached: parsing ten examples to read their leading comments is cheap
 * but it is also the same answer every time — neither glob can change while the tab is
 * open. `bundledRecipes` is the build-time snapshot on purpose; the dev endpoint's
 * fresher list belongs to the gallery, not to a search that must also work in a static
 * build.
 */
let corpus: readonly Document[] | null = null;

function documents(): readonly Document[] {
  if (corpus !== null) return corpus;
  const built: Document[] = [];

  for (const recipe of bundledRecipes()) {
    /* An example carries no prompt — it was written, not asked for — but its author's
       comment above the header is a description, and it is the only prose there is. */
    const leading = parseWithDiagnostics(recipe.source).ast?.leading.join(' ') ?? '';
    built.push({
      name: recipe.name,
      source: recipe.source,
      prompt: leading.trim(),
      labels: new Set(tokens(recipe.name)),
      prose: new Set(tokens(leading)),
    });
  }

  for (const preset of bundledPresets()) {
    built.push({
      name: preset.name,
      source: preset.source,
      prompt: preset.prompt,
      labels: new Set([...tokens(preset.name), ...tokens(preset.tags.join(' '))]),
      prose: new Set(tokens(preset.prompt)),
    });
  }

  corpus = built;
  return corpus;
}

/** How well one document answers the query. Zero means "not at all", not "least bad". */
function score(query: readonly string[], document: Document): number {
  let total = 0;
  for (const word of new Set(query)) {
    if (document.labels.has(word)) total += LABEL_WEIGHT;
    else if (document.prose.has(word)) total += 1;
  }
  return total;
}

/**
 * The best bundled answer to `prompt`, or `null` when nothing overlaps.
 *
 * Exported because it is the half that has to work with nothing running at all, and a
 * pure function over the bundle can be held to that without a bank, a network or a key.
 */
export function retrieveBundled(prompt: string): RetrievalHit | null {
  const query = tokens(prompt);
  if (query.length === 0) return null;

  let best: Document | null = null;
  let bestScore = 0;
  for (const document of documents()) {
    const value = score(query, document);
    /* Strictly greater, so a tie keeps the earlier document: `examples/` before
       `presets/`, which is the same order of authority the catalog merges in. */
    if (value > bestScore) {
      best = document;
      bestScore = value;
    }
  }

  if (best === null) return null;
  return { name: best.name, soundline: best.source, prompt: best.prompt, origin: 'bundled' };
}

/**
 * Find a recipe that already answers `prompt` — the bank first, then the bundle.
 *
 * @param bank The bank's retrieval endpoint, or `null` when no bank is reachable. A
 *   result flagged `fallback` is a miss: see the module header.
 * @returns `null` when neither source matched, which the caller reports as "nothing
 *   matched — paste a key or attach an agent" rather than as a failure.
 */
export async function retrieveForPrompt(prompt: string, bank: RecipeSource | null): Promise<RetrievalHit | null> {
  if (prompt.trim() === '') return null;

  if (bank !== null) {
    /* `retrieve` swallows its own network failures into an empty result — a bank that
       is down costs this search its best source, not its answer. */
    const answer = await bank.retrieve(prompt, RETRIEVE_K);
    const top = answer.fallback ? undefined : answer.recipes[0];
    if (top !== undefined) {
      return { name: top.name, soundline: top.soundline, prompt: top.prompt, origin: 'bank' };
    }
  }

  return retrieveBundled(prompt);
}
