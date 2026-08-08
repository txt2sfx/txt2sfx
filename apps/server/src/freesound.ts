/**
 * The one thing a static page cannot do: trade a Freesound `code` for a token.
 *
 * ## Why this server is involved at all
 *
 * It is involved as little as possible, and the reason it is involved is one string.
 * Freesound's OAuth2 is an authorization **code grant**, and the exchange is signed
 * with a `client_secret` — a secret belonging to the application, not to the user, so
 * it cannot be shipped to a browser where anyone can read it out of the bundle.
 *
 * Everything else stays where it was. The **user's** tokens are the user's: this
 * module hands them straight back to the tab that asked, keeps no copy, writes no row
 * and needs no account. There is no table for them, no migration, and nothing to leak
 * if this database is stolen — see `routes/freesound.ts` for the 60-second hand-off
 * that is the only place a token pauses.
 *
 * That division is not an implementation detail, it is what makes the feature legal.
 * The API terms (§4d) forbid serving "end users that are not logged on to the Platform
 * with valid user credentials and live session" — a shared application key answering
 * for anonymous visitors is exactly that. With this flow every request to Freesound
 * carries the token of a person who logged in to Freesound themselves.
 *
 * Written against the Freesound APIv2 OAuth2 documentation as of 2026-08-08:
 * `GET /apiv2/oauth2/authorize/`, `POST /apiv2/oauth2/access_token/`, an access token
 * good for 86400 s, and a refresh token that renews it. The request shapes are pinned
 * in `test/freesound.test.ts` with an injected `fetch`.
 *
 * @packageDocumentation
 */

import type { FetchLike } from './identity.js';

/** What this server needs to be able to exchange a code. */
export interface FreesoundConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Origins a completed connection may hand tokens back to.
   *
   * The same allow-list question as sign-in, and for a sharper reason: what travels
   * here is a credential for somebody's Freesound account. An open redirect would
   * deliver it to whoever asked.
   */
  readonly allowedRedirects: readonly string[];
}

/** A user's tokens, exactly as the tab will hold them. */
export interface FreesoundTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Seconds the access token is good for. 86400 at the time of writing. */
  readonly expiresIn: number;
}

/** Why an exchange failed, in a form a route can turn into a status. */
export class FreesoundOAuthError extends Error {
  readonly code: 'bad-code' | 'bad-refresh' | 'upstream';

  constructor(code: 'bad-code' | 'bad-refresh' | 'upstream', message: string) {
    super(message);
    this.name = 'FreesoundOAuthError';
    this.code = code;
  }
}

const AUTHORIZE = 'https://freesound.org/apiv2/oauth2/authorize/';
const TOKEN = 'https://freesound.org/apiv2/oauth2/access_token/';

/**
 * Where to send the browser to ask the user for permission.
 *
 * No `redirect_uri` parameter: Freesound redirects to the URI registered with the
 * application, and passing a second copy of a value that must match the registration
 * exactly is one more thing that can disagree with it.
 */
export function authorizeUrl(config: FreesoundConfig, state: string): string {
  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    state,
  });
  return `${AUTHORIZE}?${query.toString()}`;
}

/** Trade the callback's `code` for a token pair. */
export async function exchangeCode(
  config: FreesoundConfig,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<FreesoundTokens> {
  return post(config, { grant_type: 'authorization_code', code }, 'bad-code', fetchImpl);
}

/** Renew an expired access token. The refresh token comes from the tab, not from here. */
export async function refreshTokens(
  config: FreesoundConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<FreesoundTokens> {
  return post(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, 'bad-refresh', fetchImpl);
}

/** The one POST both grants make, and the one place their answers are read. */
async function post(
  config: FreesoundConfig,
  grant: Record<string, string>,
  failure: 'bad-code' | 'bad-refresh',
  fetchImpl: FetchLike,
): Promise<FreesoundTokens> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...grant,
  });

  let response: Response;
  try {
    response = await fetchImpl(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
  } catch (error) {
    throw new FreesoundOAuthError('upstream', `freesound.org is unreachable: ${String(error)}`);
  }

  const text = await response.text();
  if (!response.ok) {
    /* Freesound answers a spent code and a wrong secret with the same 400, so the
       body is carried through rather than summarized: it is the only thing that
       distinguishes "press connect again" from "your configuration is wrong". */
    throw new FreesoundOAuthError(failure, `freesound answered ${String(response.status)}: ${text.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FreesoundOAuthError('upstream', 'freesound answered something that is not JSON');
  }

  const row = parsed as Record<string, unknown>;
  const accessToken = typeof row['access_token'] === 'string' ? row['access_token'] : '';
  const refresh = typeof row['refresh_token'] === 'string' ? row['refresh_token'] : '';
  const expiresIn = typeof row['expires_in'] === 'number' ? row['expires_in'] : 0;
  if (accessToken === '' || refresh === '') {
    throw new FreesoundOAuthError('upstream', 'freesound answered without a token pair');
  }
  /* A missing `expires_in` is not worth failing over — the tab refreshes on a 401
     anyway, and treating "unknown" as "already expired" would make it refresh once
     more than necessary rather than once too few. */
  return { accessToken, refreshToken: refresh, expiresIn: expiresIn > 0 ? expiresIn : 0 };
}
