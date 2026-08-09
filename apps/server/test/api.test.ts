/**
 * HTTP tests, driven through `app.inject()`.
 *
 * The real routes, the real validator, a real in-memory bank — no mocks. What is
 * under test is mostly the contract at the edge: status codes, and whether a
 * rejection tells its caller enough to fix the problem. The caller is a language
 * model in a loop, so "enough" means the exact rule and a hint, not "invalid
 * request".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parse } from '@txt2sfx/core';
import { buildApp } from '../src/app.js';
import type { AuthContext } from '../src/auth.js';
import { measure } from '../src/render.js';
import { SCHEMA_VERSION, openDatabase } from '../src/schema.js';
import { type Store, storeOver } from '../src/store.js';
/* Seeded with `examples/` alone, not the seeder's default. These tests are about
   what the API does with a populated bank, and the shipped `presets/` catalog would
   add fifty renders per call for nothing — plus a second recipe answering to the
   word "pickup", which is the very ranking these assertions pin. */
import { EXAMPLES_DIR, seedBank } from '../src/seed.js';

const VALID = 'sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n';

/**
 * Solo mode, which is what a bank with no identity provider configured is.
 *
 * These tests are about the recipe contract rather than about sign-in, and against
 * the solo actor each of them stays one request long. `auth.test.ts` covers what
 * changes once GitHub is configured.
 */
const SOLO: AuthContext = { mode: 'solo', adminToken: '' };

let store: Store;
let bank: Store['recipes'];
let app: FastifyInstance;

beforeEach(async () => {
  store = storeOver(openDatabase(':memory:'));
  bank = store.recipes;
  app = await buildApp({ store, auth: SOLO });
});

afterEach(async () => {
  await app.close();
  store.close();
});

/** POST a recipe, with sensible defaults for everything not under test. */
const post = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/recipes', payload: { name: 'tick', prompt: 'ui tick', soundline: VALID, tags: ['ui'], ...body } });

describe('GET /api/health', () => {
  it('reports liveness, size and the grammar version', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      recipes: 0,
      grammar: 'soundline/v0',
      schema: SCHEMA_VERSION,
      auth: 'solo',
      renderQueue: 0,
    });
  });
});

