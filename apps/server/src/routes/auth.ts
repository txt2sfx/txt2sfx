/**
 * Sign-in: four routes and a redirect dance.
 *
 * ## Why the session is not handed over in the redirect
 *
 * The callback arrives as a top-level navigation, so anything it wants to give the
 * page has to travel in the URL. A bearer token in a URL ends up in browser history,
 * in the back button, in whatever the referrer policy leaks, and in the address bar
 * of a shared screen. So the callback redirects with a **single-use code**, good for
 * a minute, and the page trades it for the real token over `POST`. The code is
 * worthless the moment it is used, and worthless a minute later regardless.
 *
 * It rides in the fragment (`#signin=…`) rather than the query, which keeps it out of
 * the request the browser makes to whoever serves the playground.
 *
 * ## Why `return` is an allow-list
 *
 * An open redirect on a sign-in endpoint is how a session ends up delivered to
 * someone else's page. The origins that may receive one are configured, exact, and
 * few — the published playground, and localhost during development.
 *
 * @packageDocumentation
 */

import type { FastifyInstance } from 'fastify';
import type { AuthContext } from '../auth.js';
import { bearerOf, sendFailure, writerOf } from '../auth.js';
import {
  type Actor,
  type Ephemeral,
  type FetchLike,
  type GitHubConfig,
  HANDOFF_SECONDS,
  MIN_ACCOUNT_AGE_DAYS,
  SignInError,
  authorizeUrl,
  ephemeral,
  githubProfile,
  oneTimeValue,
  passesAgeGate,
} from '../identity.js';
import { allowanceFor, standingOf } from '../limits.js';
import type { Store } from '../store.js';

/** What a signed-in page is told about itself. */
interface MeBody {
  readonly actor: Actor;
  readonly allowances: Record<string, { remaining: number; burst: number; perHour: number }>;
  readonly standing: number;
}

/** Options of {@link registerAuthRoutes}. Injected so tests never reach the network. */
export interface AuthRoutesOptions {
  readonly fetch?: FetchLike;
}

/**
 * An origin is allowed when it matches one of the configured ones exactly.
 *
 * Compared as parsed origins rather than as strings so that a trailing slash or a
 * default port does not decide whether someone can sign in. Anything unparseable is
 * refused — a `return` that is not a URL is not a mistake worth guessing at.
 */
export function allowedReturn(target: string, allowed: readonly string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }
  for (const candidate of allowed) {
    try {
      if (new URL(candidate).origin === parsed.origin) return parsed.toString();
    } catch {
      /* A malformed entry in configuration should not take the whole list down. */
    }
  }
  return null;
}

