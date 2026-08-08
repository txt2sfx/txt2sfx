/**
 * The playground's bank client.
 *
 * Every case here is a state the sidebar has to survive: no server, a server that
 * answers something else, a rejected recipe, and a retried write. The fetch is
 * injected, so none of it touches a network.
 */

import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@txt2sfx/agent';
import { BankError, DEFAULT_BANK_URL, bankClient } from '../src/lib/bank.js';
import type { SoundProfile } from '@txt2sfx/shared';

/** A `Response` stand-in over a JSON body. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Record every call, answer from a table keyed by "METHOD /path". */
function stub(routes: Record<string, () => Response | Promise<Response>>): {
  fetch: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = new URL(url).pathname;
    calls.push(`${method} ${path}`);
    const handler = routes[`${method} ${path}`];
    if (handler === undefined) return json(404, { error: 'not-found', message: 'no route' });
    return handler();
  };
  return { fetch, calls };
}

const PROFILE = {
  durationMs: 42,
  attackMs: 1,
  rmsEnvelope: [1, 0.5],
  centroidHz: [1000],
  flatness: 0.01,
  noiseRatio: 0.02,
  peakHz: 836,
  loudnessLufsApprox: -15,
} as unknown as SoundProfile;

const RECIPE = {
  id: 7,
  name: 'coin',
  prompt: 'coin pickup',
  soundline: 'sound "coin" 180ms pickup\n',
  profile: PROFILE,
  category: 'pickup',
  tags: [],
  durationMs: 180,
  rating: 3,
  createdAt: '2026-08-05T00:00:00.000Z',
};

describe('bank client', () => {
  it('defaults to loopback, matching the server', () => {
    expect(DEFAULT_BANK_URL).toBe('http://127.0.0.1:8787');
  });

  it('trims a trailing slash so URLs never double up', async () => {
    const { fetch, calls } = stub({ 'GET /api/health': () => json(200, { recipes: 10, grammar: 'soundline/v0' }) });
    const client = bankClient('http://127.0.0.1:8787/', { fetch });
    expect(client.baseUrl).toBe('http://127.0.0.1:8787');
    await client.health();
    expect(calls).toEqual(['GET /api/health']);
  });

  /* The whole point of the null: "offline" is a state the sidebar renders, not an
     exception the app has to catch in three places. */
  it('reports an unreachable bank as null rather than throwing', async () => {
    const client = bankClient(DEFAULT_BANK_URL, {
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(client.health()).resolves.toBeNull();
    await expect(client.list()).resolves.toEqual({ recipes: [], liked: new Set() });
    /* Reads answer with nothing; a write has to say what went wrong, because
       "you are over your allowance" and "your comment has a link in it" are the
       messages that tell somebody what to do next. */
    await expect(client.setLiked(1, true)).rejects.toThrow(/no bank at/);
  });

  it('reads health', async () => {
    const { fetch } = stub({
      'GET /api/health': () => json(200, { recipes: 10, grammar: 'soundline/v0', auth: 'github' }),
    });
    await expect(bankClient(DEFAULT_BANK_URL, { fetch }).health()).resolves.toEqual({
      recipes: 10,
      grammar: 'soundline/v0',
      auth: 'github',
    });
  });

  it('lists recipes and drops anything that is not one', async () => {
    const { fetch } = stub({
      'GET /api/recipes': () => json(200, { recipes: [RECIPE, { name: 'no id or soundline' }, 42], liked: [7] }),
    });
    const listed = await bankClient(DEFAULT_BANK_URL, { fetch }).list();
    expect(listed.recipes.map((recipe) => recipe.name)).toEqual(['coin']);
    /* The listing answers "which of these have I liked" in the same request — a heart
       that fills half a second after the grid settles reads as a bug. */
    expect([...listed.liked]).toEqual([7]);
  });

  it('publishes and reports what the bank created', async () => {
    let posted: unknown;
    const fetch: FetchLike = async (_url, init) => {
      posted = JSON.parse(String(init.body));
      return json(201, { recipe: RECIPE, created: true, warnings: [] });
    };
    const result = await bankClient(DEFAULT_BANK_URL, { fetch }).publish({
      name: 'coin',
      prompt: 'coin pickup',
      soundline: RECIPE.soundline,
      profile: PROFILE,
    });
    expect(result.created).toBe(true);
    expect(result.recipe.id).toBe(7);
    expect(posted).toMatchObject({ name: 'coin', prompt: 'coin pickup', tags: [] });
  });

  /* A retried write answers 200 with `created: false`, and the sidebar must say
     "already there" rather than claiming a second row exists. */
  it('distinguishes a duplicate from a fresh insert', async () => {
    const { fetch } = stub({
      'POST /api/recipes': () => json(200, { recipe: RECIPE, created: false, warnings: [] }),
    });
    const result = await bankClient(DEFAULT_BANK_URL, { fetch }).publish({
      name: 'coin',
      prompt: 'coin pickup',
      soundline: RECIPE.soundline,
      profile: PROFILE,
    });
    expect(result.created).toBe(false);
  });

  /* The one place errors are not swallowed: these messages were written to be
     acted on, and "save failed" would throw away the actionable half. */
  it('surfaces a rejection with its code, message and issues', async () => {
    const issues = [{ severity: 'error', layer: 'body', rule: 'pop.max-duration', got: '120ms', expected: '≤ 60ms', hint: 'shorten it' }];
    const { fetch } = stub({
      'POST /api/recipes': () =>
        json(422, { error: 'invalid-soundline', message: 'breaks a physical invariant', issues }),
    });
    const publish = bankClient(DEFAULT_BANK_URL, { fetch }).publish({
      name: 'pop',
      prompt: 'pop',
      soundline: 'sound "pop" 120ms pop\n',
      profile: PROFILE,
    });
    await expect(publish).rejects.toBeInstanceOf(BankError);
    await publish.catch((error: unknown) => {
      const failure = error as BankError;
      expect(failure.code).toBe('invalid-soundline');
      expect(failure.message).toContain('physical invariant');
      expect(failure.issues[0]?.rule).toBe('pop.max-duration');
    });
  });

  it('names the missing server when a publish cannot connect', async () => {
    const client = bankClient(DEFAULT_BANK_URL, { fetch: () => Promise.reject(new TypeError('fetch failed')) });
    await expect(
      client.publish({ name: 'x', prompt: 'x', soundline: 'sound "x" 40ms pop\n', profile: PROFILE }),
    ).rejects.toThrow(/no bank at http:\/\/127\.0\.0\.1:8787/);
  });

  it('rejects a 2xx that does not contain a recipe', async () => {
    const { fetch } = stub({ 'POST /api/recipes': () => json(201, { ok: true }) });
    await expect(
      bankClient(DEFAULT_BANK_URL, { fetch }).publish({
        name: 'x',
        prompt: 'x',
        soundline: 'sound "x" 40ms pop\n',
        profile: PROFILE,
      }),
    ).rejects.toThrow(/answered with something else/);
  });

  it('exposes retrieval for the agent, pointed at the same origin', async () => {
    const { fetch, calls } = stub({
      'GET /api/retrieve': () => json(200, { recipes: [RECIPE], fallback: false }),
    });
    const retrieved = await bankClient(DEFAULT_BANK_URL, { fetch }).recipes.retrieve('coin pickup', 3);
    expect(retrieved.recipes.map((recipe) => recipe.name)).toEqual(['coin']);
    expect(retrieved.fallback).toBe(false);
    expect(calls).toEqual(['GET /api/retrieve']);
  });
});