describe('POST /api/recipes', () => {
  it('stores a valid recipe and echoes it back with an id', async () => {
    const response = await post({});
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.recipe.id).toBeGreaterThan(0);
    expect(body.recipe.name).toBe('tick');
    expect(body.warnings).toEqual([]);
    expect(bank.count()).toBe(1);
  });

  /** The soundline is the source of truth; a body cannot contradict it. */
  it('reads category and duration from the soundline, not from the body', async () => {
    const response = await post({ category: 'explosion', durationMs: 9999 });
    const recipe = response.json().recipe;
    expect(recipe.category).toBe('ui');
    expect(recipe.durationMs).toBe(45);
  });

  it('rejects a soundline that does not parse, with line and column', async () => {
    const response = await post({ soundline: 'sound "x" 45ms ui\n  body: nosie white | gain 0.5 decay 20ms\n' });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('parse-error');
    expect(body.message).toMatch(/line 2, col \d+/);
    /* The synonym dictionary earns its keep here: the model wrote a typo and gets
       told the word it meant. */
    expect(body.message).toContain('noise');
    expect(bank.count()).toBe(0);
  });

  /**
   * The plan's requirement for this endpoint: validate before writing. 422 rather
   * than 400 because the request was well-formed — the *sound* is wrong.
   */
  it('rejects a soundline that breaks a physical invariant, with hints', async () => {
    const response = await post({
      soundline: 'sound "pop" 35ms pop\n  body: tone sine 2000Hz -> 200Hz in 120ms | gain 0.8 decay 25ms\n',
    });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe('invalid-soundline');
    expect(body.issues.map((issue: { rule: string }) => issue.rule)).toContain('pop.max-freq-ramp');
    const ramp = body.issues.find((issue: { rule: string }) => issue.rule === 'pop.max-freq-ramp');
    expect(ramp.hint).toBeTruthy();
    expect(ramp.severity).toBe('error');
    expect(bank.count()).toBe(0);
  });

  it('accepts a recipe with warnings and hands the warnings back', async () => {
    const response = await post({
      name: 'thud',
      soundline: 'sound "pop" 35ms pop\n  body: tone sine 480Hz -> 80Hz in 12ms | gain 0.9 decay 25ms\n',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().warnings.map((issue: { rule: string }) => issue.rule)).toContain('pop.rising-resonance');
  });

  it.each([
    ['missing-soundline', { soundline: '' }],
    ['missing-name', { name: '' }],
    ['missing-prompt', { prompt: '' }],
  ])('answers %s with an actionable message', async (error, body) => {
    const response = await post(body);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(error);
    expect(response.json().message.length).toBeGreaterThan(20);
  });

  /**
   * The profile used to arrive on trust. It is measured here now, which is what
   * makes it honest — and what makes a write cost the work it claims to be worth.
   * A posted profile is accepted and ignored, so an older client keeps working.
   */
  it('measures the profile itself and ignores whatever the body claimed', async () => {
    const lie = {
      durationMs: 9999,
      attackMs: 1,
      rmsEnvelope: [1],
      centroidHz: [1],
      flatness: 0,
      noiseRatio: 0,
      peakHz: 1,
      loudnessLufsApprox: -1,
    };
    const body = (await post({ profile: lie })).json();
    expect(body.recipe.profile.durationMs).not.toBe(9999);
    expect(body.recipe.profile.peakHz).toBeGreaterThan(1000);
    expect(body.measured.peak).toBeGreaterThan(0);
  });

  /**
   * Nothing that is not a sound can be stored — which is why this system has no
   * field for a spammer to write a message into.
   */
  it('refuses a recipe that renders to silence', async () => {
    const response = await post({
      name: 'nothing',
      soundline: 'sound "hush" 45ms ui\n  body: tone sine 1800Hz | gain 0.0008 decay 25ms\n',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('silence');
    expect(bank.count()).toBe(0);
  });

  /**
   * A retrying agent is the normal client, not the exception. Two identical rows
   * are worse than a dropped write: both get retrieved, both get used as few-shot
   * examples, and votes split between them.
   */
  it('is safe to retry: an identical repost stores nothing new', async () => {
    const first = await post({});
    const second = await post({});
    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().recipe.id).toBe(first.json().recipe.id);
    expect(bank.count()).toBe(1);
  });

  it('still stores a genuinely different recipe under the same name', async () => {
    await post({});
    const changed = await post({
      soundline: 'sound "tick" 45ms ui\n  body: tone sine 2100Hz | gain 0.6 decay 25ms\n',
    });
    expect(changed.statusCode).toBe(201);
    expect(bank.count()).toBe(2);
  });

  /**
   * Reformatting is not a new recipe. Identity is the canonical form, which is the
   * wall a thousand reposts under a thousand names run into.
   */
  it('treats a reformatted repost as the same recipe', async () => {
    const first = await post({});
    const again = await post({ name: 'tick-again', soundline: VALID.replace('  body:', '    body:') });
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    expect(again.json().recipe.id).toBe(first.json().recipe.id);
    expect(bank.count()).toBe(1);
  });

  it('records who published it and what it was derived from', async () => {
    const parent = (await post({})).json().recipe;
    const child = await post({
      name: 'tick-bright',
      soundline: 'sound "tick" 45ms ui\n  body: tone sine 2400Hz | gain 0.6 decay 25ms\n',
      parentId: parent.id,
    });
    expect(child.statusCode).toBe(201);
    expect(child.json().recipe.parentId).toBe(parent.id);
    expect(child.json().recipe.author.login).toBe('local');
  });

  it('refuses a parent that does not exist rather than dropping the link', async () => {
    const response = await post({ parentId: 4242 });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('unknown-parent');
  });
});

describe('GET /api/recipes', () => {
  beforeEach(async () => {
    await post({});
    await post({
      name: 'boom',
      prompt: 'big explosion',
      soundline: 'sound "boom" 900ms explosion\n  body: sub 70Hz | gain 0.7 decay 800ms\n',
      tags: ['explosion'],
    });
  });

  it('lists everything, newest first', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/recipes' })).json();
    expect(body.count).toBe(2);
    expect(body.recipes[0].name).toBe('boom');
  });

  it('searches', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/recipes?q=explosion' })).json();
    expect(body.recipes.map((r: { name: string }) => r.name)).toEqual(['boom']);
  });

  it('filters by category', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/recipes?category=ui' })).json();
    expect(body.recipes.map((r: { name: string }) => r.name)).toEqual(['tick']);
  });

  it('names the valid categories when given a bad one', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/recipes?category=explosions' });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('explosion');
  });

  it('caps a limit instead of trusting it', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/recipes?limit=99999' })).json();
    expect(body.count).toBe(2);
  });
});

