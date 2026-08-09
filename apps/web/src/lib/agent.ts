/**
 * The prompt bar's half of the pipeline: find a model, run the loop, report it.
 *
 * Everything hard already lives in `@txt2sfx/agent` — `generateSound` parses,
 * validates, renders, fits the numbers and only goes back to the model with a
 * failure it can act on. What is left for the app is genuinely thin, and this
 * module is deliberately where the thin part lives so that `PromptRow.tsx` stays a
 * form and a log.
 *
 * ## Why there is no picker any more
 *
 * There used to be five choices in a dropdown — mock, agent, bridge, Gemini,
 * Anthropic — and choosing between them was work the user had no way to do well.
 * Four of the five were the same answer to the same question ("who holds a language
 * model right now"), and the fifth, `mock`, answered a *different* question by
 * handing back an existing recipe under the name of a new one.
 *
 * So the choice is derived instead of asked for, and there are exactly two sources:
 *
 * 1. **An attached coding agent**, over the bridge. It already holds a model, it
 *    needs no key, and it is on this machine — see `lib/bridge-client.ts` and
 *    `docs/BRIDGE.md`. If one is attached it wins, always: it is free, it is the
 *    strongest model in the room, and the user configured it on purpose.
 * 2. **A Gemini key**, pasted by the user. The fallback for a tab with no agent.
 *
 * With neither, nothing is generated and the interface says so *before* the button
 * is pressed. That is the honest replacement for the mock: an offer to answer with
 * a recipe that is already in the catalog was never the same thing as generating.
 *
 * Which is exactly why the same offer is allowed back under its own name. `lib/retrieval.ts`
 * searches the bank and the bundled catalog for a recipe that already answers the prompt,
 * the button that runs it reads `Find in bank`, and the run's last line says `retrieved,
 * not generated`. The mock's sin was the label, not the lookup — so the lookup is here and
 * the label is the truth.
 *
 * ## The key never leaves this tab except in a request the user started
 *
 * It is React state, passed to the provider factory per run. No `localStorage`, no
 * module-level cache, and the providers themselves never read an environment (see
 * `provider.ts`) — so there is exactly one copy of it. A key that answered a run is also
 * encrypted into IndexedDB under a non-extractable key, and **forget it** undoes that;
 * `lib/keystore.ts` says what the encryption protects and what it does not.
 *
 * @packageDocumentation
 */

import type { SoundAST } from '@txt2sfx/shared';
import { parseWithDiagnostics } from '@txt2sfx/core';
import { extractProfile } from '@txt2sfx/analyzer';
import type { RenderFn, Target } from '@txt2sfx/optimizer';
import {
  GEMINI_DEFAULT_MODEL,
  geminiProvider,
  type AgentEvent,
  type FetchLike,
  type LLMProvider,
} from '@txt2sfx/agent';
import { agentProvider, bridgeClient } from './bridge-client.js';
import { render } from './engine.js';

/**
 * Who can answer a prompt in this tab.
 *
 * Two, and they are not alternatives a user picks between — see the header. `agent`
 * is whatever coding agent is attached to the bridge; `gemini` is the user's own key.
 */
export type ProviderKind = 'agent' | 'gemini';

/** Where a Gemini key comes from. Shown beside the field, not where it is sent. */
export const GEMINI_KEY_SOURCE = 'aistudio.google.com/apikey';

/**
 * What gets called when the model box is left empty.
 *
 * Re-exported from the provider module rather than repeated as a literal. Vendors
 * retire model ids on their own schedule — `gemini-2.5-flash` stopped accepting new
 * keys and started answering 404 — so this string is expected to move, and a copy of
 * it in the UI would eventually promise something the request does not do.
 */
export { GEMINI_DEFAULT_MODEL };

/** Options for the keyed provider. */
export interface KeyedProviderOptions {
  /** Override the default model, e.g. a cheaper Gemini tier. */
  readonly model?: string;
  /** Injected in tests; defaults to the platform `fetch`. */
  readonly fetch?: FetchLike;
}

/**
 * Build a provider from a pasted key.
 *
 * @throws `ProviderError` when the key is blank — better here than after a round
 *   trip that spends the user's quota to be told 401.
 */
