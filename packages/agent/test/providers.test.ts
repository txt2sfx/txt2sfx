/**
 * The wire.
 *
 * Hand-written HTTP is the price of zero dependencies, so the request shapes are
 * pinned here rather than trusted: the failures these tests prevent are a 400 for a
 * parameter that no longer exists, a key leaked into a URL, and a truncated reply
 * read as a complete one. No sockets — `fetch` is injected.
 */

import { describe, expect, it, vi } from 'vitest';
import { ProviderError, anthropicProvider, geminiProvider, mockProvider } from '../src/index.js';
import type { FetchLike } from '../src/index.js';

/** A stub that answers with a canned JSON body and records what it was sent. */
function stub(bodies: readonly { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }[]): {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const spec = bodies[Math.min(index++, bodies.length - 1)] ?? {};
    const payload = spec.text ?? JSON.stringify(spec.json ?? {});
    return Promise.resolve(
      new Response(payload, {
        status: spec.status ?? 200,
        headers: { 'content-type': 'application/json', ...spec.headers },
      }),
    );
  };
  return { fetch, calls };
}

/** The parsed request body of call `n`. */
function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const MESSAGE = { role: 'user' as const, content: 'write a click' };

describe('anthropicProvider', () => {
  it('sends the documented shape and returns the text blocks', async () => {
    const { fetch, calls } = stub([
      {
        json: {
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: 'sound "tick" 45ms ui' },
            { type: 'text', text: '\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n' },
          ],
          stop_reason: 'end_turn',
        },
      },
    ]);
    const provider = anthropicProvider({ apiKey: 'sk-test', fetch, retryDelayMs: 0 });

    const text = await provider.complete({ system: 'contract', messages: [MESSAGE] });

    expect(text).toBe('sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n');
    const call = calls[0];
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = bodyOf(call ?? { init: {} });
    expect(body['model']).toBe('claude-opus-5');
    expect(body['system']).toBe('contract');
    expect(body['messages']).toEqual([{ role: 'user', content: 'write a click' }]);
  });

  /* Regression guard, not style: `temperature`, `top_p`, `top_k` and
     `thinking.budget_tokens` are rejected with a 400 on this model family, and the
     obvious "make it less random" edit is to add one of them. */
  it('sends no sampling parameters and no thinking configuration', async () => {
    const { fetch, calls } = stub([{ json: { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' } }]);
    await anthropicProvider({ apiKey: 'k', fetch, retryDelayMs: 0 }).complete({ messages: [MESSAGE] });
    const body = bodyOf(calls[0] ?? { init: {} });
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model']);
  });

  /* A refusal is a 200 with an empty `content`, so a caller reading the text first
     sees "no reply" and retries the same prompt forever. */
  it('reports a refusal as such, with its category', async () => {
    const { fetch } = stub([{ json: { content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } } }]);
    const provider = anthropicProvider({ apiKey: 'k', fetch, retryDelayMs: 0 });
    await expect(provider.complete({ messages: [MESSAGE] })).rejects.toThrow(/declined \(cyber\)/);
  });

  it('refuses to return a truncated reply as if it were complete', async () => {
    const { fetch } = stub([{ json: { content: [{ type: 'text', text: 'sound "half' }], stop_reason: 'max_tokens' } }]);
    const provider = anthropicProvider({ apiKey: 'k', fetch, retryDelayMs: 0, maxTokens: 64 });
    await expect(provider.complete({ messages: [MESSAGE] })).rejects.toThrow(/max_tokens \(64\)/);
  });

  it('retries a 429 and succeeds', async () => {
    const { fetch, calls } = stub([
      { status: 429, text: 'slow down', headers: { 'retry-after': '0' } },
      { json: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
    ]);
    const provider = anthropicProvider({ apiKey: 'k', fetch, retryDelayMs: 0 });
    await expect(provider.complete({ messages: [MESSAGE] })).resolves.toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 400, and keeps the server\'s explanation', async () => {
    const { fetch, calls } = stub([{ status: 400, text: 'temperature: unexpected field' }]);
    const provider = anthropicProvider({ apiKey: 'k', fetch, retryDelayMs: 0 });
    await expect(provider.complete({ messages: [MESSAGE] })).rejects.toThrow(/temperature: unexpected field/);
    expect(calls).toHaveLength(1);
  });

  it('retries a connection failure', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })),
      );
    const provider = anthropicProvider({ apiKey: 'k', fetch, retryDelayMs: 0 });
    await expect(provider.complete({ messages: [MESSAGE] })).resolves.toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget and says so as a ProviderError', async () => {
    const { fetch, calls } = stub([{ status: 529, text: 'overloaded' }]);
    const provider = anthropicProvider({ apiKey: 'k', fetch, retryDelayMs: 0, maxRetries: 1 });
    await expect(provider.complete({ messages: [MESSAGE] })).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(2);
  });

  it('rejects a missing key before spending a round trip on a 401', () => {
    const { fetch, calls } = stub([]);
    expect(() => anthropicProvider({ apiKey: '  ', fetch })).toThrow(/no API key/);
    expect(calls).toHaveLength(0);
  });
});