/** Append a fragment parameter to a URL that may already have a fragment. */
function withFragment(target: string, key: string, value: string): string {
  const separator = target.includes('#') ? '&' : '#';
  return `${target}${separator}${key}=${encodeURIComponent(value)}`;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  store: Store,
  context: AuthContext,
  options: AuthRoutesOptions = {},
): void {
  /** `state` → where to send the browser back to. */
  const pending: Ephemeral<string> = ephemeral<string>();
  /** hand-off code → the minted session token. */
  const handoff: Ephemeral<string> = ephemeral<string>();

  const fetchImpl = options.fetch;

  const describe = (actor: Actor): MeBody => {
    const standing = standingOf(store.db, actor.id);
    const kinds = ['recipe', 'comment', 'like', 'report'] as const;
    const allowances: Record<string, { remaining: number; burst: number; perHour: number }> = {};
    for (const kind of kinds) {
      const allowance = allowanceFor(kind, standing);
      allowances[kind] = {
        remaining: store.limits.peek(actor.id, kind),
        burst: allowance.burst,
        perHour: allowance.perHour,
      };
    }
    return { actor, allowances, standing };
  };

  app.get('/api/auth/config', async () => ({
    mode: context.mode,
    /* The page needs to know both whether to draw a button and what it costs to
       press it — an age gate discovered *after* the GitHub round trip reads as a
       bug. */
    ...(context.mode === 'github'
      ? { signInPath: '/api/auth/github/start', minAccountAgeDays: MIN_ACCOUNT_AGE_DAYS }
      : { note: 'No identity provider is configured: this bank runs solo and attributes every write to `local`.' }),
  }));

  app.get('/api/auth/github/start', async (request, reply) => {
    const github: GitHubConfig | undefined = context.github;
    if (context.mode !== 'github' || github === undefined) {
      return reply.status(404).send({
        error: 'no-sign-in',
        message: 'This bank has no identity provider configured; it runs solo and needs no sign-in.',
      });
    }
    const requested = (request.query as Record<string, unknown>)['return'];
    const target = typeof requested === 'string' ? allowedReturn(requested, github.allowedRedirects) : null;
    if (target === null) {
      return reply.status(400).send({
        error: 'bad-return',
        message: `Pass ?return=<url> whose origin is one of: ${github.allowedRedirects.join(', ')}.`,
      });
    }
    const state = oneTimeValue();
    pending.put(state, target, 600);
    return reply.redirect(authorizeUrl(github, state), 302);
  });

  app.get('/api/auth/github/callback', async (request, reply) => {
    const github: GitHubConfig | undefined = context.github;
    if (context.mode !== 'github' || github === undefined) {
      return reply.status(404).send({ error: 'no-sign-in', message: 'No identity provider is configured.' });
    }
    const query = request.query as Record<string, unknown>;
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    const code = typeof query['code'] === 'string' ? query['code'] : '';
    const target = pending.take(state);

    /* Without a known return URL there is nowhere safe to send the browser, so the
       failure is shown here as text rather than redirected anywhere. */
    if (target === undefined) {
      return reply
        .status(400)
        .type('text/plain; charset=utf-8')
        .send('This sign-in link has expired or was already used. Start again from the playground.');
    }
    if (code === '') return reply.redirect(withFragment(target, 'signin_error', 'cancelled'), 302);

    try {
      const profile = await githubProfile(github, code, fetchImpl);
      if (!passesAgeGate(profile)) {
        return reply.redirect(withFragment(target, 'signin_error', 'account-too-new'), 302);
      }
      const actor = store.identity.upsert(profile);
      if (actor.bannedAt !== undefined) {
        return reply.redirect(withFragment(target, 'signin_error', 'banned'), 302);
      }
      const session = store.identity.startSession(actor.id);
      const handoffCode = oneTimeValue();
      handoff.put(handoffCode, session.token, HANDOFF_SECONDS);
      return reply.redirect(withFragment(target, 'signin', handoffCode), 302);
    } catch (error) {
      const code_ = error instanceof SignInError ? error.code : 'sign-in-failed';
      request.log.warn({ err: error }, 'github sign-in failed');
      return reply.redirect(withFragment(target, 'signin_error', code_), 302);
    }
  });

  app.post('/api/auth/exchange', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = typeof body['code'] === 'string' ? body['code'] : '';
    const token = code === '' ? undefined : handoff.take(code);
    if (token === undefined) {
      return reply.status(400).send({
        error: 'bad-code',
        message: `That hand-off code is unknown, already used, or older than ${String(HANDOFF_SECONDS)} seconds.`,
      });
    }
    const actor = store.identity.resolve(token);
    if (actor === undefined) {
      return reply.status(400).send({ error: 'bad-code', message: 'The session behind that code is gone.' });
    }
    return { token, ...describe(actor) };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const result = writerOf(request, context, store.identity);
    if ('failure' in result) return sendFailure(reply, result.failure);
    return describe(result.actor);
  });

  app.post('/api/auth/signout', async (request, reply) => {
    const token = bearerOf(request);
    if (token !== '') store.identity.endSession(token);
    return reply.status(204).send();
  });
}
