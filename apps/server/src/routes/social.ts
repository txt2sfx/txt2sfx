/**
 * Likes, comments and reports over HTTP.
 *
 * ## `PUT` and `DELETE`, not `POST /vote`
 *
 * The old endpoint took `{ delta: ±1 }` from anybody, which meant the rating was
 * whatever the last script to run said it was. A like is a piece of state belonging
 * to one person — they have either liked it or they have not — so it is a `PUT` and
 * a `DELETE` on a resource, both idempotent, and the count is derived from the rows
 * rather than nudged. Pressing like twice is not two likes anywhere in the system.
 *
 * ## A comment that carries a sound pays the same price as a recipe
 *
 * Same parse, same validate, same render, same silence check. It is stored as a
 * comment rather than promoted into the bank — a counter-proposal is a reply, not an
 * entry — but nothing about the checking is relaxed just because it is smaller.
 *
 * @packageDocumentation
 */

import type { FastifyInstance } from 'fastify';
import { SoundlineError, hasErrors, parse, validate } from '@txt2sfx/core';
import type { AuthContext } from '../auth.js';
import { sendFailure, writerOf } from '../auth.js';
import { SILENCE_PEAK, type RenderQueue, measure } from '../render.js';
import { COMMENT_PAGE, checkComment } from '../social.js';
import type { Store } from '../store.js';
import { fail, intOf } from './recipes.js';

/** Options of {@link registerSocialRoutes}. */
export interface SocialRouteOptions {
  readonly queue: RenderQueue;
}

