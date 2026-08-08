/**
 * Likes, comments, reports, rate limits and moderation.
 *
 * Solo mode throughout, because what is under test here is the *rules* — who may
 * write what, how often, and what happens to it afterwards — and sign-in has its own
 * file. The one thing solo mode changes is that there is a single actor, which is
 * exactly what a rate-limit test wants.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AuthContext } from '../src/auth.js';
import { soloActor } from '../src/identity.js';
import { allowanceFor, limiter, standingOf } from '../src/limits.js';
import { openDatabase } from '../src/schema.js';
import { MAX_COMMENT_CHARS, checkComment } from '../src/social.js';
import { type Store, storeOver } from '../src/store.js';

const VALID = 'sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n';
const REPLY = 'sound "tick" 45ms ui\n  body: tone sine 2400Hz | gain 0.5 decay 18ms\n';

const SOLO: AuthContext = { mode: 'solo', adminToken: '' };
const MODERATED: AuthContext = { mode: 'solo', adminToken: 'admin-secret' };

let store: Store;
let app: FastifyInstance;

async function build(context: AuthContext = SOLO): Promise<void> {
  app = await buildApp({ store, auth: context });
}

/** Publish one recipe and return its id. */
async function publish(over: Record<string, unknown> = {}): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/recipes',
    payload: { name: 'tick', prompt: 'ui tick', soundline: VALID, ...over },
  });
  return response.json().recipe.id as number;
}

