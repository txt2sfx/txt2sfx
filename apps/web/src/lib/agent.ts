/**
 * The prompt bar's half of the pipeline: pick a model, run the loop, report it.
 *
 * Everything hard already lives in `@txt2sfx/agent` — `generateSound` parses,
 * validates, renders, fits the numbers and only goes back to the model with a
 * failure it can act on. What is left for the app is genuinely thin, and this
 * module is deliberately where the thin part lives so that `PromptBar.tsx` stays a
 * form and a log.
 *
 * Three things here are decisions rather than plumbing:
 *
 * 1. **The key never leaves this tab except in a request the user started.** It is
 *    React state, passed to the provider factory per run. No `localStorage`, no
 *    module-level cache, and the providers themselves never read an environment
 *    (see `provider.ts`) — so there is exactly one copy of it.
 * 2. **Anthropic needs an opt-in header to be callable from a page at all.** That
 *    header is a browser fact, not a provider fact, so it is added by the `fetch`
 *    the app injects rather than baked into the package that also runs in Node.
 * 3. **The mock provider answers from the local recipe set.** Someone opening the
 *    playground with no key still gets the whole round trip — retrieval, validator,
 *    render, optimizer, export — and the reply says plainly that no model was
 *    called.
 *
 * @packageDocumentation
 */

import type { SoundAST } from '@txt2sfx/shared';
import { parseWithDiagnostics } from '@txt2sfx/core';
import { extractProfile } from '@txt2sfx/analyzer';
import type { RenderFn, Target } from '@txt2sfx/optimizer';
import {
  ANTHROPIC_DEFAULT_MODEL,
  GEMINI_DEFAULT_MODEL,
  anthropicProvider,
  geminiProvider,
  mockProvider,
  type AgentEvent,
  type FetchLike,
  type LLMProvider,
} from '@txt2sfx/agent';
import { agentProvider, bridgeClient } from './bridge-client.js';
import { bridge } from './bridge.js';
import { render } from './engine.js';

/**
 * Which model the prompt row talks to.
 *
 * `agent` and `bridge` are the same idea at two different distances. `bridge` parks
 * the request on `window.txt2sfx` for whoever is holding devtools — a debugging
 * instrument, dev-only. `agent` sends it over the local bridge daemon to a coding
 * agent attached over MCP, which is a *feature*: that agent already holds a language
 * model, so it needs no key, and what it was missing is the validator, the renderer
 * and the ear this page provides. See `lib/bridge-client.ts` and `docs/BRIDGE.md`.
 */
export type ProviderKind = 'mock' | 'gemini' | 'anthropic' | 'agent' | 'bridge';

/** The picker's contents, in the order they are offered. */
export const ALL_PROVIDER_OPTIONS: readonly {
  readonly kind: ProviderKind;
  readonly label: string;
  readonly needsKey: boolean;
  /** Where the user gets a key — shown next to the field, not where it is sent. */
  readonly keySource?: string;
  /**
   * What gets called when the model box is left empty.
   *
   * Read from the provider modules rather than repeated here. Vendors retire model
   * ids on their own schedule — `gemini-2.5-flash` stopped accepting new keys and
   * started answering 404 — so this string is expected to move, and a copy of it in
   * the UI would eventually promise something the request does not do.
   */
  readonly defaultModel?: string;
  /** Dev-only entries are dropped from a static build's picker. */
  readonly devOnly?: boolean;
}[] = [
  { kind: 'mock', label: 'mock — no key', needsKey: false },
  {
    kind: 'agent',
    label: 'agent — your coding agent over MCP',
    needsKey: false,
  },
  {
    kind: 'bridge',
    label: 'bridge — answered in devtools',
    needsKey: false,
    devOnly: true,
  },
  {
    kind: 'gemini',
    label: 'Gemini',
    needsKey: true,
    keySource: 'aistudio.google.com/apikey',
    defaultModel: GEMINI_DEFAULT_MODEL,
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    needsKey: true,
    keySource: 'console.anthropic.com/settings/keys',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
  },
];

/**
 * What the picker offers.
 *
 * `dev` is passed in rather than read from `import.meta.env` here so this stays a
 * pure function: the bridge provider is a debugging instrument and has no business
 * in a static build's picker, and that rule is worth a test.
 */
export function providerOptions(dev: boolean): typeof ALL_PROVIDER_OPTIONS {
  return ALL_PROVIDER_OPTIONS.filter((option) => dev || option.devOnly !== true);
}

/** Whether a kind needs a key before Generate can do anything. */
export function needsKey(kind: ProviderKind): boolean {
  return ALL_PROVIDER_OPTIONS.find((option) => option.kind === kind)?.needsKey ?? false;
}

/**
 * The header that makes `api.anthropic.com` answer a browser at all.
 *
 * Without it the API refuses cross-origin requests from a page, and the failure
 * arrives as an opaque CORS error with no body to explain it. It is named
 * "dangerous" because sending a key from a browser exposes it to anything running
 * in that page — which is precisely the trade the user made by pasting their own
 * key into a local playground, knowingly, for one request at a time. Gemini needs
 * no equivalent.
 */
const ANTHROPIC_BROWSER_HEADER = 'anthropic-dangerous-direct-browser-access';

/** Wrap a `fetch` so Anthropic accepts it from a page. */
function browserFetch(base: FetchLike): FetchLike {
  return (url, init) =>
    base(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), [ANTHROPIC_BROWSER_HEADER]: 'true' },
    });
}

