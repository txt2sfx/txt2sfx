/**
 * Assembling the server without starting it.
 *
 * Kept separate from `index.ts` so tests can drive the real routes through
 * `app.inject()` — no port, no sockets, no cleanup race between tests. A server whose
 * HTTP layer can only be tested by binding a port ends up with its routes tested
 * through mocks instead, which is exactly where a wrong status code hides.
 *
 * @packageDocumentation
 */

import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AuthContext } from './auth.js';
import type { FetchLike } from './identity.js';
import { type RenderQueue, renderQueue } from './render.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerModerationRoutes } from './routes/moderation.js';
import { registerRoutes } from './routes/recipes.js';
import { registerSocialRoutes } from './routes/social.js';
import type { Store } from './store.js';

/** Options of {@link buildApp}. */
export interface AppOptions {
  readonly store: Store;
  readonly auth: AuthContext;
  /** Fastify's logger. Off in tests, on when serving. */
  readonly logger?: boolean;
  /** Shared render gate. One is made if none is given. */
  readonly queue?: RenderQueue;
  /** `fetch` for the identity provider. Injected by tests; never reaches a network there. */
  readonly fetch?: FetchLike;
}

/**
 * Build the app.
 *
 * ## CORS stays wide open, and authentication is why it can
 *
 * The bank holds public recipes and no secrets, and the requirement it exists for is
 * that someone else's agent or someone else's page can reach it without arrangements.
 * Writes are authenticated with a **bearer token**, never a cookie, so the browser
 * never attaches credentials to a cross-origin request on its own — a hostile page
 * can call this API exactly as it could call it from its own server, and no further.
 * A same-origin policy would protect nothing here and would block the one use case.
 *
 * The single exception is `/api/auth/*`, where the hand-off code and the return URL
 * are checked against an allow-list of origins for precisely the reason CORS does not
 * apply: a redirect is not a fetch.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  await app.register(cors, { origin: true });

  const queue = options.queue ?? renderQueue();

  app.setNotFoundHandler(async (request, reply) =>
    reply.status(404).send({
      error: 'no-route',
      message: `${request.method} ${request.url} is not a route. Start at GET /api/llms.txt for the full contract.`,
    }),
  );

  registerRoutes(app, options.store, options.auth, { queue });
  registerSocialRoutes(app, options.store, options.auth, { queue });
  registerAuthRoutes(app, options.store, options.auth, options.fetch === undefined ? {} : { fetch: options.fetch });
  registerModerationRoutes(app, options.store, options.auth);
  return app;
}
