/**
 * Putting a library's answer in the order a person would have put it.
 *
 * ## Why this exists at all
 *
 * A sound library ranks by text relevance over a name, a tag list and whatever the
 * uploader wrote. That ranking is good at *topic* and blind to *fit*: asked for "a
 * heavy wooden door slamming shut" it will happily put a 47-second field recording
 * called `door ambience` above a 900 ms slam, because both are about doors. The facts
 * that decide which one is useful — how long it is, what licence it carries, how many
 * channels it has — are in the same response and are not text, so the caller filters
 * and sorts on those in code before anything is asked of a model.
 *
 * What is left over is genuinely a judgement about words: does `metal_hit_03` with
 * tags `clang, sheet, hollow` answer "a rusty gate latch dropping"? That is this
 * module, and it is deliberately the only part of the search a model touches.
 *
 * ## It reorders; it never filters
 *
 * A recording the model does not mention keeps its place behind the ones it did. The
 * reason is the same one the optimizer's `anchor` exists for: a ranking that can drop
 * rows is a ranking that can silently return nothing, and "the library found eleven
 * things and you were shown two" is not recoverable by the person looking at the
 * screen. So {@link rankSounds} returns an *opinion about order*, the caller applies
 * it as a partial order, and a failed, timed-out or malformed reply costs exactly the
 * library's own ordering — which is what a search without this step would have shown.
 *
 * That is the same quiet-failure stance as {@link searchQuery} in `query.ts`, and for
 * the same reason: this step improves a result set, it is not a precondition for one.
 * Contrast `caption.ts`, which reports what it did, because there a bad answer costs
 * the render itself.
 *
 * @packageDocumentation
 */

import type { LLMProvider } from './provider.js';

/**
 * One recording, as the ranking model sees it.
 *
 * Name, duration and tags — deliberately not the uploader's description. Descriptions
 * in a public library are mostly provenance ("recorded with a Zoom H4n in my garage,
 * please credit me"), which is real text that says nothing about the sound and would
 * be most of the tokens in the call. Everything that *is* decisive and not text —
 * licence, channels, sample rate — is filtered in code before this point.
 */
export interface RankCandidate {
  readonly id: number;
  readonly name: string;
  readonly seconds: number;
  readonly tags: readonly string[];
}

/** One line of the model's answer: a recording, and why it is where it is. */
export interface Ranking {
  /** The candidate's id, guaranteed to be one that was offered. */
  readonly id: number;
  /** A short reason, shown next to the result. Empty when the model gave none. */
  readonly note: string;
}

/**
 * What the ranking model is told.
 *
 * The load-bearing rule is the last one. A model asked to rank a list will, unasked,
 * explain its method first and number its lines afterwards — and both of those parse
 * as ids. Asking for the bare form and then *checking* it (see {@link parseRanking})
 * is cheaper than trying to describe every shape to avoid.
 */
const SYSTEM = `You rank recordings from a sound library against a request for a sound effect.

You are given a request and a numbered list of recordings, each with a name, a duration
and tags. Judge how well each recording answers the request: the event and the material
matter most, then whether the duration is plausible for that event.

Reply with one line per recording you would put near the top, best first:

123 - short reason, at most eight words

Only ids from the list, at most one line each, no other text, no heading, no numbering
of your own. Leave out recordings you would not recommend.`;

/** Longest reply worth reading. A ranking that turns into an essay has already failed. */
const MAX_REPLY = 4000;

/** Longest reason kept, in characters. Anything longer is not a label, it is prose. */
const MAX_NOTE = 80;

/**
 * Read a ranking out of a model reply, keeping only ids that were offered.
 *
 * Separate from the call so every rule is testable without a provider, and strict on
 * purpose: the caller has a perfectly good fallback in the library's own order, so a
 * line that cannot be trusted is better dropped than guessed at.
 *
 * @param reply - What the model said.
 * @param offered - Ids that were in the prompt. An id outside this set is a
 *   hallucination, and letting one through would put a recording on screen that the
 *   search never returned.
 */
export function parseRanking(reply: string, offered: Iterable<number>): readonly Ranking[] {
  if (reply.length > MAX_REPLY) return [];
  const allowed = new Set(offered);
  const seen = new Set<number>();
  const out: Ranking[] = [];

  for (const line of reply.split('\n')) {
    /* An id at the start of the line, with whatever punctuation a model likes to put
       between it and its reason: `123 - x`, `123: x`, `123 — x`, `123. x`, `123 x`. */
    const match = /^\s*#?(\d{1,12})\s*[-–—:.)]*\s*(.*)$/.exec(line);
    if (match === null) continue;
    const id = Number(match[1]);
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    const note = (match[2] ?? '').trim().replace(/^["'`]|["'`]$/g, '').slice(0, MAX_NOTE);
    out.push({ id, note });
  }

  return out;
}

/** Options of {@link rankSounds}. */
export interface RankSoundsOptions {
  /** The request in the user's own words — any language. */
  readonly prompt: string;
  readonly candidates: readonly RankCandidate[];
  readonly provider: LLMProvider;
  readonly signal?: AbortSignal;
}

/**
 * Ask a model which of these recordings best answers the request.
 *
 * @returns The recordings it would put first, in its order, with a short reason each.
 *   Empty when there is nothing to rank, when the call fails, or when the reply cannot
 *   be read — never rejects. An empty result means "keep the order you had".
 */
export async function rankSounds(options: RankSoundsOptions): Promise<readonly Ranking[]> {
  const { candidates, prompt } = options;
  if (candidates.length === 0 || prompt.trim() === '') return [];

  const list = candidates
    .map((c) => `${String(c.id)} | ${c.name} | ${c.seconds.toFixed(1)}s | ${c.tags.slice(0, 8).join(', ')}`)
    .join('\n');

  try {
    const reply = await options.provider.complete({
      system: SYSTEM,
      messages: [{ role: 'user', content: `Request: ${prompt}\n\nRecordings:\n${list}` }],
      /* One line per candidate is about a dozen tokens; this caps a model that decides
         to write an introduction rather than billing for it. */
      maxTokens: 16 * candidates.length + 64,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return parseRanking(
      reply,
      candidates.map((c) => c.id),
    );
  } catch {
    return [];
  }
}
