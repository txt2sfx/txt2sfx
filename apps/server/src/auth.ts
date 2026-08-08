/**
 * Turning a request into a writer, or into a refusal that says what to do.
 *
 * ## Bearer tokens, never cookies
 *
 * The playground is served from one origin (a static site) and this API answers on
 * another. A cookie would therefore have to be third-party, `SameSite=None` and
 * `Secure`, and — the part that matters — it would be attached by the *browser* to
 * any request any page makes here, which is the definition of CSRF. A bearer token
 * cannot be: it lives in the page's own memory, and a hostile page cannot read it
 * across origins.
 *
 * That is also why CORS can stay wide open, as it always was. `origin: true` with no
 * cookies grants a hostile page exactly what it already had — the ability to make an
 * unauthenticated request it could have made from its own server — and keeps the one
 * property this bank exists for: anybody's agent, from anybody's page, with no
 * arrangements.
 *
 * ## Solo mode
 *
 * With no OAuth app configured there is no sign-in, one built-in `local` actor owns
 * every write, and the rate limits still apply (they are cheap, and a runaway script
 * on a laptop is still a runaway script). `assertSafeBinding` refuses to serve that
 * mode on a public interface — an anonymous writable bank reachable from the network
 * is not a configuration anybody chose deliberately.
 *
 * @packageDocumentation
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  type Actor,
  type GitHubConfig,
  type IdentityStore,
  soloActor,
} from './identity.js';

/** How this server establishes who is writing. */
export type AuthMode = 'github' | 'solo';

/** Everything the auth routes and the write guards need. */
export interface AuthContext {
  readonly mode: AuthMode;
  /** Present exactly when `mode === 'github'`. */
  readonly github?: GitHubConfig;
  /** The shared secret that unlocks the moderation routes, or `''` when there is none. */
  readonly adminToken: string;
}

/** The `Authorization: Bearer <token>` value, or `''`. */
export function bearerOf(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

/** Why a write was refused. */
export interface AuthFailure {
  readonly status: number;
  readonly error: string;
  readonly message: string;
}

/** The actor behind a request, or the refusal to send back. */
export type AuthResult = { readonly actor: Actor } | { readonly failure: AuthFailure };

/**
 * Who is writing.
 *
 * A banned account is refused here, once, rather than at each route: every write in
 * this system goes through this function, and a ban that has to be remembered at
 * seven call sites is a ban with six holes in it. Reading is unaffected — nothing
 * calls this for a read.
 */
export function writerOf(request: FastifyRequest, context: AuthContext, identity: IdentityStore): AuthResult {
  if (context.mode === 'solo') return { actor: soloActor(identity) };

  const token = bearerOf(request);
  if (token === '') {
    return {
      failure: {
        status: 401,
        error: 'sign-in-required',
        message:
          'Publishing, liking and commenting need an account. GET /api/auth/config for the sign-in URL; reading needs nothing.',
      },
    };
  }
  const actor = identity.resolve(token);
  if (actor === undefined) {
    return {
      failure: {
        status: 401,
        error: 'bad-session',
        message: 'That session is unknown or has expired. Sign in again.',
      },
    };
  }
  if (actor.bannedAt !== undefined) {
    return {
      failure: {
        status: 403,
        error: 'banned',
        message: 'This account may read the bank but not write to it.',
      },
    };
  }
  return { actor };
}

/** Send an {@link AuthFailure} as it stands. */
export function sendFailure(reply: FastifyReply, failure: AuthFailure): FastifyReply {
  return reply.status(failure.status).send({ error: failure.error, message: failure.message });
}

/**
 * Refuse to serve solo mode on a public interface.
 *
 * Called at startup, before the socket exists. The escape hatch is deliberate and
 * deliberately awkward: someone running a private bank on a LAN has a real use for
 * it, and should have to say so.
 */
export function assertSafeBinding(mode: AuthMode, host: string, allowOpen: boolean): void {
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (mode !== 'solo' || loopback || allowOpen) return;
  throw new Error(
    `refusing to serve on ${host} with no identity provider configured: every write would be anonymous and ` +
      `attributed to the built-in 'local' account. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, bind to ` +
      `127.0.0.1, or set TXT2SFX_ALLOW_OPEN=1 if an anonymous writable bank on this interface is what you want.`,
  );
}