export function keyedProvider(apiKey: string, options: KeyedProviderOptions = {}): LLMProvider {
  const platformFetch: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return geminiProvider({
    apiKey,
    ...(options.model === undefined || options.model === '' ? {} : { model: options.model }),
    fetch: platformFetch,
  });
}

/* --- choosing one ------------------------------------------------------------- */

/**
 * The settings, reduced to what choosing a provider needs.
 *
 * Declared here rather than imported from `useGenerate.ts`, which owns the full
 * `ProviderSettings`: that module imports this one, and a type flowing back the other
 * way would be a cycle for the sake of two fields.
 */
export interface ProviderChoice {
  readonly apiKey: string;
  /** Empty means "whatever the provider's default is". */
  readonly model: string;
}

/**
 * Which of the two will answer, or `null` when neither can.
 *
 * The whole decision, in one pure function, so the button's disabled state, the label
 * beside it, the dialog's headline and the run itself cannot disagree about who is
 * going to be called. `attached` is passed in rather than read for the same reason:
 * a status this function fetched itself could differ from the one on screen.
 *
 * @param attached Whether a coding agent is attached to the bridge *right now* — not
 *   merely whether the daemon is up. A request parked on a bridge nobody is holding
 *   waits for its timeout.
 */
export function chooseProvider(choice: ProviderChoice, attached: boolean): ProviderKind | null {
  if (attached) return 'agent';
  return choice.apiKey.trim() === '' ? null : 'gemini';
}

/**
 * Build the provider {@link chooseProvider} named.
 *
 * One place, because there are three callers — the generate loop, the Model tab's
 * captioning step and NeurosLoop's composer — and the third one arrived at exactly the
 * moment a duplicate of this branch would have started drifting.
 *
 * @returns `null` when nothing on this page can answer, which every caller treats as a
 *   state to report rather than as a failure to throw. The keyed provider throws on a
 *   blank key, and turning "you have not pasted a key" into a stack trace helps nobody.
 */
export function providerFor(choice: ProviderChoice, attached: boolean): LLMProvider | null {
  const kind = chooseProvider(choice, attached);
  if (kind === null) return null;
  return kind === 'agent' ? agentProvider(bridgeClient) : keyedProvider(choice.apiKey, { model: choice.model.trim() });
}

/**
 * A provider that can write an English caption, or null when none can.
 *
 * Now literally {@link providerFor}, and kept as a named function because the *reason*
 * a caption needs a model is different from the reason a recipe does — captioning is
 * translation, not sound design — and because the day the two diverge again it should
 * cost one edit here rather than a search for every call site that happened to reuse
 * the other one.
 */
export function captionProviderFor(choice: ProviderChoice, attached: boolean): LLMProvider | null {
  return providerFor(choice, attached);
}

/**
 * How a candidate becomes audio, for the loop and the optimizer.
 *
 * Samples are copied out of the `AudioBuffer`. In a browser that copy is cheap
 * insurance rather than a fix for the native-memory hazard the optimizer hit in
 * Node (§7.2 of the plan), but the rule is the rule: anything that outlives its
 * context owns its samples.
 */
export function renderSignalFor(seed: number): RenderFn {
  return async (ast: SoundAST) => {
    const result = await render(ast, { seed });
    return {
      samples: Float32Array.from(result.buffer.getChannelData(0)),
      sampleRate: result.buffer.sampleRate,
    };
  };
}

/**
 * Turn a decoded reference into an optimization target.
 *
 * Both halves are handed over: the profile is what the model is told to aim at,
 * and the signal is what the spectral half of the distance needs. Onset alignment
 * and peak matching happen inside the analyzer, so a reference with 125 ms of
 * pre-roll needs no trimming here.
 */
export function targetFromBuffer(buffer: AudioBuffer): Target {
  const signal = {
    samples: Float32Array.from(buffer.getChannelData(0)),
    sampleRate: buffer.sampleRate,
  };
  return { profile: extractProfile(signal), signal };
}

/**
 * Kebab-case a phrase into something that can be a file name.
 *
 * Returns an empty string rather than a placeholder when nothing survives, because the
 * caller has a better fallback than any placeholder this could invent.
 */
function slug(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-');
}

