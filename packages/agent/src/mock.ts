/**
 * A provider that answers from a script instead of a network.
 *
 * It exists for three jobs, and the third is the reason it is a shipped module
 * rather than a test fixture:
 *
 * 1. **Tests.** Every loop test drives the pipeline with exact replies, including
 *    deliberately broken ones, and never touches a key or a socket.
 * 2. **The playground's third provider option.** Someone opening the demo with no
 *    key still gets the full round trip — editor, sliders, export — with a canned
 *    recipe instead of a generated one.
 * 3. **The benchmark's default.** A scripted first attempt makes the numbers
 *    reproducible: the same targets, the same "model", so a change in the
 *    validator or the optimizer is the only thing that can move the score.
 *
 * Running out of replies is an error, not a wrap-around. A cycling mock turns a
 * loop bug into an infinite conversation that looks like slowness.
 *
 * @packageDocumentation
 */

import { ProviderError, type CompletionRequest, type LLMProvider } from './provider.js';

/** A mock keeps its transcript so tests can assert on what was sent. */
export interface MockProvider extends LLMProvider {
  /** Every request, in order. */
  readonly requests: readonly CompletionRequest[];
}

/** How the mock decides what to say. */
export interface MockProviderOptions {
  /** Replies in order, one per call. */
  readonly replies?: readonly string[];
  /** Or a function, for keyword-matched answers and the playground's demo mode. */
  readonly reply?: (request: CompletionRequest, index: number) => string;
  /** Shown in logs and bench output. Default `mock`. */
  readonly name?: string;
  readonly model?: string;
}

/**
 * Build a scripted provider.
 *
 * @param options - Either `replies` (consumed in order) or `reply` (called per
 *   request). Both is accepted: `replies` is used while it lasts, then `reply`.
 */
export function mockProvider(options: MockProviderOptions = {}): MockProvider {
  const requests: CompletionRequest[] = [];
  const replies = options.replies ?? [];

  return {
    name: options.name ?? 'mock',
    model: options.model ?? 'scripted',
    requests,
    async complete(request: CompletionRequest): Promise<string> {
      const index = requests.length;
      requests.push(request);

      const scripted = replies[index];
      if (scripted !== undefined) return scripted;
      if (options.reply !== undefined) return options.reply(request, index);

      throw new ProviderError({
        provider: options.name ?? 'mock',
        message: `ran out of scripted replies after ${String(replies.length)} (call ${String(index + 1)})`,
      });
    },
  };
}
