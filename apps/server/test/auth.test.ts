/**
 * Sign-in, end to end, with an injected `fetch`.
 *
 * No network, and that is the point twice over: these tests run in CI with no GitHub
 * app, and the stub is what pins the *request shape* this code was written against.
 * When GitHub changes its API, this file fails — rather than the sign-in button, in
 * production, on a weekend.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { type AuthContext, assertSafeBinding, bearerOf } from '../src/auth.js';
import {
  MIN_ACCOUNT_AGE_DAYS,
  type GitHubConfig,
  authorizeUrl,
  ephemeral,
  passesAgeGate,
} from '../src/identity.js';
import { allowedReturn } from '../src/routes/auth.js';
import { openDatabase } from '../src/schema.js';
import { type Store, storeOver } from '../src/store.js';

const PLAYGROUND = 'https://txt2sfx.github.io/';

const GITHUB: GitHubConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  callbackUrl: 'https://bank.example/api/auth/github/callback',
  allowedRedirects: ['https://txt2sfx.github.io', 'http://localhost:5173'],
};

const CONTEXT: AuthContext = { mode: 'github', github: GITHUB, adminToken: '' };

const VALID = 'sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n';

/** An account old enough to write here. */
const OLD_ACCOUNT = { id: 4242, login: 'sound-person', avatar_url: 'https://avatars/1', created_at: '2019-04-01T00:00:00Z' };

/** Every request the stub saw, so the shape can be asserted rather than assumed. */
interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

let calls: Call[];
let store: Store;
let app: FastifyInstance;

