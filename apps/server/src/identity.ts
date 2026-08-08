/**
 * Who is writing: accounts, sessions, and the GitHub sign-in behind them.
 *
 * ## Why there is an account at all
 *
 * The bank was anonymous and read-mostly, and that was right while a write was a
 * recipe that had to compile. It stops being right the moment a like is a number
 * someone can move and a comment is prose someone can read. An anonymous like is a
 * counter with no meaning — it can be pressed a million times from a script, and no
 * amount of IP arithmetic changes that, only makes it unfair to whoever shares an
 * exit node. An anonymous comment cannot be moderated: there is nothing to ban.
 *
 * So identity is the price of writing, and GitHub is the provider because the people
 * this is for already have an account there, because it costs us no password
 * storage, no email, no reset flow and no PII beyond a handle, and because an
 * account that already exists has a history a fresh throwaway does not.
 *
 * **Reading stays anonymous, always.** No sign-in wall in front of a sound.
 *
 * ## The age gate is the whole spam defence, and it is one line
 *
 * {@link MIN_ACCOUNT_AGE_DAYS} is checked once, at first sign-in. Spam is a business
 * with a cost model: it needs accounts in bulk, now, and an account that has to have
 * existed for a month before it is worth anything is not something a bulk supplier
 * can conjure. Everything else here — the rate limits, the link ban — handles the
 * dedicated nuisance. This handles the industry.
 *
 * ## What is stored, and what is not
 *
 * Stored: provider, provider id, login, avatar URL, the upstream account's creation
 * date. Not stored: the access token. It is used once, to read the profile, and
 * dropped — the app asks for no scopes, so it could not do anything else with it,
 * and a database that holds other people's GitHub tokens is a liability with no
 * corresponding feature.
 *
 * Sessions store a **hash** of the bearer token, never the token. A stolen database
 * must not be a stack of working credentials, and nothing here ever needs to read
 * one back.
 *
 * ## Solo mode
 *
 * With no OAuth app configured — a laptop, a test, CI — the server runs solo: one
 * built-in actor called `local`, every write attributed to it, no sign-in. That is
 * how the playground stays usable offline, which is the project's whole posture.
 * `app.ts` refuses to bind a non-loopback address in that mode, because a writable
 * bank with no identity on a public interface is not a mode anyone chose on purpose.
 *
 * @packageDocumentation
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Author } from '@txt2sfx/shared';
import type { Database } from './schema.js';

/* ------------------------------------------------------------------------- *
 * Policy
 * ------------------------------------------------------------------------- */

/**
 * How old an upstream account must be before it may write here.
 *
 * Thirty days. Long enough that accounts cannot be bought and used the same week,
 * short enough that a real newcomer waits once and never notices again. The number
 * is a policy, not a measurement, and it is here rather than in the environment so
 * that changing it is a commit someone can read.
 */
export const MIN_ACCOUNT_AGE_DAYS = 30;

/** How long a session lasts. Long enough not to nag; short enough to expire. */
export const SESSION_DAYS = 30;

/**
 * How long a hand-off code is good for.
 *
 * The callback cannot hand the bearer token straight to the page — it arrives as a
 * top-level redirect, so the token would sit in a URL, in history, and in whatever
 * the referrer policy leaks. Instead the callback redirects with a single-use code
 * and the page exchanges it for the token over POST. Sixty seconds is the width of a
 * redirect, and a code that outlives its redirect is a token with a longer name.
 */
export const HANDOFF_SECONDS = 60;

/* ------------------------------------------------------------------------- *
 * Rows and types
 * ------------------------------------------------------------------------- */

/** An account, as this server knows it. */
export interface Actor extends Author {
  readonly provider: string;
  readonly externalId: string;
  /** When the *upstream* account was created, ISO-8601, or `''` if unknown. */
  readonly originAt: string;
  readonly createdAt: string;
  /** Set when the account was banned; a banned actor may read and nothing else. */
  readonly bannedAt?: string;
}

interface ActorRow {
  readonly id: number;
  readonly provider: string;
  readonly external_id: string;
  readonly login: string;
  readonly avatar_url: string;
  readonly origin_at: string;
  readonly created_at: string;
  readonly banned_at: string | null;
}

function toActor(row: ActorRow): Actor {
  return {
    id: row.id,
    login: row.login,
    avatarUrl: row.avatar_url,
    provider: row.provider,
    externalId: row.external_id,
    originAt: row.origin_at,
    createdAt: row.created_at,
    ...(row.banned_at === null ? {} : { bannedAt: row.banned_at }),
  };
}

/** What a provider tells us about a person. Deliberately small. */
export interface ProviderProfile {
  readonly provider: string;
  readonly externalId: string;
  readonly login: string;
  readonly avatarUrl: string;
  /** When the account was created upstream, ISO-8601. */
  readonly originAt: string;
}

/** A minted session. The token is returned once and never stored in the clear. */
export interface Session {
  readonly token: string;
  readonly actor: Actor;
  readonly expiresAt: string;
}

/* ------------------------------------------------------------------------- *
 * Store
 * ------------------------------------------------------------------------- */

