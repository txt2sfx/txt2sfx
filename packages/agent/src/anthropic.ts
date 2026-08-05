/**
 * Anthropic Messages API provider.
 *
 * Written against `anthropic-version: 2023-06-01` and the Claude 5 family
 * (`claude-opus-5` is the default). Three deliberate omissions, each of which
 * would be an error rather than a preference on these models:
 *
 * - **No `temperature` / `top_p` / `top_k`.** Removed on Opus 4.7 and later; a
 *   request that carries them is rejected with a 400. Variation, where we want
 *   it, comes from the prompt.
 * - **No `thinking` configuration.** Thinking is on by default on Opus 5 and
 *   `budget_tokens` no longer exists. We leave the default alone and never read
 *   the thinking blocks — the loop judges the soundline, not the reasoning.
 * - **No assistant prefill.** Ending the message list on an assistant turn to
 *   force a fenced block is a 400 on these models, so extraction is done on the
 *   reply instead (see `extractSoundline`).
 *
 * @packageDocumentation
 */

import {
  httpDefaults,
  providerFetch,
  requireKey,
  ProviderError,
  type CompletionRequest,
  type HttpProviderOptions,
  type LLMProvider,
} from './provider.js';

const PROVIDER = 'anthropic';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-opus-5';
const API_VERSION = '2023-06-01';

/**
 * Output budget.
 *
 * Generous for a document that is rarely 400 bytes because on Opus 5 `max_tokens`
 * bounds thinking **and** the reply together: a budget sized for the soundline
 * alone gets spent on reasoning and returns a truncated recipe.
 */
const DEFAULT_MAX_TOKENS = 8192;

/** Shape of the bits of a `POST /v1/messages` response we read. */
interface MessagesResponse {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly stop_reason?: string;
  readonly stop_details?: { readonly category?: string | null } | null;
}

/** Concatenate the text blocks, skipping thinking and anything else. */
function textOf(response: MessagesResponse): string {
  return (response.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
}

/**
 * A provider backed by the Anthropic Messages API.
 *
 * @param options - `apiKey` is required and is the caller's; nothing here reads
 *   the environment on its own.
 */
export function anthropicProvider(options: HttpProviderOptions): LLMProvider {
  const key = requireKey(PROVIDER, options.apiKey);
  const model = options.model ?? DEFAULT_MODEL;
  const { fetch, maxRetries, retryDelayMs } = httpDefaults(options);
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  return {
    name: PROVIDER,
    model,
    async complete(request: CompletionRequest): Promise<string> {
      const payload = await providerFetch({
        provider: PROVIDER,
        url: `${baseUrl}/v1/messages`,
        headers: { 'x-api-key': key, 'anthropic-version': API_VERSION },
        body: {
          model,
          max_tokens: request.maxTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(request.system === undefined ? {} : { system: request.system }),
          messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        },
        fetch,
        maxRetries,
        retryDelayMs,
        signal: request.signal,
      });

      const response = payload as MessagesResponse;

      /* `refusal` arrives as a successful 200 with an empty `content`, so a
         caller that reads the text first sees "the model returned nothing" and
         retries the same prompt forever. Check the stop reason first. */
      if (response.stop_reason === 'refusal') {
        const category = response.stop_details?.category ?? 'unspecified';
        throw new ProviderError({
          provider: PROVIDER,
          message: `the request was declined (${category}). Rephrase the sound description; the safety classifiers are not about audio.`,
        });
      }

      const text = textOf(response);

      if (response.stop_reason === 'max_tokens') {
        /* A truncated soundline parses as far as it goes and then fails on a
           half-written layer. Saying so is cheaper than one repair iteration
           spent rediscovering it. */
        throw new ProviderError({
          provider: PROVIDER,
          message: `the reply hit max_tokens (${String(request.maxTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS)}) and is truncated. Raise maxTokens.`,
        });
      }

      if (text.trim() === '') {
        throw new ProviderError({
          provider: PROVIDER,
          message: `the reply carried no text (stop_reason: ${response.stop_reason ?? 'none'})`,
        });
      }

      return text;
    },
  };
}
