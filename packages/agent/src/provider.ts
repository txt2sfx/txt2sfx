/**
 * What the loop needs from a language model, and nothing else.
 *
 * ## Why `fetch` and not a vendor SDK
 *
 * Two requirements decide this. The project's packages carry **zero runtime
 * dependencies** (§4 of the plan), and the playground has to work with a key the
 * user pastes into a browser tab — so the same provider code runs in Node and in
 * a page, and every byte of it ships to the browser. Both vendors expose one
 * JSON endpoint that a completion needs; an SDK per vendor would add two
 * dependency trees and a bundler problem to save a dozen lines of `fetch`.
 *
 * The cost is real and worth naming: retries, error mapping and response shapes
 * are ours to maintain, and a wire-format change breaks us where an SDK bump
 * would have fixed it. That is why every request shape here is documented with
 * the version it was written against, and why {@link providerFetch} centralizes
 * the retry policy instead of leaving it to each provider.
 *
 * @packageDocumentation
 */

/** One turn of the conversation. There is no system role — see {@link CompletionRequest}. */
export interface Message {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * One completion.
 *
 * `system` is a field rather than a `Message` with `role: 'system'` because both
 * vendors treat it as one: Anthropic takes a top-level `system`, Gemini a
 * `systemInstruction`. Flattening it into the message list would mean every
 * provider unflattening it again, and getting it wrong quietly — a system prompt
 * delivered as a user turn still produces plausible output.
 */
export interface CompletionRequest {
  readonly system?: string;
  readonly messages: readonly Message[];
  /** Upper bound on the reply. Providers have their own defaults; see each. */
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

/**
 * A language model the loop can talk to.
 *
 * Deliberately one method. Everything the loop does with a model is "here is the
 * conversation, give me the next message"; streaming, tool calls and structured
 * output would each be a second way to say the same thing, and the loop already
 * has a parser that is stricter than any schema a model can be handed.
 */
export interface LLMProvider {
  /** Short id used in logs and in the playground's provider picker. */
  readonly name: string;
  /** Which model this instance talks to — recorded in bench output. */
  readonly model: string;
  complete(request: CompletionRequest): Promise<string>;
}

/**
 * A provider call that failed.
 *
 * `retryable` is decided where the status code is known, not by the caller
 * inspecting a message: 429 and 5xx are worth another attempt, a 400 that says
 * the request shape is wrong will say it again forever.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(init: {
    provider: string;
    message: string;
    status?: number | undefined;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(`${init.provider}: ${init.message}`, init.cause === undefined ? {} : { cause: init.cause });
    this.name = 'ProviderError';
    this.provider = init.provider;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
  }
}

/** The slice of `fetch` a provider uses. Injected so tests never touch a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Options every HTTP-backed provider accepts. */
export interface HttpProviderOptions {
  /**
   * The user's key. Never read from a global by these providers — the playground
   * holds a pasted key in tab memory and passes it per call, and a provider that
   * silently fell back to `process.env` would use the wrong key exactly when the
   * two disagree.
   */
  readonly apiKey: string;
  readonly model?: string;
  /** Override for a proxy or a test double. */
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  /** Extra attempts after the first, for retryable failures. Default 2. */
  readonly maxRetries?: number;
  /** Base backoff in ms; doubles per attempt. Zero disables waiting (tests). */
  readonly retryDelayMs?: number;
  readonly maxTokens?: number;
}

/** Status codes worth another attempt. 529 is Anthropic's "overloaded". */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 529 || status >= 500;
}

/** How long to wait before attempt `n`, honouring `retry-after` when present. */
function backoffMs(base: number, attempt: number, retryAfter: string | null): number {
  if (base <= 0) return 0;
  const exponential = base * 2 ** attempt;
  if (retryAfter === null) return exponential;
  const seconds = Number(retryAfter);
  /* `retry-after` is authoritative when it is a number of seconds, but it is
     also a header a proxy can set to something absurd. Cap it at a minute so a
     bad value cannot park the loop for an hour. */
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds * 1000, exponential), 60_000) : exponential;
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST JSON, retry what is worth retrying, and turn everything else into a
 * {@link ProviderError} that names the provider and carries the server's own text.
 *
 * The server's text matters: both vendors explain a rejected request precisely
 * ("temperature: unexpected field"), and swallowing that in favour of "request
 * failed" would cost exactly the debugging session the message was written for.
 */
export async function providerFetch(options: {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  fetch: FetchLike;
  maxRetries: number;
  retryDelayMs: number;
  signal?: AbortSignal | undefined;
}): Promise<unknown> {
  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (attempt > 0) await sleep(backoffMs(options.retryDelayMs, attempt - 1, null));

    let response: Response;
    try {
      response = await options.fetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(options.body),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      /* A refused connection or a DNS failure is the most retryable failure
         there is, and it arrives as a thrown TypeError with no status. */
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError({ provider: options.provider, message: 'the request was aborted', cause: error });
      }
      lastError = new ProviderError({
        provider: options.provider,
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        cause: error,
      });
      continue;
    }

    if (response.ok) {
      try {
        return (await response.json()) as unknown;
      } catch (error) {
        throw new ProviderError({
          provider: options.provider,
          message: 'the response was not JSON',
          status: response.status,
          cause: error,
        });
      }
    }

    const detail = (await response.text().catch(() => '')).slice(0, 600);
    const error = new ProviderError({
      provider: options.provider,
      message: `HTTP ${String(response.status)}${detail === '' ? '' : ` — ${detail}`}`,
      status: response.status,
      retryable: retryableStatus(response.status),
    });
    if (!error.retryable) throw error;
    lastError = error;

    const wait = backoffMs(options.retryDelayMs, attempt, response.headers.get('retry-after'));
    if (wait > 0) await sleep(wait);
  }

  throw (
    lastError ??
    new ProviderError({ provider: options.provider, message: 'no attempt was made', retryable: false })
  );
}

/** Defaults applied by every HTTP provider, in one place. */
export function httpDefaults(options: HttpProviderOptions): {
  fetch: FetchLike;
  maxRetries: number;
  retryDelayMs: number;
} {
  return {
    fetch: options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    maxRetries: options.maxRetries ?? 2,
    retryDelayMs: options.retryDelayMs ?? 500,
  };
}

/** Reject an empty or blank key here rather than spending a round trip on a 401. */
export function requireKey(provider: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new ProviderError({
      provider,
      message: 'no API key. Pass one to the provider, or set it in the environment — the key is always the caller\'s.',
    });
  }
  return apiKey;
}