describe('GET /api/recipes/:id', () => {
  it('returns one recipe', async () => {
    const id = (await post({})).json().recipe.id;
    const response = await app.inject({ method: 'GET', url: `/api/recipes/${String(id)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('tick');
  });

  it('404s an unknown id and 400s a non-numeric one', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/recipes/999' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/recipes/abc' })).statusCode).toBe(400);
  });
});

describe('PUT and DELETE /api/recipes/:id/like', () => {
  const like = (id: number, method: 'PUT' | 'DELETE' = 'PUT') =>
    app.inject({ method, url: `/api/recipes/${String(id)}/like` });

  /**
   * The old endpoint took `{ delta: ±1 }` from anybody, so a rating was whatever the
   * last script to run said it was. A like belongs to one person and is therefore
   * idempotent: pressing it twice is one like, everywhere in the system.
   */
  it('is idempotent in both directions', async () => {
    const id = (await post({})).json().recipe.id;
    expect((await like(id)).json()).toEqual({ id, rating: 1, liked: true });
    expect((await like(id)).json()).toEqual({ id, rating: 1, liked: true });
    expect((await like(id, 'DELETE')).json()).toEqual({ id, rating: 0, liked: false });
    expect((await like(id, 'DELETE')).json()).toEqual({ id, rating: 0, liked: false });
  });

  it('reports back which recipes the caller has liked, in one request', async () => {
    const id = (await post({})).json().recipe.id;
    await like(id);
    const body = (await app.inject({ method: 'GET', url: '/api/recipes' })).json();
    expect(body.liked).toEqual([id]);
  });

  it('404s a like for a recipe that is not there', async () => {
    expect((await like(999)).statusCode).toBe(404);
  });
});

describe('GET /api/retrieve', () => {
  it('demands a prompt and says what for', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/retrieve' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('missing-prompt');
  });

  it('marks a fallback answer as one', async () => {
    await post({});
    const body = (await app.inject({ method: 'GET', url: '/api/retrieve?prompt=harpsichord' })).json();
    expect(body.fallback).toBe(true);
    expect(body.note).toContain('grammar examples only');
  });

  /** The phase acceptance criterion, over HTTP and against the seeded bank. */
  it('returns coin first for "coin pickup sound"', async () => {
    await seedBank(bank, { directories: [EXAMPLES_DIR] });
    const body = (await app.inject({ method: 'GET', url: '/api/retrieve?prompt=coin+pickup+sound&k=3' })).json();
    expect(body.fallback).toBe(false);
    expect(body.recipes[0].name).toBe('coin');
  });

  it('finds the looped rotor texture, which only exists because the seeder loads it', async () => {
    await seedBank(bank, { directories: [EXAMPLES_DIR] });
    const body = (await app.inject({ method: 'GET', url: '/api/retrieve?prompt=helicopter+rotor+loop' })).json();
    expect(body.recipes[0].name).toBe('helicopter');
  });
});

describe('GET /api/llms.txt', () => {
  it('serves plain text an agent can read in one request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/llms.txt' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body.length).toBeGreaterThan(2000);
  });

  /* Generated from the signature table, so it cannot describe a primitive that
     does not exist or omit one that does. */
  it('documents every primitive and effect', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/llms.txt' })).body;
    for (const name of ['tone', 'noise', 'chirp', 'pluck', 'modal', 'fm', 'sub', 'click']) {
      expect(body).toContain(`\`${name}.`);
    }
    for (const name of ['lp', 'hp', 'bp', 'dist', 'delay', 'verb']) {
      expect(body).toContain(`\`${name}.`);
    }
  });

  it('documents every category with its limits', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/llms.txt' })).body;
    expect(body).toContain('| `pop` | 8–60 |');
    expect(body).toContain('| `cycle` |');
    expect(body).toContain('required');
  });

  it('includes real recipes once the bank has some', async () => {
    await seedBank(bank, { directories: [EXAMPLES_DIR] });
    const body = (await app.inject({ method: 'GET', url: '/api/llms.txt' })).body;
    expect(body).toContain('sound "');
    expect(body).toMatch(/\*\*[a-z-]+\*\* — asked for as/);
  });

  it('says the bank is empty rather than pretending to have examples', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/llms.txt' })).body;
    expect(body).toContain('The bank is empty');
  });
});

describe('the edges', () => {
  it("answers CORS preflight for a browser or someone else's page", async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/recipes',
      headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' },
    });
    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers['access-control-allow-origin']).toBe('https://example.com');
  });

  it('points a lost caller at the contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().message).toContain('/api/llms.txt');
  });

  /**
   * The whole chain in one test: the endpoint compiled the posted text, rendered it,
   * measured it, and stored the measurement — through JSON and through SQLite, where
   * a profile full of `Infinity` or of arrays would previously have been mangled.
   */
  it('stores the profile it measured itself, end to end', async () => {
    const expected = await measure(parse(VALID));
    const response = await post({});
    expect(response.statusCode).toBe(201);

    const stored = response.json().recipe.profile;
    expect(stored.peakHz).toBeCloseTo(expected.profile.peakHz, 6);
    expect(stored.rmsEnvelope).toEqual(expected.profile.rmsEnvelope);
    expect(stored.loudnessLufsApprox).toBeCloseTo(expected.profile.loudnessLufsApprox, 6);
    expect(bank.get(response.json().recipe.id)?.profile.peakHz).toBeCloseTo(expected.profile.peakHz, 6);
  });
});