/** Options shared by the two key-carrying providers. */
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
export function keyedProvider(
  kind: 'gemini' | 'anthropic',
  apiKey: string,
  options: KeyedProviderOptions = {},
): LLMProvider {
  const platformFetch: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const common = {
    apiKey,
    ...(options.model === undefined || options.model === '' ? {} : { model: options.model }),
  };
  return kind === 'gemini'
    ? geminiProvider({ ...common, fetch: platformFetch })
    : anthropicProvider({ ...common, fetch: browserFetch(platformFetch) });
}

/** A recipe the mock provider can answer with. */
export interface DemoRecipe {
  readonly name: string;
  readonly soundline: string;
}

/** Words worth matching on — short function words match everything and rank nothing. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

/**
 * Rank the local recipes against a prompt.
 *
 * Token overlap against the name and the recipe text, name weighted higher — the
 * same shape as the bank's `bm25` column weights, for the same reason: "coin" in a
 * name is a stronger signal than "coin" somewhere in a comment.
 */
export function rankDemoRecipes(prompt: string, recipes: readonly DemoRecipe[]): readonly DemoRecipe[] {
  const wanted = new Set(tokenize(prompt));
  const scored = recipes.map((recipe) => {
    const name = new Set(tokenize(recipe.name));
    const body = new Set(tokenize(recipe.soundline));
    let score = 0;
    for (const token of wanted) {
      if (name.has(token)) score += 5;
      else if (body.has(token)) score += 1;
    }
    return { recipe, score };
  });
  /* A stable sort keeps the alphabetical order of the gallery among ties, so the
     demo answers the same way twice for the same prompt. */
  return scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.recipe);
}

/**
 * A provider that answers from the recipes already on the page.
 *
 * Each call hands back the next-best local match, so the loop's repair path is
 * exercised rather than stubbed: a rejected candidate is followed by a different
 * one. When the candidates run out it says so in one sentence, which the loop
 * reads as a refusal and reports verbatim — a mock that cycled forever would turn
 * a loop bug into something that merely looks slow.
 */
export function demoProvider(input: { prompt: string; recipes: readonly DemoRecipe[] }): LLMProvider {
  const ranked = rankDemoRecipes(input.prompt, input.recipes);

  return mockProvider({
    name: 'mock',
    model: 'local-recipes',
    reply: (_request, index) => {
      const recipe = ranked[index];
      if (recipe === undefined) {
        return ranked.length === 0
          ? 'The mock provider has no local recipes to answer with. Load the gallery, or paste a Gemini key to generate something new.'
          : `The mock provider is out of local candidates for this prompt (it tried ${String(ranked.length)}). Paste a Gemini or Anthropic key to have a model design something new.`;
      }
      return `Closest match in the local recipe set: \`${recipe.name}\`. No model was called — this is the mock provider.

\`\`\`soundline
${recipe.soundline.trimEnd()}
\`\`\`
`;
    },
  });
}

/* --- choosing one ------------------------------------------------------------- */

/**
 * The picker's state, reduced to what choosing a provider needs.
 *
 * Declared here rather than imported from `useGenerate.ts`, which owns the full
 * `ProviderSettings`: that module imports this one, and a type flowing back the other
 * way would be a cycle for the sake of three fields.
 */
export interface ProviderChoice {
  readonly kind: ProviderKind;
  readonly apiKey: string;
  /** Empty means "whatever the provider's default is". */
  readonly model: string;
}

/** What the mock provider needs to answer at all. */
export interface DemoContext {
  readonly prompt: string;
  readonly recipes: readonly DemoRecipe[];
}

/**
 * Build the provider the picker is pointing at.
 *
 * One place, because there are now two callers — the generate loop and the Model tab's
 * captioning step — and the second one arrived at exactly the moment a duplicate of
 * this `switch` would have started drifting.
 */
export function providerFor(choice: ProviderChoice, demo: DemoContext): LLMProvider {
  switch (choice.kind) {
    case 'mock':
      return demoProvider(demo);
    case 'agent':
      return agentProvider(bridgeClient);
    case 'bridge':
      return bridge.provider();
    default:
      return keyedProvider(choice.kind, choice.apiKey, { model: choice.model.trim() });
  }
}

/**
 * A provider that can write an English caption, or null when none can.
 *
 * Two departures from {@link providerFor}, both because captioning is translation
 * rather than sound design:
 *
 * - **The mock cannot do it.** It answers with the nearest local recipe, which is a
 *   soundline, not a sentence about ice. So when a bridge is live the attached coding
 *   agent is used instead — it already holds a language model, needs no key, and is on
 *   this machine for the same reason the reference model is. Failing that, null: the
 *   panel says so and leaves the field editable, which is better than a caption that
 *   is secretly a recipe.
 * - **A blank key is null, not an error.** The keyed providers throw on one, and
 *   throwing here would turn "you have not pasted a key" into a failed render.
 *
 * @param attached Whether a coding agent is attached to the bridge right now — not
 *   merely whether the daemon is up. A request parked on a bridge nobody is holding
 *   waits for its timeout, and a caption is not worth that. Passed in rather than read,
 *   so this stays a pure function — the same reason {@link providerOptions} takes `dev`.
 */
export function captionProviderFor(choice: ProviderChoice, attached: boolean): LLMProvider | null {
  if (choice.kind === 'mock' || choice.kind === 'agent') return attached ? agentProvider(bridgeClient) : null;
  if (choice.kind === 'bridge') return bridge.provider();
  return choice.apiKey.trim() === '' ? null : keyedProvider(choice.kind, choice.apiKey, { model: choice.model.trim() });
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
 * With the **mock** provider the reply *is* an existing recipe, so its header name collides
 * and comes back suffixed. That is the truth about what was returned, and more useful than
 * a fresh name on a recipe that is already in the catalog.
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