/** A `fetch` that answers GitHub's two endpoints and records how it was called. */
function stubFetch(user: Record<string, unknown> = OLD_ACCOUNT, token: string | null = 'gho_token') {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
      ),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify(token === null ? { error_description: 'bad code' } : { access_token: token }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://api.github.com/user') {
      return new Response(JSON.stringify(user), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch of ${url}`);
  };
}

async function build(fetchImpl: ReturnType<typeof stubFetch>, context: AuthContext = CONTEXT): Promise<void> {
  app = await buildApp({ store, auth: context, fetch: fetchImpl });
}

/** Walk the whole redirect dance and come back with a bearer token. */
async function signIn(): Promise<string> {
  const started = await app.inject({ method: 'GET', url: `/api/auth/github/start?return=${encodeURIComponent(PLAYGROUND)}` });
  const state = new URL(started.headers['location'] as string).searchParams.get('state') ?? '';

  const back = await app.inject({ method: 'GET', url: `/api/auth/github/callback?code=the-code&state=${state}` });
  const handoff = new URL(back.headers['location'] as string).hash.replace('#signin=', '');

  const exchanged = await app.inject({ method: 'POST', url: '/api/auth/exchange', payload: { code: decodeURIComponent(handoff) } });
  return exchanged.json().token as string;
}

beforeEach(() => {
  calls = [];
  store = storeOver(openDatabase(':memory:'));
});

afterEach(async () => {
  await app.close();
  store.close();
});

describe('the sign-in dance', () => {
  it('sends the browser to GitHub with a one-time state', async () => {
    await build(stubFetch());
    const response = await app.inject({ method: 'GET', url: `/api/auth/github/start?return=${encodeURIComponent(PLAYGROUND)}` });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers['location'] as string);
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('client-id');
    expect(location.searchParams.get('redirect_uri')).toBe(GITHUB.callbackUrl);
    expect(location.searchParams.get('state')).toBeTruthy();
    /* No scope at all: the token that comes back may read public profile data and
       nothing else, which is all this needs. */
    expect(location.searchParams.get('scope')).toBeNull();
  });

  it('hands back a session through a single-use code, never in the redirect', async () => {
    await build(stubFetch());
    const started = await app.inject({ method: 'GET', url: `/api/auth/github/start?return=${encodeURIComponent(PLAYGROUND)}` });
    const state = new URL(started.headers['location'] as string).searchParams.get('state') ?? '';

    const back = await app.inject({ method: 'GET', url: `/api/auth/github/callback?code=the-code&state=${state}` });
    expect(back.statusCode).toBe(302);
    const target = new URL(back.headers['location'] as string);
    expect(target.origin).toBe('https://txt2sfx.github.io');
    expect(target.hash).toMatch(/^#signin=/);

    const code = decodeURIComponent(target.hash.replace('#signin=', ''));
    const exchanged = await app.inject({ method: 'POST', url: '/api/auth/exchange', payload: { code } });
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json().actor.login).toBe('sound-person');
    expect(typeof exchanged.json().token).toBe('string');

    /* One use. A code that still worked would be a bearer token with a shorter name. */
    const again = await app.inject({ method: 'POST', url: '/api/auth/exchange', payload: { code } });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('bad-code');
  });

  it('cannot replay a state', async () => {
    await build(stubFetch());
    const started = await app.inject({ method: 'GET', url: `/api/auth/github/start?return=${encodeURIComponent(PLAYGROUND)}` });
    const state = new URL(started.headers['location'] as string).searchParams.get('state') ?? '';

    await app.inject({ method: 'GET', url: `/api/auth/github/callback?code=a&state=${state}` });
    const replay = await app.inject({ method: 'GET', url: `/api/auth/github/callback?code=b&state=${state}` });
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toContain('expired or was already used');
  });

  /** An open redirect on a sign-in endpoint delivers sessions to whoever asks. */
  it('refuses to return a session to an origin that is not on the list', async () => {
    await build(stubFetch());
    const response = await app.inject({
      method: 'GET',
      url: `/api/auth/github/start?return=${encodeURIComponent('https://evil.example/steal')}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('bad-return');
    expect(response.json().message).toContain('txt2sfx.github.io');
  });

  it('pins the request shape it was written against', async () => {
    await build(stubFetch());
    await signIn();

    const exchange = calls[0];
    expect(exchange?.url).toBe('https://github.com/login/oauth/access_token');
    expect(exchange?.method).toBe('POST');
    expect(exchange?.headers['accept']).toBe('application/json');
    expect(JSON.parse(exchange?.body ?? '{}')).toMatchObject({
      client_id: 'client-id',
      client_secret: 'client-secret',
      code: 'the-code',
    });

    const profile = calls[1];
    expect(profile?.url).toBe('https://api.github.com/user');
    expect(profile?.headers['authorization']).toBe('Bearer gho_token');
    expect(profile?.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('reports a refused code exchange as a sign-in error, not as a crash', async () => {
    await build(stubFetch(OLD_ACCOUNT, null));
    const started = await app.inject({ method: 'GET', url: `/api/auth/github/start?return=${encodeURIComponent(PLAYGROUND)}` });
    const state = new URL(started.headers['location'] as string).searchParams.get('state') ?? '';
    const back = await app.inject({ method: 'GET', url: `/api/auth/github/callback?code=x&state=${state}` });
    expect(back.statusCode).toBe(302);
    expect(back.headers['location']).toContain('#signin_error=github-token');
  });
});

describe('the age gate', () => {
  /**
   * The one line that handles industrial spam rather than the dedicated nuisance:
   * bulk accounts are new accounts, and no supplier can conjure a month of history.
   */
  it('turns away an account created yesterday', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    await build(stubFetch({ ...OLD_ACCOUNT, created_at: yesterday }));

    const started = await app.inject({ method: 'GET', url: `/api/auth/github/start?return=${encodeURIComponent(PLAYGROUND)}` });
    const state = new URL(started.headers['location'] as string).searchParams.get('state') ?? '';
    const back = await app.inject({ method: 'GET', url: `/api/auth/github/callback?code=x&state=${state}` });

    expect(back.headers['location']).toContain('#signin_error=account-too-new');
    expect(store.identity.count()).toBe(0);
  });

  it('fails closed when the provider will not say how old the account is', () => {
    const base = { provider: 'github', externalId: '1', login: 'x', avatarUrl: '' };
    expect(passesAgeGate({ ...base, originAt: '' })).toBe(false);
    expect(passesAgeGate({ ...base, originAt: 'not a date' })).toBe(false);
    expect(passesAgeGate({ ...base, originAt: new Date(Date.now() - (MIN_ACCOUNT_AGE_DAYS + 1) * 86_400_000).toISOString() })).toBe(true);
  });
});

