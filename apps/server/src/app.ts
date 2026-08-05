/**
 * Assembling the server without starting it.
 *
 * Kept separate from `index.ts` so tests can drive the real routes through
 * `app.inject()` — no port, no sockets, no cleanup race between tests. A server
 * whose HTTP layer can only be tested by binding a port ends up with its routes
 * tested through mocks instead, which is exactly where a wrong status code hides.
 *
 * @packageDocumentation
 */

import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { RecipeBank } from './db.js';
import { registerRoutes } from './routes/recipes.js';

/** Options of {@link buildApp}. */
export interface AppOptions {
  readonly bank: RecipeBank;
  /** Fastify's logger. Off in tests, on when serving. */
  readonly logger?: boolean;
}

/**
 * Build the app.
 *
 * CORS is wide open, deliberately. The bank holds public reference recipes and no
 * secrets, there is no authentication to protect, and the requirement it exists
 * for is that someone else's agent or someone else's page can reach it without
 * arrangements. A same-origin policy here would protect nothing and block the one
 * use case.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  await app.register(cors, { origin: true });

  app.setNotFoundHandler(async (request, reply) =>
    reply.status(404).send({
      error: 'no-route',
      message: `${request.method} ${request.url} is not a route. Start at GET /api/llms.txt for the full contract.`,
    }),
  );

  registerRoutes(app, options.bank);
  return app;
}
