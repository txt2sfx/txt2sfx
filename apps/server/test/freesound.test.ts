/**
 * Connecting a Freesound account, end to end, with an injected `fetch`.
 *
 * Two things are being pinned. The **request shape** — the grant, the parameter names,
 * the form encoding — because it is a contract with a service nobody here controls, and
 * the failure mode without a test is a connect button that stops working in production
 * rather than in CI. And the **redirect discipline**: an allow-listed return, a state
 * that is spent once, and no token anywhere in a URL. What travels here is a credential
 * for somebody's Freesound account, so an open redirect would not be a bug, it would be
 * a give-away.
 *
 * The third assertion is an absence: after a completed connection this server holds
 * nothing. No row, no session, no account.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { AuthContext } from '../src/auth.js';
import { authorizeUrl, type FreesoundConfig } from '../src/freesound.js';
import { configFromEnv } from '../src/index.js';
import { openDatabase } from '../src/schema.js';
import { type Store, storeOver } from '../src/store.js';

const PLAYGROUND = 'https://txt2sfx.github.io/';

const CONFIG: FreesoundConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  allowedRedirects: ['https://txt2sfx.github.io', 'http://localhost:5173'],
};

const CONTEXT: AuthContext = { mode: 'solo', adminToken: '' };

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

let calls: Call[];
/* Undefined between tests that never build an app — the teardown must not close a
   store the previous test already closed. */
let store: Store | undefined;
let app: FastifyInstance | undefined;

/** A `fetch` that answers the token endpoint and records how it was called. */
function stubFetch(answer: () => Response) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return answer();
  };
}

const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 86400,
  scope: 'read write',
  token_type: 'Bearer',
};

const ok = (): Response =>
  new Response(JSON.stringify(TOKENS), { status: 200, headers: { 'content-type': 'application/json' } });

async function build(fetchImpl: typeof globalThis.fetch | ReturnType<typeof stubFetch>): Promise<void> {
  store = storeOver(openDatabase(':memory:'));
  app = await buildApp({
    store,
    auth: CONTEXT,
    freesound: CONFIG,
    fetch: fetchImpl as (url: string, init?: RequestInit) => Promise<Response>,
  });
}

/** Walk the start → callback pair and return the fragment the browser is sent back with. */
async function connect(): Promise<string> {
  const start = await app!.inject({ method: 'GET', url: `/api/freesound/start?return=${encodeURIComponent(PLAYGROUND)}` });
  const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
  const back = await app!.inject({ method: 'GET', url: `/api/freesound/callback?code=the-code&state=${state}` });
  return (back.headers.location as string) ?? '';
}

beforeEach(() => {
  calls = [];
});

afterEach(async () => {
  await app?.close();
  store?.close();
  app = undefined;
  store = undefined;
});

describe('the connect flow', () => {
  it('sends the browser to freesound with a state, and only to an allow-listed return', async () => {
    await build(stubFetch(ok));

    const good = await app!.inject({
      method: 'GET',
      url: `/api/freesound/start?return=${encodeURIComponent(PLAYGROUND)}`,
    });
    expect(good.statusCode).toBe(302);
    const sent = new URL(good.headers.location as string);
    expect(`${sent.origin}${sent.pathname}`).toBe('https://freesound.org/apiv2/oauth2/authorize/');
    expect(sent.searchParams.get('client_id')).toBe('client-id');
    expect(sent.searchParams.get('response_type')).toBe('code');
    expect(sent.searchParams.get('state')).not.toBe('');

    /* An open redirect on this route hands somebody's Freesound credential to
       whoever asked for it. */
    const bad = await app!.inject({
      method: 'GET',
      url: `/api/freesound/start?return=${encodeURIComponent('https://evil.example/')}`,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'bad-return' });
  });

  it('exchanges the code with the secret, form-encoded, and hands back a one-time code only', async () => {
    await build(stubFetch(ok));
    const location = await connect();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://freesound.org/apiv2/oauth2/access_token/');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const sent = new URLSearchParams(calls[0]?.body ?? '');
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('the-code');
    expect(sent.get('client_id')).toBe('client-id');
    expect(sent.get('client_secret')).toBe('client-secret');

    /* The credential must not be in the URL the browser is navigated to. */
    expect(location.startsWith(`${PLAYGROUND}#freesound=`)).toBe(true);
    expect(location).not.toContain('access-1');
    expect(location).not.toContain('refresh-1');
  });

  it('trades the hand-off code for the tokens, exactly once', async () => {
    await build(stubFetch(ok));
    const code = decodeURIComponent((await connect()).split('#freesound=')[1] ?? '');

    const first = await app!.inject({ method: 'POST', url: '/api/freesound/exchange', payload: { code } });
    expect(first.json()).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 86400 });

    const second = await app!.inject({ method: 'POST', url: '/api/freesound/exchange', payload: { code } });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ error: 'bad-code' });
  });

  /* The whole design in one assertion: this bank is a notary, not a keyring. */
  it('keeps nothing afterwards — no account, no session, no row', async () => {
    await build(stubFetch(ok));
    const code = decodeURIComponent((await connect()).split('#freesound=')[1] ?? '');
    await app!.inject({ method: 'POST', url: '/api/freesound/exchange', payload: { code } });

    const tables = store!.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((row) => row.name).join(' ')).not.toContain('freesound');
    expect(store!.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(store!.db.prepare('SELECT COUNT(*) AS n FROM actors').get()).toEqual({ n: 0 });
  });

  it('spends the state, so a replayed callback cannot mint a second connection', async () => {
    await build(stubFetch(ok));
    const start = await app!.inject({
      method: 'GET',
      url: `/api/freesound/start?return=${encodeURIComponent(PLAYGROUND)}`,
    });
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';

    const first = await app!.inject({ method: 'GET', url: `/api/freesound/callback?code=a&state=${state}` });
    expect(first.statusCode).toBe(302);
    const replay = await app!.inject({ method: 'GET', url: `/api/freesound/callback?code=a&state=${state}` });
    expect(replay.statusCode).toBe(400);
    /* Shown as text, not redirected: without a known return there is nowhere safe
       to send the browser. */
    expect(replay.body).toContain('expired');
  });

  it('sends a refused exchange back as an error in the fragment, not as a broken page', async () => {
    await build(stubFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 })));
    expect(await connect()).toBe(`${PLAYGROUND}#freesound_error=bad-code`);
  });

  it('reports a cancelled authorization as such', async () => {
    await build(stubFetch(ok));
    const start = await app!.inject({
      method: 'GET',
      url: `/api/freesound/start?return=${encodeURIComponent(PLAYGROUND)}`,
    });
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
    const back = await app!.inject({ method: 'GET', url: `/api/freesound/callback?state=${state}` });
    expect(back.headers.location).toBe(`${PLAYGROUND}#freesound_error=cancelled`);
  });
});