describe('geminiProvider', () => {
  it('sends the documented shape, with the key in a header and never in the URL', async () => {
    const { fetch, calls } = stub([
      { json: { candidates: [{ content: { parts: [{ text: 'recipe' }] }, finishReason: 'STOP' }] } },
    ]);
    const provider = geminiProvider({ apiKey: 'AIza-secret', fetch, retryDelayMs: 0 });

    const text = await provider.complete({
      system: 'contract',
      messages: [MESSAGE, { role: 'assistant', content: 'draft' }, { role: 'user', content: 'again' }],
    });

    expect(text).toBe('recipe');
    const call = calls[0];
    expect(call?.url).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
    /* A key in a query string lands in proxy logs, history and Referer headers. */
    expect(call?.url).not.toContain('AIza-secret');
    expect((call?.init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-secret');

    const body = bodyOf(call ?? { init: {} });
    expect(body['systemInstruction']).toEqual({ parts: [{ text: 'contract' }] });
    /* Gemini calls the assistant side `model`. */
    expect(body['contents']).toEqual([
      { role: 'user', parts: [{ text: 'write a click' }] },
      { role: 'model', parts: [{ text: 'draft' }] },
      { role: 'user', parts: [{ text: 'again' }] },
    ]);
  });

  it('reports a blocked prompt as a provider error', async () => {
    const { fetch } = stub([{ json: { promptFeedback: { blockReason: 'SAFETY' } } }]);
    const provider = geminiProvider({ apiKey: 'k', fetch, retryDelayMs: 0 });
    await expect(provider.complete({ messages: [MESSAGE] })).rejects.toThrow(/blocked \(SAFETY\)/);
  });

  it('treats a truncated candidate as a failure even though text arrived', async () => {
    const { fetch } = stub([
      { json: { candidates: [{ content: { parts: [{ text: 'sound "half' }] }, finishReason: 'MAX_TOKENS' }] } },
    ]);
    const provider = geminiProvider({ apiKey: 'k', fetch, retryDelayMs: 0, maxTokens: 32 });
    await expect(provider.complete({ messages: [MESSAGE] })).rejects.toThrow(/maxOutputTokens \(32\)/);
  });

  it('honours a model override', async () => {
    const { fetch, calls } = stub([
      { json: { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] } },
    ]);
    await geminiProvider({ apiKey: 'k', model: 'gemini-3-pro', fetch, retryDelayMs: 0 }).complete({
      messages: [MESSAGE],
    });
    expect(calls[0]?.url).toContain('gemini-3-pro:generateContent');
  });
});

describe('mockProvider', () => {
  it('answers from the script, in order, and keeps the transcript', async () => {
    const provider = mockProvider({ replies: ['first', 'second'] });
    await expect(provider.complete({ messages: [MESSAGE] })).resolves.toBe('first');
    await expect(provider.complete({ messages: [MESSAGE] })).resolves.toBe('second');
    expect(provider.requests).toHaveLength(2);
  });

  /* Running out is an error rather than a wrap-around: a cycling mock turns a loop
     bug into an endless conversation that reads as slowness. */
  it('throws when the script runs out', async () => {
    const provider = mockProvider({ replies: ['only'] });
    await provider.complete({ messages: [MESSAGE] });
    await expect(provider.complete({ messages: [MESSAGE] })).rejects.toThrow(/ran out of scripted replies/);
  });

  it('falls through to a function, for the playground and keyword answers', async () => {
    const provider = mockProvider({ reply: (request, index) => `${String(index)}:${request.messages.length}` });
    await expect(provider.complete({ messages: [MESSAGE] })).resolves.toBe('0:1');
  });
});
