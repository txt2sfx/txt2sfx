/**
 * `@txt2sfx/agent` — the language-model half of the pipeline.
 *
 * Three things live here, in increasing order of opinion:
 *
 * 1. **Providers** ({@link anthropicProvider}, {@link geminiProvider},
 *    {@link mockProvider}) behind a one-method {@link LLMProvider} interface. Plain
 *    `fetch`, no vendor SDK, so the same code runs in Node and in a browser tab
 *    holding a key the user pasted.
 * 2. **The contract and the prompt** ({@link llmsText}, {@link systemPrompt},
 *    {@link selectFewShot}). The grammar the model is taught is generated from the
 *    same tables the parser and validator use, and few-shot examples are filtered
 *    to recipes this pipeline would accept.
 * 3. **The loop** ({@link generateSound}): parse, validate, render, fit the numbers,
 *    and go back to the model only with a failure it can act on — and only ask for
 *    a structural change when the numerical optimizer is provably stuck.
 *
 * Zero runtime dependencies. The audio stack is injected, exactly as in the
 * optimizer: this package never constructs an `AudioContext`.
 *
 * @example
 * ```ts
 * import { generateSound, geminiProvider, httpBank } from '@txt2sfx/agent';
 *
 * const result = await generateSound({
 *   prompt: 'crisp ui click for a menu button',
 *   provider: geminiProvider({ apiKey }),
 *   render: renderSignal,
 *   bank: httpBank('http://127.0.0.1:8787'),
 * });
 * console.log(result.outcome, result.soundline);
 * ```
 *
 * @packageDocumentation
 */

export { ProviderError, httpDefaults, providerFetch, requireKey } from './provider.js';
export type {
  CompletionRequest,
  FetchLike,
  HttpProviderOptions,
  LLMProvider,
  Message,
} from './provider.js';

export { anthropicProvider } from './anthropic.js';
export { geminiProvider } from './gemini.js';
export { mockProvider } from './mock.js';
export type { MockProvider, MockProviderOptions } from './mock.js';

export { llmsText } from './contract.js';

export { selectFewShot } from './fewshot.js';
export type { DroppedExample, FewShotExample, FewShotSelection } from './fewshot.js';

export { httpBank, staticBank } from './bank.js';
export type { RecipeSource, RetrievedRecipes } from './bank.js';

export { extractSoundline, initialMessage, repairMessage, systemPrompt } from './prompts.js';
export type { Failure, InitialMessageOptions, SystemPromptOptions } from './prompts.js';

export { generateSound } from './loop.js';
export type { AgentEvent, Attempt, GenerateOptions, GenerateResult, Outcome } from './loop.js';