describe('what a session is worth', () => {
  it('refuses every write without one, and allows them with one', async () => {
    await build(stubFetch());
    const payload = { name: 'tick', prompt: 'ui tick', soundline: VALID };

    const anonymous = await app.inject({ method: 'POST', url: '/api/recipes', payload });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error).toBe('sign-in-required');
    /* Reading is never gated. */
    expect((await app.inject({ method: 'GET', url: '/api/recipes' })).statusCode).toBe(200);

    const token = await signIn();
    const signed = await app.inject({
      method: 'POST',
      url: '/api/recipes',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(signed.statusCode).toBe(201);
    expect(signed.json().recipe.author.login).toBe('sound-person');
  });

  it('rejects a token that was never issued', async () => {
    await build(stubFetch());
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('bad-session');
  });

  it('signs out by forgetting the session', async () => {
    await build(stubFetch());
    const token = await signIn();
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/signout', headers })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers })).statusCode).toBe(401);
  });

  /** A ban that leaves live sessions alone takes effect the next time they sign in — which is never. */
  it('drops every session of a banned account, and refuses its writes', async () => {
    await build(stubFetch());
    const token = await signIn();
    const actor = store.identity.resolve(token);
    store.identity.setBanned(actor?.id ?? 0, true);

    const response = await app.inject({
      method: 'POST',
      url: '/api/recipes',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'tick', prompt: 'ui tick', soundline: VALID },
    });
    expect(response.statusCode).toBe(401);
  });

  it('tells the page what it may do and how much of it is left', async () => {
    await build(stubFetch());
    const token = await signIn();
    const body = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })).json();
    expect(body.actor.login).toBe('sound-person');
    expect(body.standing).toBe(0);
    expect(body.allowances.recipe.remaining).toBeGreaterThan(0);
    expect(body.allowances.comment.burst).toBeGreaterThan(0);
  });
});

describe('solo mode', () => {
  it('needs no sign-in and says so', async () => {
    await build(stubFetch(), { mode: 'solo', adminToken: '' });
    const config = (await app.inject({ method: 'GET', url: '/api/auth/config' })).json();
    expect(config.mode).toBe('solo');
    expect(config.note).toContain('solo');
    expect((await app.inject({ method: 'GET', url: '/api/auth/github/start?return=x' })).statusCode).toBe(404);
  });

  /**
   * An anonymous writable bank on a public interface is not a configuration anyone
   * chose deliberately, so it has to be said out loud.
   */
  it('refuses to bind anything but loopback', () => {
    expect(() => assertSafeBinding('solo', '127.0.0.1', false)).not.toThrow();
    expect(() => assertSafeBinding('github', '0.0.0.0', false)).not.toThrow();
    expect(() => assertSafeBinding('solo', '0.0.0.0', true)).not.toThrow();
    expect(() => assertSafeBinding('solo', '0.0.0.0', false)).toThrow(/TXT2SFX_ALLOW_OPEN/);
  });
});

describe('the small pieces', () => {
  it('reads a bearer header in any case, and nothing else', () => {
    const of = (authorization?: string) => bearerOf({ headers: authorization === undefined ? {} : { authorization } } as never);
    expect(of('Bearer abc')).toBe('abc');
    expect(of('bearer  abc  ')).toBe('abc');
    expect(of('Basic abc')).toBe('');
    expect(of()).toBe('');
  });

  it('compares return URLs by origin, not by string', () => {
    expect(allowedReturn('https://txt2sfx.github.io/#play=x', ['https://txt2sfx.github.io'])).toContain('txt2sfx.github.io');
    expect(allowedReturn('https://txt2sfx.github.io.evil.example/', ['https://txt2sfx.github.io'])).toBeNull();
    expect(allowedReturn('not a url', ['https://txt2sfx.github.io'])).toBeNull();
    expect(allowedReturn('https://a.example/', ['nonsense', 'https://a.example'])).toBe('https://a.example/');
  });

  it('builds an authorize URL with no scope', () => {
    expect(authorizeUrl(GITHUB, 'the-state')).toContain('state=the-state');
    expect(authorizeUrl(GITHUB, 'the-state')).not.toContain('scope=');
  });

  it('forgets an ephemeral value once it is taken or once it expires', () => {
    const store_ = ephemeral<string>();
    store_.put('k', 'v', 60, 1000);
    expect(store_.take('k', 1000)).toBe('v');
    expect(store_.take('k', 1000)).toBeUndefined();

    store_.put('j', 'v', 60, 1000);
    expect(store_.take('j', 1000 + 61_000)).toBeUndefined();
    expect(store_.size).toBe(0);
  });
});
