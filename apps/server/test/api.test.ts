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
import type { SoundProfile } from '@txt2sfx/shared';
import { extractProfile } from '@txt2sfx/analyzer';
import { buildApp } from '../src/app.js';
import { openBank, type RecipeBank } from '../src/db.js';
import { seedBank } from '../src/seed.js';

const profile: SoundProfile = {
  durationMs: 42,
  attackMs: 1,
  rmsEnvelope: [1, 0.4],
  centroidHz: [1100],
  flatness: 0.01,
  noiseRatio: 0.02,
  peakHz: 836,
  loudnessLufsApprox: -15,
};

const VALID = 'sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n';

let bank: RecipeBank;
let app: FastifyInstance;

beforeEach(async () => {
  bank = openBank(':memory:');
  app = await buildApp({ bank });
});

afterEach(async () => {
  await app.close();
  bank.close();
});

/** POST a recipe, with sensible defaults for everything not under test. */
const post = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/recipes', payload: { name: 'tick', prompt: 'ui tick', soundline: VALID, profile, tags: ['ui'], ...body } });

describe('GET /api/health', () => {
  it('reports liveness, size and the grammar version', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', recipes: 0, grammar: 'soundline/v0' });
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
    ['missing-profile', { profile: undefined }],
  ])('answers %s with an actionable message', async (error, body) => {
    const response = await post(body);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(error);
    expect(response.json().message.length).toBeGreaterThan(20);
  });

  /**
   * The profile is the one field the server cannot recompute — it has no audio
   * stack — so the least it can do is refuse one of the wrong shape rather than
   * store something that poisons every later comparison.
   */
  it('refuses a profile that is only shaped like one', async () => {
    const response = await post({ profile: { durationMs: 42, attackMs: 1 } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('missing-profile');
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
   * A silent render profiles to the bottom of the loudness scale, and that number
   * has to survive JSON: `-Infinity` becomes `null`, the shape check rejects it, and
   * the caller is told it sent no profile when it sent one.
   */
  it('accepts the profile of a silent sound', async () => {
    const silence = extractProfile({ samples: new Float32Array(4410), sampleRate: 44100 });
    expect(Number.isFinite(silence.loudnessLufsApprox)).toBe(true);
    expect(JSON.parse(JSON.stringify(silence)).loudnessLufsApprox).toBe(silence.loudnessLufsApprox);

    const response = await post({ name: 'quiet', profile: silence });
    expect(response.statusCode).toBe(201);
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

describe('POST /api/recipes/:id/vote', () => {
  it('adds and subtracts a rating', async () => {
    const id = (await post({})).json().recipe.id;
    const url = `/api/recipes/${String(id)}/vote`;
    expect((await app.inject({ method: 'POST', url, payload: { delta: 1 } })).json().rating).toBe(1);
    expect((await app.inject({ method: 'POST', url, payload: { delta: -1 } })).json().rating).toBe(0);
  });

  it('refuses a delta that is not ±1', async () => {
    const id = (await post({})).json().recipe.id;
    const response = await app.inject({
      method: 'POST',
      url: `/api/recipes/${String(id)}/vote`,
      payload: { delta: 50 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('bad-delta');
  });

  it('404s a vote for a recipe that is not there', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/recipes/999/vote', payload: { delta: 1 } });
    expect(response.statusCode).toBe(404);
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
    await seedBank(bank);
    const body = (await app.inject({ method: 'GET', url: '/api/retrieve?prompt=coin+pickup+sound&k=3' })).json();
    expect(body.fallback).toBe(false);
    expect(body.recipes[0].name).toBe('coin');
  });

  it('finds the looped rotor texture, which only exists because the seeder loads it', async () => {
    await seedBank(bank);
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
    await seedBank(bank);
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

  it('stores a profile measured by the analyzer, end to end', async () => {
    /* Not a real render — the point is that a real `SoundProfile` passes the shape
       check and survives the round trip through JSON and SQLite. */
    const measured = extractProfile({
      samples: Float32Array.from({ length: 4410 }, (_, i) => Math.sin((i / 44100) * 2 * Math.PI * 1000) * Math.exp(-i / 2000)),
      sampleRate: 44100,
    });
    const response = await post({ profile: measured });
    expect(response.statusCode).toBe(201);
    expect(response.json().recipe.profile.peakHz).toBeCloseTo(measured.peakHz, 6);
  });
});