export function registerSocialRoutes(
  app: FastifyInstance,
  store: Store,
  context: AuthContext,
  options: SocialRouteOptions,
): void {
  /** `:id` as an integer plus the recipe behind it, or the reply that says why not. */
  const recipeParam = (params: unknown): { id: number } | { error: string; message: string } => {
    const id = intOf((params as Record<string, unknown>)['id']);
    if (id === undefined) return { error: 'bad-id', message: 'The recipe id must be an integer.' };
    if (store.recipes.get(id) === undefined) {
      return { error: 'not-found', message: `No recipe with id ${String(id)}.` };
    }
    return { id };
  };

  app.put('/api/recipes/:id/like', async (request, reply) => {
    const writer = writerOf(request, context, store.identity);
    if ('failure' in writer) return sendFailure(reply, writer.failure);

    const target = recipeParam(request.params);
    if ('error' in target) return fail(reply, target.error === 'bad-id' ? 400 : 404, target);

    /* Charged before the state change, and only when it is a change: pressing like
       on something already liked is a no-op, and no-ops should not consume an
       allowance that exists to slow down mass voting. */
    if (!store.social.hasLiked(target.id, writer.actor.id)) {
      const decision = store.limits.spend(writer.actor.id, 'like');
      if (!decision.allowed) {
        return reply
          .status(429)
          .header('retry-after', String(decision.retryAfterSeconds))
          .send({ error: 'rate-limited', message: 'That is a lot of likes in a short time. Try again shortly.' });
      }
    }

    const rating = store.social.like(target.id, writer.actor.id);
    return { id: target.id, rating, liked: true };
  });

  app.delete('/api/recipes/:id/like', async (request, reply) => {
    const writer = writerOf(request, context, store.identity);
    if ('failure' in writer) return sendFailure(reply, writer.failure);

    const target = recipeParam(request.params);
    if ('error' in target) return fail(reply, target.error === 'bad-id' ? 400 : 404, target);

    /* Not rate limited. Taking a like back must never be the thing that is refused —
       it is the one action here that only ever reduces someone's reach. */
    const rating = store.social.unlike(target.id, writer.actor.id);
    return { id: target.id, rating, liked: false };
  });

  app.get('/api/recipes/:id/comments', async (request, reply) => {
    const target = recipeParam(request.params);
    if ('error' in target) return fail(reply, target.error === 'bad-id' ? 400 : 404, target);
    const limit = intOf((request.query as Record<string, unknown>)['limit']) ?? COMMENT_PAGE;
    const comments = store.social.comments(target.id, limit);
    return { comments, count: comments.length };
  });

  app.post('/api/recipes/:id/comments', async (request, reply) => {
    const writer = writerOf(request, context, store.identity);
    if ('failure' in writer) return sendFailure(reply, writer.failure);

    const target = recipeParam(request.params);
    if ('error' in target) return fail(reply, target.error === 'bad-id' ? 400 : 404, target);

    const body = (request.body ?? {}) as { body?: unknown; soundline?: unknown };
    const text = typeof body.body === 'string' ? body.body : '';
    const soundline = typeof body.soundline === 'string' && body.soundline.trim() !== '' ? body.soundline : undefined;

    const rejection = checkComment(text, soundline !== undefined);
    if (rejection !== null) {
      return fail(reply, 400, { error: rejection.rule, message: rejection.message });
    }

    /* The attached sound is checked before the allowance is spent, for the same
       reason recipes are: a refusal that also costs you a token teaches people to
       stop trying rather than to fix the sound. */
    let rendered: Awaited<ReturnType<typeof measure>> | undefined;
    if (soundline !== undefined) {
      let ast;
      try {
        ast = parse(soundline);
      } catch (error) {
        const detail = error instanceof SoundlineError ? error.message : String(error);
        return fail(reply, 400, { error: 'parse-error', message: detail });
      }
      const issues = validate(ast);
      if (hasErrors(issues)) {
        return fail(reply, 422, {
          error: 'invalid-soundline',
          message: 'The attached soundline breaks a physical invariant. A reply that carries a sound is held to the same rules as a recipe.',
          issues,
        });
      }
      try {
        rendered = await options.queue.run(() => measure(ast));
      } catch (error) {
        return fail(reply, 422, {
          error: 'render-failed',
          message: `The attached soundline could not be rendered: ${String(error)}`,
        });
      }
      if (rendered.peak < SILENCE_PEAK) {
        return fail(reply, 422, {
          error: 'silence',
          message: `The attached soundline renders to silence (peak ${rendered.peak.toExponential(2)}).`,
        });
      }
    }

    const decision = store.limits.spend(writer.actor.id, 'comment');
    if (!decision.allowed) {
      return reply
        .status(429)
        .header('retry-after', String(decision.retryAfterSeconds))
        .send({
          error: 'rate-limited',
          message: `That is enough comments for now — try again in ${String(Math.ceil(decision.retryAfterSeconds / 60))} minute(s).`,
        });
    }

    const comment = store.social.addComment({
      recipeId: target.id,
      actorId: writer.actor.id,
      body: text,
      ...(soundline === undefined ? {} : { soundline }),
    });
    return reply.status(201).send({ comment, remaining: decision.remaining });
  });

  app.post('/api/reports', async (request, reply) => {
    const writer = writerOf(request, context, store.identity);
    if ('failure' in writer) return sendFailure(reply, writer.failure);

    const body = (request.body ?? {}) as { target?: unknown; id?: unknown; reason?: unknown };
    const target = body.target === 'recipe' || body.target === 'comment' ? body.target : undefined;
    const id = intOf(body.id);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    if (target === undefined || id === undefined || reason === '') {
      return fail(reply, 400, {
        error: 'bad-report',
        message: 'Send { "target": "recipe" | "comment", "id": <number>, "reason": "<what is wrong>" }.',
      });
    }
    const exists =
      target === 'recipe' ? store.recipes.getForModeration(id) !== undefined : store.social.getComment(id) !== undefined;
    if (!exists) {
      return fail(reply, 404, { error: 'not-found', message: `No ${target} with id ${String(id)}.` });
    }

    const decision = store.limits.spend(writer.actor.id, 'report');
    if (!decision.allowed) {
      return reply
        .status(429)
        .header('retry-after', String(decision.retryAfterSeconds))
        .send({
          error: 'rate-limited',
          message: 'Several reports are already open from this account. They are read by a person, and that takes a while.',
        });
    }

    const count = store.social.report(target, id, writer.actor.id, reason);
    return reply.status(202).send({
      target,
      id,
      reports: count,
      /* Deliberately not "it will be removed". Nothing here is automatic: a report
         puts something in front of a person, and saying otherwise would be a promise
         this server cannot keep. */
      message: 'Filed. Reports are reviewed by a human; nothing is hidden automatically.',
    });
  });
}