/** Token to the value stored in `sessions.token_hash`. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 32 bytes of randomness, base64url. Long enough that guessing is not a strategy. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

function daysFrom(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/** Accounts and their sessions. */
export interface IdentityStore {
  /** Find or create the account behind a provider profile, refreshing the handle. */
  upsert(profile: ProviderProfile): Actor;
  get(id: number): Actor | undefined;
  byLogin(provider: string, login: string): Actor | undefined;
  /** Mint a session. Returns the token exactly once. */
  startSession(actorId: number, now?: Date): Session;
  /** The actor behind a bearer token, or undefined when it is unknown or expired. */
  resolve(token: string, now?: Date): Actor | undefined;
  endSession(token: string): void;
  /** Ban or unban. Every session of a banned actor is dropped. */
  setBanned(actorId: number, banned: boolean): Actor | undefined;
  /** Deletes expired sessions. Returns how many. */
  sweep(now?: Date): number;
  count(): number;
}

export function identityStore(db: Database): IdentityStore {
  const selectActor = db.prepare('SELECT * FROM actors WHERE id = ?');

  const store: IdentityStore = {
    upsert(profile: ProviderProfile): Actor {
      const existing = db
        .prepare('SELECT * FROM actors WHERE provider = ? AND external_id = ?')
        .get(profile.provider, profile.externalId) as unknown as ActorRow | undefined;

      if (existing !== undefined) {
        /* The handle and the avatar are the provider's to change, and a gallery
           showing someone's old username is a small wrong that never fixes itself.
           The provider id is what identity actually hangs on. */
        db.prepare('UPDATE actors SET login = ?, avatar_url = ? WHERE id = ?').run(
          profile.login,
          profile.avatarUrl,
          existing.id,
        );
        const refreshed = selectActor.get(existing.id) as unknown as ActorRow;
        return toActor(refreshed);
      }

      const result = db
        .prepare(
          `INSERT INTO actors (provider, external_id, login, avatar_url, origin_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          profile.provider,
          profile.externalId,
          profile.login,
          profile.avatarUrl,
          profile.originAt,
          new Date().toISOString(),
        );
      return toActor(selectActor.get(Number(result.lastInsertRowid)) as unknown as ActorRow);
    },

    get(id: number): Actor | undefined {
      const row = selectActor.get(id) as unknown as ActorRow | undefined;
      return row === undefined ? undefined : toActor(row);
    },

    byLogin(provider: string, login: string): Actor | undefined {
      const row = db
        .prepare('SELECT * FROM actors WHERE provider = ? AND login = ? COLLATE NOCASE')
        .get(provider, login) as unknown as ActorRow | undefined;
      return row === undefined ? undefined : toActor(row);
    },

    startSession(actorId: number, now = new Date()): Session {
      const actor = store.get(actorId);
      if (actor === undefined) throw new Error(`no actor ${String(actorId)}`);
      const token = mintToken();
      const expiresAt = daysFrom(now.toISOString(), SESSION_DAYS);
      db.prepare('INSERT INTO sessions (token_hash, actor_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
        hashToken(token),
        actorId,
        now.toISOString(),
        expiresAt,
      );
      return { token, actor, expiresAt };
    },

    resolve(token: string, now = new Date()): Actor | undefined {
      if (token === '') return undefined;
      const row = db
        .prepare(
          `SELECT actors.*, sessions.expires_at AS expires_at
           FROM sessions JOIN actors ON actors.id = sessions.actor_id
           WHERE sessions.token_hash = ?`,
        )
        .get(hashToken(token)) as unknown as (ActorRow & { expires_at: string }) | undefined;
      if (row === undefined) return undefined;
      if (Date.parse(row.expires_at) <= now.getTime()) return undefined;
      return toActor(row);
    },

    endSession(token: string): void {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    },

    setBanned(actorId: number, banned: boolean): Actor | undefined {
      const actor = store.get(actorId);
      if (actor === undefined) return undefined;
      db.prepare('UPDATE actors SET banned_at = ? WHERE id = ?').run(banned ? new Date().toISOString() : null, actorId);
      /* A ban that leaves the sessions alive is a ban that takes effect whenever the
         person next signs in — which is never, because they are already signed in. */
      if (banned) db.prepare('DELETE FROM sessions WHERE actor_id = ?').run(actorId);
      return store.get(actorId);
    },

    sweep(now = new Date()): number {
      const result = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
      return Number(result.changes);
    },

    count(): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM actors').get() as unknown as { n: number };
      return Number(row.n);
    },
  };

  return store;
}

/* ------------------------------------------------------------------------- *
 * Solo mode
 * ------------------------------------------------------------------------- */

/** The provider name of the built-in local account. */
export const SOLO_PROVIDER = 'local';

/**
 * The account every write is attributed to when no OAuth app is configured.
 *
 * Created on demand rather than seeded, so a bank that is only ever read never grows
 * a fictional user.
 */
export function soloActor(identity: IdentityStore): Actor {
  return identity.upsert({
    provider: SOLO_PROVIDER,
    externalId: 'solo',
    login: 'local',
    avatarUrl: '',
    originAt: new Date(0).toISOString(),
  });
}

/* ------------------------------------------------------------------------- *
 * GitHub
 * ------------------------------------------------------------------------- */

/** `fetch`, injectable so tests never touch the network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Configuration of the GitHub OAuth app. */
export interface GitHubConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Where GitHub sends the browser back, e.g. `https://host/api/auth/github/callback`. */
  readonly callbackUrl: string;
  /** Origins the sign-in may hand a session back to. Exact matches only. */
  readonly allowedRedirects: readonly string[];
}

/** Why a sign-in was refused, in a form the page can show verbatim. */
export class SignInError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SignInError';
    this.code = code;
  }
}

/**
 * The authorize URL to send the browser to.
 *
 * No `scope` parameter, on purpose: with no scopes the token that comes back can
 * read public profile data and nothing else. It is the smallest thing GitHub can
 * issue, and it is all this needs.
 */
export function authorizeUrl(config: GitHubConfig, state: string): string {
  const query = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    state,
    allow_signup: 'true',
  });
  return `https://github.com/login/oauth/authorize?${query.toString()}`;
}

