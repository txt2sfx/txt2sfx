/**
 * Moderation: five routes behind one shared secret.
 *
 * ## Why a token and not a role
 *
 * A moderator role would need an admin UI to grant it, an audit of who granted it,
 * and a decision about what happens when the person who has it leaves. This bank has
 * one operator. `TXT2SFX_ADMIN_TOKEN` in the service's environment is the honest
 * shape of that, and the day there is a second moderator is the day it should be
 * replaced rather than stretched.
 *
 * With no token configured the routes are not registered at all. A default password
 * is worse than no feature, and an endpoint that answers 401 tells an attacker it
 * exists.
 *
 * ## Hide, never delete
 *
 * Hiding takes something out of every listing, every search, every retrieval and the
 * corpus dump, and leaves the row where a person can look at it and disagree. A
 * moderation action that destroys the evidence cannot be reviewed, and this one is
 * exercised by exactly one person with no second pair of eyes.
 *
 * @packageDocumentation
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth.js';
import { bearerOf } from '../auth.js';
import { secretEquals } from '../identity.js';
import type { Store } from '../store.js';
import { fail, intOf } from './recipes.js';

/**
 * Whether the request carries the admin token.
 *
 * Compared in constant time. The token is long and random, so a timing attack on it
 * is not a realistic threat — but the comparison costs nothing and the alternative
 * is a line of code that reads like a mistake.
 */
function isAdmin(request: FastifyRequest, adminToken: string): boolean {
  const presented = bearerOf(request);
  return presented !== '' && secretEquals(presented, adminToken);
}

export function registerModerationRoutes(app: FastifyInstance, store: Store, context: AuthContext): void {
  const adminToken = context.adminToken;
  if (adminToken === '') return;

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/moderation')) return;
    if (isAdmin(request, adminToken)) return;
    return reply.status(404).send({
      error: 'no-route',
      message: `${request.method} ${request.url} is not a route. Start at GET /api/llms.txt for the full contract.`,
    });
  });

  app.get('/api/moderation/reports', async () => ({ reports: store.social.openReports() }));

  app.post('/api/moderation/recipes/:id/hidden', async (request, reply) => {
    const id = intOf((request.params as Record<string, unknown>)['id']);
    const hidden = (request.body as Record<string, unknown> | undefined)?.['hidden'] !== false;
    if (id === undefined) return fail(reply, 400, { error: 'bad-id', message: 'The recipe id must be an integer.' });
    if (!store.recipes.setHidden(id, hidden)) {
      return fail(reply, 404, { error: 'not-found', message: `No recipe with id ${String(id)}.` });
    }
    return { id, hidden, recipe: store.recipes.getForModeration(id) };
  });

  app.post('/api/moderation/comments/:id/hidden', async (request, reply) => {
    const id = intOf((request.params as Record<string, unknown>)['id']);
    const hidden = (request.body as Record<string, unknown> | undefined)?.['hidden'] !== false;
    if (id === undefined) return fail(reply, 400, { error: 'bad-id', message: 'The comment id must be an integer.' });
    if (!store.social.setCommentHidden(id, hidden)) {
      return fail(reply, 404, { error: 'not-found', message: `No comment with id ${String(id)}.` });
    }
    return { id, hidden };
  });

  app.post('/api/moderation/actors/:id/banned', async (request, reply) => {
    const id = intOf((request.params as Record<string, unknown>)['id']);
    const banned = (request.body as Record<string, unknown> | undefined)?.['banned'] !== false;
    if (id === undefined) return fail(reply, 400, { error: 'bad-id', message: 'The actor id must be an integer.' });
    const actor = store.identity.setBanned(id, banned);
    if (actor === undefined) {
      return fail(reply, 404, { error: 'not-found', message: `No actor with id ${String(id)}.` });
    }
    return { actor, sessionsDropped: banned };
  });

  /**
   * Everything one account ever wrote.
   *
   * Spam arrives in bursts from one account, and deciding what to do about it means
   * looking at the burst rather than at the one item somebody reported.
   */
  app.get('/api/moderation/actors/:id', async (request, reply) => {
    const id = intOf((request.params as Record<string, unknown>)['id']);
    if (id === undefined) return fail(reply, 400, { error: 'bad-id', message: 'The actor id must be an integer.' });
    const actor = store.identity.get(id);
    if (actor === undefined) {
      return fail(reply, 404, { error: 'not-found', message: `No actor with id ${String(id)}.` });
    }
    return {
      actor,
      recipes: store.recipes.list({ authorId: id, limit: 100 }),
      comments: store.social.commentCount(id),
    };
  });
}