/** Used when neither the recipe nor the request yields a single usable character. */
const FALLBACK_NAME = 'sound';

/**
 * A recipe name for a generated sound, never colliding with one already shown.
 *
 * **The model names its own sound.** Every soundline header carries `sound "<name>"`,
 * written by the model that decided what it was building, right next to the category it
 * chose to be judged against — and the catalog used to throw that name away and file the
 * recipe under a slug of the request instead. The fallback is worse than it looks: `slug`
 * keeps ASCII, so a request in any non-Latin script collapsed to `sound`, `sound-2`,
 * `sound-3`, and a session of Russian prompts produced a rail of numbered nothings. The
 * prompt is still the fallback, for a reply whose header name is unusable.
 *
 * The header name is slugged rather than taken verbatim: `sound "ui click"` is legal and
 * this name is also a file name under `examples/`. That is the convention the reference set
 * already follows — `ui-click.soundline` holds `sound "ui click"`.
 *
 * A reply that *is* an existing recipe — a model handed a close few-shot example and asked
 * for something very like it — collides and comes back suffixed. That is the truth about
 * what was returned, and more useful than a fresh name on a recipe already in the catalog.
 *
 * Collisions get a numeric suffix instead of overwriting: two runs of "laser" are
 * two candidates to compare, and silently replacing the first would throw away the
 * comparison the user was in the middle of making.
 *
 * @param soundline The recipe as the model wrote it. Empty or unparseable falls back to
 *   the prompt — a candidate that does not parse is never filed under a name anyway.
 */
export function recipeName(soundline: string, prompt: string, taken: readonly string[]): string {
  const ast = soundline.trim() === '' ? null : parseWithDiagnostics(soundline).ast;
  const fromHeader = ast === null ? '' : slug(ast.name);
  const fromPrompt = slug(prompt);
  const base = fromHeader !== '' ? fromHeader : fromPrompt !== '' ? fromPrompt : FALLBACK_NAME;
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${String(n)}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${String(taken.length)}`;
}

/** Round for a log line: three decimals on a distance, none on a percentage. */
const d3 = (value: number): string => value.toFixed(3);

/**
 * One line of progress, phrased for someone watching the loop work.
 *
 * The events already carry everything worth showing, so the panel needs no logic
 * of its own; keeping the wording here also keeps it out of JSX, where it would be
 * harder to read and impossible to test.
 */
export function describeEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'request':
      return `→ asking the model (attempt ${String(event.iteration)})`;
    case 'reply':
      return `← reply, ${String(event.text.length)} chars`;
    case 'validated': {
      const errors = event.issues.filter((issue) => issue.severity === 'error').length;
      const warnings = event.issues.length - errors;
      const notes =
        event.issues.length === 0
          ? 'clean'
          : `${String(errors)} error(s), ${String(warnings)} warning(s)`;
      return `✓ parses and validates — ${notes}`;
    }
    case 'retrieval':
      /* The fallback is the point of showing this: three examples that matched
         nothing look exactly like three that did. */
      return event.count === 0
        ? `⌕ retrieval "${event.query}" — nothing`
        : `⌕ retrieval "${event.query}" — ${String(event.count)} example(s)${event.fallback ? ' (fallback, unrelated)' : ''}`;
    case 'rendered':
      return `▮ rendered, peak ${d3(event.peak)}`;
    case 'generation':
      /* Rendered as a live line that updates rather than appended, so a 44-generation
         fit does not bury the shape of the run. The distance, not the fitness: the
         fitness carries penalties the user did not ask about, and a live number that
         disagrees with the final verdict is worse than no live number. See `PromptBar`. */
      return `⚙ generation ${String(event.generation)} · distance ${d3(event.distance)}`;
    case 'optimized':
      return `⚙ fitted slots: ${d3(event.initialDistance)} → ${d3(event.distance)} (${event.stopped})`;
    case 'feedback':
      /* The full text goes back to the model; a log that reprinted it would bury
         the shape of the run in the detail of one repair. First line is enough to
         say which stage rejected the candidate. */
      return `↺ sent back: ${event.message.split('\n')[0] ?? ''}`;
    case 'done':
      return event.accepted ? `● accepted (${event.outcome})` : `● stopped: ${event.outcome}`;
  }
}