/**
 * Exchange the callback's `code` for a profile.
 *
 * Written against the GitHub OAuth web application flow as documented in April 2026
 * (`POST https://github.com/login/oauth/access_token`, `GET https://api.github.com/user`
 * with `X-GitHub-Api-Version: 2022-11-28`). The request shape is pinned by a test
 * with an injected `fetch`, so a vendor change fails there and not in production.
 */
export async function githubProfile(
  config: GitHubConfig,
  code: string,
  fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init),
): Promise<ProviderProfile> {
  const tokenResponse = await fetchImpl('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
    }),
  });
  if (!tokenResponse.ok) {
    throw new SignInError('github-token', `GitHub refused the code exchange (${String(tokenResponse.status)}).`);
  }
  const tokenBody = (await tokenResponse.json()) as { access_token?: unknown; error_description?: unknown };
  const accessToken = typeof tokenBody.access_token === 'string' ? tokenBody.access_token : '';
  if (accessToken === '') {
    const detail = typeof tokenBody.error_description === 'string' ? tokenBody.error_description : 'no access token';
    throw new SignInError('github-token', `GitHub refused the code exchange: ${detail}.`);
  }

  const userResponse = await fetchImpl('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'txt2sfx-bank',
    },
  });
  if (!userResponse.ok) {
    throw new SignInError('github-profile', `GitHub would not describe the account (${String(userResponse.status)}).`);
  }
  const user = (await userResponse.json()) as {
    id?: unknown;
    login?: unknown;
    avatar_url?: unknown;
    created_at?: unknown;
  };
  if (typeof user.id !== 'number' || typeof user.login !== 'string') {
    throw new SignInError('github-profile', 'GitHub answered with a profile this server does not recognize.');
  }
  return {
    provider: 'github',
    externalId: String(user.id),
    login: user.login,
    avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : '',
    originAt: typeof user.created_at === 'string' ? user.created_at : '',
  };
}

/**
 * The age gate.
 *
 * An unknown creation date fails it. That is the safe direction: the only way to get
 * here without one is a provider response this server did not understand, and
 * "cannot tell how old this account is" should not read as "old enough".
 */
export function passesAgeGate(profile: ProviderProfile, now = new Date()): boolean {
  if (profile.originAt === '') return false;
  const created = Date.parse(profile.originAt);
  if (Number.isNaN(created)) return false;
  return now.getTime() - created >= MIN_ACCOUNT_AGE_DAYS * 86_400_000;
}

/* ------------------------------------------------------------------------- *
 * State and hand-off codes
 * ------------------------------------------------------------------------- */

/**
 * Short-lived one-time values: the OAuth `state`, and the hand-off code.
 *
 * In memory, not in SQLite. Both live for under a minute, both are worthless after
 * one use, and a restart losing them costs someone one click on "sign in" — writing
 * them to disk would buy nothing and would leave a table of dead secrets to sweep.
 */
export interface Ephemeral<T> {
  put(key: string, value: T, ttlSeconds: number, now?: number): void;
  /** Reads *and removes*. One use is the point. */
  take(key: string, now?: number): T | undefined;
  readonly size: number;
}

export function ephemeral<T>(): Ephemeral<T> {
  const entries = new Map<string, { value: T; expires: number }>();

  const prune = (now: number): void => {
    for (const [key, entry] of entries) if (entry.expires <= now) entries.delete(key);
  };

  return {
    put(key: string, value: T, ttlSeconds: number, now = Date.now()): void {
      prune(now);
      entries.set(key, { value, expires: now + ttlSeconds * 1000 });
    },
    take(key: string, now = Date.now()): T | undefined {
      prune(now);
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      return entry.value;
    },
    get size(): number {
      return entries.size;
    },
  };
}

/** A random one-time value for `state` and for hand-off codes. */
export function oneTimeValue(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Constant-time comparison of two secrets of any length.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the length,
 * so both sides are hashed to a fixed width first.
 */
export function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a, 'utf8').digest(),
    createHash('sha256').update(b, 'utf8').digest(),
  );
}
