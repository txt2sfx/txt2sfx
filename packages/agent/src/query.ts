/**
 * Turning a request into something retrieval can match.
 *
 * ## The failure this fixes
 *
 * The bank is English and its index is FTS5. A request written in any other
 * language matches nothing at all — «большой камень плюхнулся в озеро» finds zero
 * rows — so `retrieve` falls back to the top-rated recipes and the model is handed
 * three examples that have nothing to do with what was asked. The run then looks
 * fine (`3 example(s) (fallback)`) while the most valuable part of the prompt is
 * noise. The same happens, less dramatically, to an English request phrased as a
 * sentence: FTS matches words, and "a big stone plunging into a lake" shares none
 * with `splash`, `water` or `impact`.
 *
 * One short model call fixes both: a request in, a handful of English keywords out.
 *
 * ## Why it is allowed to fail quietly
 *
 * Retrieval is an improvement to the prompt, not a precondition for it — the same
 * stance `httpBank` takes about a bank being down. If the rewrite fails, times out
 * or comes back looking like prose, the original text is used and the run continues
 * with whatever the raw query matches. Spending an error on a step whose whole
 * purpose is *better examples* would be the wrong trade.
 *
 * @packageDocumentation
 */

import type { LLMProvider } from './provider.js';

/**
 * What the rewriting model is told.
 *
 * Short on purpose: this is a cheap call on a cheap model, and every rule here is
 * one the pipeline can check afterwards anyway. The instruction to keep the sound's
 * *material and event* words is the load-bearing part — "stone", "water", "splash"
 * are what the bank's `name` and `tags` columns actually contain, while adjectives
 * like "big" and "sudden" match nothing and dilute the ranking.
 */
const SYSTEM = `You turn a sound-effect request into search keywords for a sound library index.

Reply with 3 to 8 English keywords, space separated, nothing else. No punctuation, no
quotes, no explanation, no sentence.

Keep the words that name the material, the object and the event: stone, water, splash,
metal, door, coin, laser, footstep, gravel. Drop adjectives that describe degree rather
than sound ("big", "very", "nice"), and drop filler ("sound", "effect", "please").
Translate to English if the request is in another language.`;

/** Longest reply worth reading. A rewrite that rambles has already failed. */
const MAX_REPLY = 200;

/** Keep it to what an FTS query can use. */
const MAX_KEYWORDS = 8;

/**
 * Clean a model reply into a keyword line, or return nothing if it is not one.
 *
 * Separate from the call so the rules are testable without a provider, and strict
 * on purpose: the caller has a perfectly good fallback, so a reply that arrives as
 * a sentence is better rejected than trimmed into something misleading.
 */
export function parseKeywords(reply: string): string | undefined {
  if (reply.length > MAX_REPLY) return undefined;
  const first = reply
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (first === undefined) return undefined;

  const words = first
    .toLowerCase()
    /* Keep letters of any script — a rewrite that leaves one Russian word in is
       still better than the whole sentence — plus digits, which carry meaning in
       requests like "8 bit". */
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1)
    .slice(0, MAX_KEYWORDS);

  return words.length === 0 ? undefined : words.join(' ');
}

/** Options of {@link searchQuery}. */
export interface SearchQueryOptions {
  readonly prompt: string;
  readonly provider: LLMProvider;
  readonly signal?: AbortSignal;
}

/**
 * Rewrite a request as English keywords for retrieval.
 *
 * @returns The keyword line, or the original prompt when the rewrite is unusable.
 *   Never rejects: see the note above about why this step is not allowed to fail a
 *   run.
 */
export async function searchQuery(options: SearchQueryOptions): Promise<string> {
  try {
    const reply = await options.provider.complete({
      system: SYSTEM,
      messages: [{ role: 'user', content: options.prompt }],
      /* A keyword line is a dozen tokens. Capping it here also means a model that
         decides to explain itself gets cut off and rejected by `parseKeywords`
         rather than billed for a paragraph. */
      maxTokens: 64,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return parseKeywords(reply) ?? options.prompt;
  } catch {
    return options.prompt;
  }
}