describe('refreshing', () => {
  it('sends the refresh grant and returns the new pair', async () => {
    await build(stubFetch(ok));
    const response = await app!.inject({
      method: 'POST',
      url: '/api/freesound/refresh',
      payload: { refreshToken: 'refresh-0' },
    });

    expect(response.json()).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 86400 });
    const sent = new URLSearchParams(calls[0]?.body ?? '');
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('refresh-0');
    expect(sent.get('client_secret')).toBe('client-secret');
  });

  /* 400, not 401: nothing about *this* server refused the caller, and a 401 would
     send the page looking for a bank session it does not need. */
  it('refuses a spent refresh token with 400 and the reason', async () => {
    await build(stubFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 })));
    const response = await app!.inject({
      method: 'POST',
      url: '/api/freesound/refresh',
      payload: { refreshToken: 'gone' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'bad-refresh' });
  });

  it('calls an unreachable freesound a bad gateway rather than a bad token', async () => {
    await build(
      stubFetch(() => {
        throw new TypeError('fetch failed');
      }),
    );
    const response = await app!.inject({
      method: 'POST',
      url: '/api/freesound/refresh',
      payload: { refreshToken: 'fine' },
    });
    expect(response.statusCode).toBe(502);
  });

  it('asks for the field by name when it is missing', async () => {
    await build(stubFetch(ok));
    const response = await app!.inject({ method: 'POST', url: '/api/freesound/refresh', payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('refreshToken');
  });
});

describe('an unconfigured bank', () => {
  it('says so instead of 404-ing, so the tab can tell it apart from no bank at all', async () => {
    store = storeOver(openDatabase(':memory:'));
    app = await buildApp({ store, auth: CONTEXT });

    const config = await app!.inject({ method: 'GET', url: '/api/freesound/config' });
    expect(config.json()).toMatchObject({ enabled: false });
    expect(config.json().note).toContain('FREESOUND_CLIENT_ID');

    /* And the doors themselves are not there at all — a start route that redirects
       to an application that does not exist is worse than a missing one. */
    expect((await app!.inject({ method: 'GET', url: '/api/freesound/start?return=x' })).statusCode).toBe(404);
  });

  it('reports enabled when it is', async () => {
    await build(stubFetch(ok));
    expect((await app!.inject({ method: 'GET', url: '/api/freesound/config' })).json()).toEqual({ enabled: true });
  });
});

describe('configFromEnv', () => {
  it('needs all three settings before it offers the connection', async () => {
    const base = { PUBLIC_URL: 'https://bank.example', ALLOWED_ORIGINS: PLAYGROUND };
    expect(configFromEnv({ ...base, FREESOUND_CLIENT_ID: 'id' } as NodeJS.ProcessEnv).freesound).toBeUndefined();
    expect(configFromEnv({ ...base, FREESOUND_CLIENT_SECRET: 's' } as NodeJS.ProcessEnv).freesound).toBeUndefined();
    expect(
      configFromEnv({ FREESOUND_CLIENT_ID: 'id', FREESOUND_CLIENT_SECRET: 's' } as NodeJS.ProcessEnv).freesound,
    ).toBeUndefined();

    const full = configFromEnv({
      ...base,
      FREESOUND_CLIENT_ID: 'id',
      FREESOUND_CLIENT_SECRET: 's',
    } as NodeJS.ProcessEnv).freesound;
    expect(full?.clientId).toBe('id');
    /* The bank's own origin is always allowed, so a bank serving its own page needs
       no extra setting. */
    expect(full?.allowedRedirects).toEqual([PLAYGROUND, 'https://bank.example']);
  });
});

describe('authorizeUrl', () => {
  /* No `redirect_uri`: freesound redirects to the URI registered with the application,
     and a second copy of a value that must match the registration exactly is one more
     thing that can disagree with it. */
  it('carries the three parameters the flow documents and no fourth', () => {
    const url = new URL(authorizeUrl(CONFIG, 'st'));
    expect([...url.searchParams.keys()].sort()).toEqual(['client_id', 'response_type', 'state']);
  });
});