const comment = (id: number, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/recipes/${String(id)}/comments`, payload });

beforeEach(() => {
  store = storeOver(openDatabase(':memory:'));
});

afterEach(async () => {
  /* Guarded: the rule tests in this file are pure functions and never build an app. */
  if (app !== undefined) await app.close();
  app = undefined as unknown as FastifyInstance;
  store.close();
});

describe('what a comment may say', () => {
  /**
   * Comment spam is an economic activity and the payload is always a link. Removing
   * links removes the payoff — and costs nothing, because the only thing anyone here
   * needs to point at is another recipe.
   */
  it.each([
    'go to https://cheap-sounds.example now',
    'www.cheap-sounds.example',
    'find me at cheap-sounds.com',
    'HTTPS://SHOUTING.EXAMPLE/',
  ])('refuses %s', (body) => {
    expect(checkComment(body, false)?.rule).toBe('comment.no-links');
  });

  /**
   * The other half of the rule: it must not refuse ordinary sentences about sound,
   * or it will be deleted within a week and the spam will come back with it.
   */
  it.each([
    'the tail is about 40ms too long — try decay 25ms',
    'nice, but compare it with #12 — that one has more body',
    'e.g. the attack at 2.5ms reads as a click, not a tick',
    'sword-clash.wav from the reference set does this better',
    'gain 0.6 clips on my laptop at 44.1 kHz',
  ])('accepts %s', (body) => {
    expect(checkComment(body, false)).toBeNull();
  });

  it('wants either words or a sound, and not too many words', () => {
    expect(checkComment('   ', false)?.rule).toBe('comment.empty');
    expect(checkComment('', true)).toBeNull();
    expect(checkComment('x'.repeat(MAX_COMMENT_CHARS + 1), false)?.rule).toBe('comment.too-long');
  });
});

describe('POST /api/recipes/:id/comments', () => {
  beforeEach(async () => {
    await build();
  });

  it('stores a comment and lists it back with its author', async () => {
    const id = await publish();
    const response = await comment(id, { body: 'the tail is 40ms too long' });
    expect(response.statusCode).toBe(201);
    expect(response.json().comment.author.login).toBe('local');

    const listed = (await app.inject({ method: 'GET', url: `/api/recipes/${String(id)}/comments` })).json();
    expect(listed.comments).toHaveLength(1);
    expect(listed.comments[0].body).toBe('the tail is 40ms too long');
  });

  /**
   * A reply that carries a sound is the point of the whole feature — and it is held
   * to exactly what a published recipe is held to, which is also why a spammer
   * cannot use the valuable half of the form.
   */
  it('accepts a counter-proposal and renders it like a recipe', async () => {
    const id = await publish();
    const response = await comment(id, { body: 'brighter, like this', soundline: REPLY });
    expect(response.statusCode).toBe(201);
    expect(response.json().comment.soundline).toBe(REPLY);
    /* Stored as a comment, not promoted into the bank: it must not become few-shot
       material and must not compete for the unique fingerprint. */
    expect(store.recipes.count()).toBe(1);
  });

  it('refuses an attached sound that does not parse, that breaks an invariant, or that is silent', async () => {
    const id = await publish();

    const broken = await comment(id, { body: 'try', soundline: 'sound "x" 45ms ui\n  body: nosie white | gain 0.5 decay 20ms\n' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error).toBe('parse-error');

    const invalid = await comment(id, {
      body: 'try',
      soundline: 'sound "pop" 35ms pop\n  body: tone sine 2000Hz -> 200Hz in 120ms | gain 0.8 decay 25ms\n',
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error).toBe('invalid-soundline');

    const silent = await comment(id, {
      body: 'try',
      soundline: 'sound "hush" 45ms ui\n  body: tone sine 1800Hz | gain 0.0008 decay 25ms\n',
    });
    expect(silent.statusCode).toBe(422);
    expect(silent.json().error).toBe('silence');
  });

  it('reports a link with the reason and the alternative', async () => {
    const id = await publish();
    const response = await comment(id, { body: 'see https://example.com' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('comment.no-links');
    expect(response.json().message).toContain('#12');
  });

  it('404s a comment on a recipe that is not there', async () => {
    expect((await comment(999, { body: 'hello' })).statusCode).toBe(404);
  });

  it('counts visible comments on the recipe itself', async () => {
    const id = await publish();
    await comment(id, { body: 'one' });
    await comment(id, { body: 'two' });
    const recipe = (await app.inject({ method: 'GET', url: `/api/recipes/${String(id)}` })).json();
    expect(recipe.comments).toBe(2);
  });
});

describe('rate limits', () => {
  /**
   * A token bucket rather than a daily counter: "twenty a day" has to mean "not
   * twenty at once", and it must not all come back on a boundary everyone can see.
   */
  it('spends a burst, refuses with a retry hint, and refills over time', () => {
    const limits = limiter(store.db);
    const actor = soloActor(store.identity);
    const allowance = allowanceFor('recipe', 0);
    const start = new Date('2026-08-08T12:00:00Z');

    for (let i = 0; i < allowance.burst; i++) {
      expect(limits.spend(actor.id, 'recipe', start).allowed).toBe(true);
    }
    const refused = limits.spend(actor.id, 'recipe', start);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);

    /* Still refused a minute later — the whole point is that waiting is required. */
    expect(limits.spend(actor.id, 'recipe', new Date(start.getTime() + 60_000)).allowed).toBe(false);

    const later = new Date(start.getTime() + (refused.retryAfterSeconds + 1) * 1000);
    expect(limits.spend(actor.id, 'recipe', later).allowed).toBe(true);
  });

  it('never refills past the burst, however long the wait', () => {
    const limits = limiter(store.db);
    const actor = soloActor(store.identity);
    const start = new Date('2026-08-08T12:00:00Z');
    limits.spend(actor.id, 'comment', start);

    const muchLater = new Date(start.getTime() + 400 * 86_400_000);
    expect(limits.peek(actor.id, 'comment', muchLater)).toBe(allowanceFor('comment', 0).burst);
  });

  /**
   * The allowance is earned by *receiving* likes, not by giving them — otherwise the
   * way to buy a bigger allowance would be to press a button sixty times.
   */
  it('grows with the likes an account has collected', () => {
    const actor = soloActor(store.identity);
    expect(standingOf(store.db, actor.id)).toBe(0);
    expect(allowanceFor('recipe', 0).burst).toBeLessThan(allowanceFor('recipe', 10).burst);
    expect(allowanceFor('recipe', 10).burst).toBeLessThan(allowanceFor('recipe', 50).burst);
    /* And it stops. Standing should not eventually mean an unlimited megaphone. */
    expect(allowanceFor('recipe', 5000).burst).toBe(allowanceFor('recipe', 50).burst);
  });

  it('gives a token back when a write turned out to store nothing', () => {
    const limits = limiter(store.db);
    const actor = soloActor(store.identity);
    const now = new Date('2026-08-08T12:00:00Z');
    const before = limits.peek(actor.id, 'recipe', now);
    limits.spend(actor.id, 'recipe', now);
    limits.refund(actor.id, 'recipe', now);
    expect(limits.peek(actor.id, 'recipe', now)).toBe(before);
  });

  it('answers a rate-limited publish with 429 and Retry-After', async () => {
    await build();
    const burst = allowanceFor('recipe', 0).burst;
    /* Each one has to be a genuinely different sound, or the fingerprint check would
       answer 200 and charge nothing — which is itself the behaviour under test in
       `api.test.ts`. */
    for (let i = 0; i < burst; i++) {
      const response = await publishNth(i);
      expect(response).toBe(201);
    }
    const refused = await app.inject({
      method: 'POST',
      url: '/api/recipes',
      payload: { name: 'over', prompt: 'ui tick', soundline: soundlineAt(burst) },
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBeTruthy();
    expect(refused.json().message).toContain('likes');
  });

  const soundlineAt = (i: number): string =>
    `sound "tick" 45ms ui\n  body: tone sine ${String(1200 + i * 37)}Hz | gain 0.6 decay 25ms\n`;

  async function publishNth(i: number): Promise<number> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/recipes',
      payload: { name: `tick-${String(i)}`, prompt: 'ui tick', soundline: soundlineAt(i) },
    });
    return response.statusCode;
  }
});

describe('reports and moderation', () => {
  it('files a report once per person and never promises removal', async () => {
    await build();
    const id = await publish();
    const first = await app.inject({ method: 'POST', url: '/api/reports', payload: { target: 'recipe', id, reason: 'not a sound' } });
    expect(first.statusCode).toBe(202);
    expect(first.json().reports).toBe(1);
    expect(first.json().message).toContain('human');

    const again = await app.inject({ method: 'POST', url: '/api/reports', payload: { target: 'recipe', id, reason: 'still not' } });
    expect(again.json().reports).toBe(1);
  });

  it('404s a report against something that does not exist', async () => {
    await build();
    const response = await app.inject({ method: 'POST', url: '/api/reports', payload: { target: 'comment', id: 77, reason: 'x' } });
    expect(response.statusCode).toBe(404);
  });

  /** With no admin token the routes do not exist — a default password is worse than no feature. */
  it('hides the moderation routes entirely when no token is configured', async () => {
    await build();
    expect((await app.inject({ method: 'GET', url: '/api/moderation/reports' })).statusCode).toBe(404);
  });

  it('answers 404, not 401, to a wrong admin token', async () => {
    await build(MODERATED);
    const response = await app.inject({
      method: 'GET',
      url: '/api/moderation/reports',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('hides a recipe from every reader and keeps it for review', async () => {
    await build(MODERATED);
    const id = await publish();
    const headers = { authorization: 'Bearer admin-secret' };

    const hidden = await app.inject({ method: 'POST', url: `/api/moderation/recipes/${String(id)}/hidden`, headers, payload: {} });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().hidden).toBe(true);

    expect((await app.inject({ method: 'GET', url: `/api/recipes/${String(id)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/recipes' })).json().recipes).toEqual([]);
    expect(store.recipes.getForModeration(id)?.name).toBe('tick');

    const back = await app.inject({
      method: 'POST',
      url: `/api/moderation/recipes/${String(id)}/hidden`,
      headers,
      payload: { hidden: false },
    });
    expect(back.json().hidden).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/api/recipes/${String(id)}` })).statusCode).toBe(200);
  });

  it('hides one comment without touching the rest of the thread', async () => {
    await build(MODERATED);
    const id = await publish();
    const first = (await comment(id, { body: 'keep this one' })).json().comment.id;
    const second = (await comment(id, { body: 'hide this one' })).json().comment.id;

    await app.inject({
      method: 'POST',
      url: `/api/moderation/comments/${String(second)}/hidden`,
      headers: { authorization: 'Bearer admin-secret' },
      payload: {},
    });

    const listed = (await app.inject({ method: 'GET', url: `/api/recipes/${String(id)}/comments` })).json();
    expect(listed.comments.map((entry: { id: number }) => entry.id)).toEqual([first]);
  });

  it('shows a moderator everything one account wrote', async () => {
    await build(MODERATED);
    const id = await publish();
    await comment(id, { body: 'a note' });
    const actor = soloActor(store.identity);

    const body = (await app.inject({
      method: 'GET',
      url: `/api/moderation/actors/${String(actor.id)}`,
      headers: { authorization: 'Bearer admin-secret' },
    })).json();
    expect(body.recipes).toHaveLength(1);
    expect(body.comments).toBe(1);
  });
});

describe('likes as a store', () => {
  it('keeps the count derived from the rows rather than nudged', async () => {
    await build();
    const id = await publish();
    const actor = soloActor(store.identity);

    expect(store.social.like(id, actor.id)).toBe(1);
    expect(store.social.like(id, actor.id)).toBe(1);
    expect(store.recipes.get(id)?.rating).toBe(1);
    expect(store.social.hasLiked(id, actor.id)).toBe(true);

    expect(store.social.unlike(id, actor.id)).toBe(0);
    expect(store.recipes.get(id)?.rating).toBe(0);
  });
});
