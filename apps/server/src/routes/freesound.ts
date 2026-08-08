/**
 * Connecting a *Freesound* account, with this server holding nothing afterwards.
 *
 * ## The same dance as sign-in, for the opposite reason
 *
 * `routes/auth.ts` runs a redirect dance because a session has to be created here.
 * This one runs the same dance because a token has to be created *elsewhere* and can
 * only be fetched with a secret that lives here. The shapes are deliberately
 * identical — `?return=` allow-listed, a `state` that expires, a one-time code in the
 * fragment traded over `POST` — so that a reader who has understood one has understood
 * both, and so the same class of mistake cannot be made twice in two ways.
 *
 * What is different is what is left over: **nothing**. No row, no session, no account
 * needed. The tokens belong to the person who logged in to Freesound, they are handed
 * to the tab that started the flow, and the only copy this process ever holds sits in
 * a 60-second in-memory hand-off. That is a deliberate answer to "where do we keep the
 * refresh token": in the user's browser, in the same encrypted store their model key
 * goes to, because it is their credential and not ours.
 *
 * ## Why the token is not in the redirect
 *
 * For the reason the session token is not: a callback is a top-level navigation, so
 * anything it carries is in the address bar, the history, the back button and the next
 * screenshot. An access token there would be a live credential in all four. So the
 * callback carries a single-use code good for a minute, and `POST /exchange` trades it.
 *
 * ## Why `/refresh` needs no authentication
 *
 * Because it authenticates itself: the caller must present a refresh token Freesound
 * issued to *them*, and all this route adds is the `client_secret`. Requiring a bank
 * account on top would mean a second sign-in to renew a credential the bank does not
 * hold — and would tie a Freesound connection to an identity system it has nothing to
 * do with. Freesound refuses a bad refresh token; there is nothing here to guess at.
 *
 * @packageDocumentation
 */

import type { FastifyInstance } from 'fastify';
import {
  FreesoundOAuthError,
  authorizeUrl,
  exchangeCode,
  refreshTokens,
  type FreesoundConfig,
  type FreesoundTokens,
} from '../freesound.js';
import { HANDOFF_SECONDS, ephemeral, oneTimeValue, type Ephemeral, type FetchLike } from '../identity.js';
import { allowedReturn } from './auth.js';

/** Options of {@link registerFreesoundRoutes}. Injected so tests never reach the network. */
export interface FreesoundRoutesOptions {
  readonly fetch?: FetchLike;
}

/** How long a started connection may take to come back. Ten minutes, like the code itself. */
const PENDING_SECONDS = 600;

/** Append a fragment parameter to a URL that may already have one. */
function withFragment(target: string, key: string, value: string): string {
  const separator = target.includes('#') ? '&' : '#';
  return `${target}${separator}${key}=${encodeURIComponent(value)}`;
}

export function registerFreesoundRoutes(
  app: FastifyInstance,
  config: FreesoundConfig | undefined,
  options: FreesoundRoutesOptions = {},
): void {
  /* Registered even when unconfigured, and answering `enabled: false`. The panel has
     to be able to tell "this bank cannot connect you" from "this bank is not running",
     and a 404 from a missing route says the second thing about the first. */
  app.get('/api/freesound/config', async () => ({
    enabled: config !== undefined,
    ...(config === undefined
      ? {
          note:
            'No Freesound application is configured on this bank. Set FREESOUND_CLIENT_ID, ' +
            'FREESOUND_CLIENT_SECRET and PUBLIC_URL to offer the connection.',
        }
      : {}),
  }));

  if (config === undefined) return;

  /** `state` → where to send the browser back to. */
  const pending: Ephemeral<string> = ephemeral<string>();
  /** hand-off code → the tokens waiting to be collected. */
  const handoff: Ephemeral<FreesoundTokens> = ephemeral<FreesoundTokens>();

  const fetchImpl = options.fetch;

  app.get('/api/freesound/start', async (request, reply) => {
    const requested = (request.query as Record<string, unknown>)['return'];
    const target = typeof requested === 'string' ? allowedReturn(requested, config.allowedRedirects) : null;
    if (target === null) {
      return reply.status(400).send({
        error: 'bad-return',
        message: `Pass ?return=<url> whose origin is one of: ${config.allowedRedirects.join(', ')}.`,
      });
    }
    const state = oneTimeValue();
    pending.put(state, target, PENDING_SECONDS);
    return reply.redirect(authorizeUrl(config, state), 302);
  });

  app.get('/api/freesound/callback', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    const code = typeof query['code'] === 'string' ? query['code'] : '';
    const target = pending.take(state);

    /* With no known return URL there is nowhere safe to send the browser, so the
       failure is shown here as text rather than redirected anywhere. */
    if (target === undefined) {
      return reply
        .status(400)
        .type('text/plain; charset=utf-8')
        .send('This connection link has expired or was already used. Start again from the playground.');
    }
    if (code === '') return reply.redirect(withFragment(target, 'freesound_error', 'cancelled'), 302);

    try {
      const tokens = await exchangeCode(config, code, fetchImpl);
      const handoffCode = oneTimeValue();
      handoff.put(handoffCode, tokens, HANDOFF_SECONDS);
      return reply.redirect(withFragment(target, 'freesound', handoffCode), 302);
    } catch (error) {
      const failure = error instanceof FreesoundOAuthError ? error.code : 'connect-failed';
      request.log.warn({ err: error }, 'freesound connection failed');
      return reply.redirect(withFragment(target, 'freesound_error', failure), 302);
    }
  });

  app.post('/api/freesound/exchange', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = typeof body['code'] === 'string' ? body['code'] : '';
    const tokens = code === '' ? undefined : handoff.take(code);
    if (tokens === undefined) {
      return reply.status(400).send({
        error: 'bad-code',
        message: `That hand-off code is unknown, already used, or older than ${String(HANDOFF_SECONDS)} seconds.`,
      });
    }
    return tokens;
  });

  app.post('/api/freesound/refresh', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = typeof body['refreshToken'] === 'string' ? body['refreshToken'] : '';
    if (token === '') {
      return reply.status(400).send({
        error: 'bad-refresh',
        message: 'Pass {"refreshToken": "<the token this bank handed you>"}.',
      });
    }
    try {
      return await refreshTokens(config, token, fetchImpl);
    } catch (error) {
      const failure = error instanceof FreesoundOAuthError ? error.code : 'connect-failed';
      /* 400 rather than 401: nothing about *this* server refused the caller, and a 401
         here would send a page looking for its own session. */
      return reply.status(failure === 'upstream' ? 502 : 400).send({
        error: failure,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
