/**
 * Google Gemini provider (Generative Language API, `v1beta`).
 *
 * This is the provider the customer's requirement is about: the key is pasted
 * into the playground, lives in tab memory, and travels only in requests the
 * user started. Two consequences visible in the code:
 *
 * - **The key goes in the `x-goog-api-key` header, never in the query string.**
 *   The documented `?key=` form works, but a key in a URL lands in proxy logs,
 *   browser history and `Referer` headers — an unacceptable place for someone
 *   else's credential.
 * - **The model id is an option, not a constant to trust.** Gemini names move
 *   faster than this file will; the default is a current flash model because the
 *   loop is latency-sensitive and does many short calls, and the playground lets
 *   the user type any name.
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

const PROVIDER = 'gemini';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
/**
 * A current flash tier — the loop is latency-sensitive and makes many short calls.
 *
 * Kept a constant that is expected to go stale: `gemini-2.5-flash` was the default
 * here until Google closed it to new keys, and the failure is a 404 whose body says
 * so in plain words. That is why the id is an option everywhere it is used, and why
 * the playground lets the user type one.
 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';

const DEFAULT_MODEL = GEMINI_DEFAULT_MODEL;
const DEFAULT_MAX_TOKENS = 8192;

/** The bits of `:generateContent` we read. */
interface GenerateContentResponse {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly { readonly text?: string }[] };
    readonly finishReason?: string;
  }[];
  readonly promptFeedback?: { readonly blockReason?: string };
}

/** Why the candidate stopped, phrased for whoever has to act on it. */
function finishReasonMessage(reason: string, maxTokens: number): string | undefined {
  switch (reason) {
    case 'STOP':
      return undefined;
    case 'MAX_TOKENS':
      return `the reply hit maxOutputTokens (${String(maxTokens)}) and is truncated. Raise maxTokens.`;
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
      return 'the reply was blocked by a safety filter. Rephrase the sound description.';
    case 'RECITATION':
      return 'the reply was blocked as recitation.';
    default:
      return `the reply stopped for an unexpected reason (${reason}).`;
  }
}

/**
 * A provider backed by Gemini's `generateContent`.
 *
 * @param options - `apiKey` is the user's key, passed in by the caller.
 */
export function geminiProvider(options: HttpProviderOptions): LLMProvider {
  const key = requireKey(PROVIDER, options.apiKey);
  const model = options.model ?? DEFAULT_MODEL;
  const { fetch, maxRetries, retryDelayMs } = httpDefaults(options);
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  return {
    name: PROVIDER,
    model,
    async complete(request: CompletionRequest): Promise<string> {
      const maxTokens = request.maxTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS;

      const payload = await providerFetch({
        provider: PROVIDER,
        url: `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { 'x-goog-api-key': key },
        body: {
          ...(request.system === undefined
            ? {}
            : { systemInstruction: { parts: [{ text: request.system }] } }),
          /* Gemini calls the assistant side `model`; sending `assistant` is
             accepted by neither the schema nor the model. */
          contents: request.messages.map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
          generationConfig: { maxOutputTokens: maxTokens },
        },
        fetch,
        maxRetries,
        retryDelayMs,
        signal: request.signal,
      });

      const response = payload as GenerateContentResponse;

      if (response.promptFeedback?.blockReason !== undefined) {
        throw new ProviderError({
          provider: PROVIDER,
          message: `the prompt was blocked (${response.promptFeedback.blockReason}). Rephrase the sound description.`,
        });
      }

      const candidate = response.candidates?.[0];
      if (candidate === undefined) {
        throw new ProviderError({ provider: PROVIDER, message: 'the response carried no candidates' });
      }

      const text = (candidate.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('');

      const problem =
        candidate.finishReason === undefined
          ? undefined
          : finishReasonMessage(candidate.finishReason, maxTokens);
      /* A truncated or filtered reply is reported even when some text arrived:
         half a recipe is not a recipe, and the loop should not spend an
         iteration discovering that from a parse error. */
      if (problem !== undefined) throw new ProviderError({ provider: PROVIDER, message: problem });

      if (text.trim() === '') {
        throw new ProviderError({ provider: PROVIDER, message: 'the reply carried no text' });
      }

      return text;
    },
  };
}
