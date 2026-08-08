/**
 * The REST surface of the recipe bank.
 *
 * ## Errors are written for two readers
 *
 * Every failure carries a machine-readable `error` code and a human-readable
 * `message`, and a rejected soundline additionally carries the validator's `issues`
 * with their `hint` fields intact. The caller here is usually a language model in a
 * loop: a 400 that says "invalid request" costs it an iteration to discover what was
 * wrong, while a 400 that says `pop.max-freq-ramp ... shorten the frequency ramp to
 * 20ms or less` is a fix it can apply immediately.
 *
 * ## The soundline is the source of truth, and now so is the render
 *
 * `category` and `duration_ms` are read from the posted soundline, not from the
 * body, even though a client could send both: a recipe whose stored category
 * disagrees with its own header would be found by the wrong searches forever, and
 * the text is the one field that cannot be wrong about itself.
 *
 * The acoustic profile used to arrive on trust, and no longer does — this server
 * renders the soundline and measures it (`render.ts` explains why that is the
 * anti-spam mechanism and not merely a correctness fix). A `profile` in the body is
 * accepted and ignored, so older clients keep working; what gets stored is what was
 * measured here.
 *
 * ## The order of the checks is a policy
 *
 * Parse and validate first — they are microseconds and they refuse the overwhelming
 * majority of nonsense. Then deduplicate by canonical fingerprint, because a repost
 * is not a write and must not cost the author an allowance. Only then spend a rate
 * limit token, and only then render. Anything expensive sits behind everything cheap.
 *
 * @packageDocumentation
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Recipe, RecipeInput, ValidationIssue } from '@txt2sfx/shared';
import { SOUND_CATEGORIES } from '@txt2sfx/shared';
import { SoundlineError, declaredDurationMs, hasErrors, parse, validate } from '@txt2sfx/core';
import { llmsText, selectFewShot } from '@txt2sfx/agent';
import type { AuthContext } from '../auth.js';
import { bearerOf, sendFailure, writerOf } from '../auth.js';
import { DEFAULT_LIMIT } from '../db.js';
import { fingerprintOf } from '../db.js';
import { soloActor } from '../identity.js';
import { SILENCE_PEAK, type RenderQueue, measure } from '../render.js';
import { SCHEMA_VERSION } from '../schema.js';
import type { Store } from '../store.js';

/**
 * Few-shot examples embedded in `GET /api/llms.txt`.
 *
 * Three establishes the shape of the language and still leaves room for the caller's
 * own task in the context window.
 */
const FEW_SHOT_EXAMPLES = 3;

/** Shape of a rejection. */
interface ErrorBody {
  readonly error: string;
  readonly message: string;
  readonly issues?: readonly ValidationIssue[];
}

export function fail(reply: FastifyReply, status: number, body: ErrorBody): FastifyReply {
  return reply.status(status).send(body);
}

/** A positive integer from a query or path parameter. */
export function intOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

/** A category name, or undefined if the value is not one. */
function categoryOf(value: unknown): (typeof SOUND_CATEGORIES)[number] | undefined {
  return typeof value === 'string' && (SOUND_CATEGORIES as readonly string[]).includes(value)
    ? (value as (typeof SOUND_CATEGORIES)[number])
    : undefined;
}

/** The body `POST /api/recipes` accepts. */
interface PostBody {
  readonly name?: unknown;
  readonly prompt?: unknown;
  readonly soundline?: unknown;
  readonly tags?: unknown;
  /** The recipe this one was derived from, when it is a remix. */
  readonly parentId?: unknown;
}

/** Options of {@link registerRoutes}. */
export interface RouteOptions {
  readonly queue: RenderQueue;
}

/**
 * Which of these recipes the caller has liked.
 *
 * Answered alongside every listing rather than per card: a gallery of a hundred
 * recipes would otherwise be a hundred requests, and the heart that fills in half a
 * second after the page settles looks like a bug.
 */
function likedAmong(store: Store, context: AuthContext, token: string, recipes: readonly Recipe[]): number[] {
  if (recipes.length === 0) return [];
  /* Solo mode has exactly one writer and no tokens, so the answer is that writer's
     likes — a gallery that could not show them would make the button look broken on
     the one setup where there is nobody else to blame. */
  const actor = context.mode === 'solo' ? soloActor(store.identity) : token === '' ? undefined : store.identity.resolve(token);
  if (actor === undefined) return [];
  return [...store.social.likedAmong(actor.id, recipes.map((recipe) => recipe.id))];
}

/** Register every route on an instance. */
export function registerRoutes(
  app: FastifyInstance,
  store: Store,
  context: AuthContext,
  options: RouteOptions,
): void {
  const bank = store.recipes;

  app.get('/api/health', async () => ({
    status: 'ok',
    recipes: bank.count(),
    /* Version of the contract, not of the package: a client that caches `llms.txt`
       needs to know when the grammar it learned has moved. */
    grammar: 'soundline/v0',
    schema: SCHEMA_VERSION,
    auth: context.mode,
    /* A queue that is never empty is the one signal that this box is undersized for
       the renders it is being asked to do. */
    renderQueue: options.queue.depth,
  }));

  app.get('/api/llms.txt', async (_request, reply) => {
    /* Ask for more than we show, then keep the ones that pass validation. The bank
       is allowed to hold a recipe the validator rejects — the seeder loads
       `helicopter` on purpose — but this document is few-shot material for someone
       else's model, and an example that breaks an invariant teaches it to write what
       `POST /api/recipes` will refuse. See `selectFewShot`. */
    const top = bank.retrieve('', FEW_SHOT_EXAMPLES * 2);
    const selection = selectFewShot(top.recipes, FEW_SHOT_EXAMPLES);
    return reply
      .type('text/plain; charset=utf-8')
      .send(llmsText(selection.examples.map((example) => example.recipe)));
  });

  app.get('/api/recipes', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const rawCategory = query['category'];
    if (rawCategory !== undefined && categoryOf(rawCategory) === undefined) {
      return fail(reply, 400, {
        error: 'unknown-category',
        message: `'${String(rawCategory)}' is not a category. Use one of: ${SOUND_CATEGORIES.join(', ')}.`,
      });
    }
    const category = categoryOf(rawCategory);
    const q = typeof query['q'] === 'string' ? query['q'] : undefined;
    const author = intOf(query['author']);
    const sort = query['sort'] === 'top' ? 'top' : 'new';

    const recipes = bank.list({
      ...(q === undefined ? {} : { q }),
      ...(category === undefined ? {} : { category }),
      ...(author === undefined ? {} : { authorId: author }),
      sort,
      limit: intOf(query['limit']) ?? DEFAULT_LIMIT,
    });
    return { recipes, count: recipes.length, liked: likedAmong(store, context, bearerOf(request), recipes) };
  });

  app.get('/api/recipes/:id', async (request, reply) => {
    const id = intOf((request.params as Record<string, unknown>)['id']);
    if (id === undefined) {
      return fail(reply, 400, { error: 'bad-id', message: 'The recipe id must be an integer.' });
    }
    const recipe = bank.get(id);
    if (recipe === undefined) {
      return fail(reply, 404, { error: 'not-found', message: `No recipe with id ${String(id)}.` });
    }
    return recipe;
  });

  app.get('/api/retrieve', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const prompt = typeof query['prompt'] === 'string' ? query['prompt'] : '';
    if (prompt.trim() === '') {
      return fail(reply, 400, {
        error: 'missing-prompt',
        message: 'Pass ?prompt=<what you want to hear>. Retrieval ranks recipes against that text.',
      });
    }
    const result = bank.retrieve(prompt, intOf(query['k']) ?? 3);
    return {
      recipes: result.recipes,
      fallback: result.fallback,
      query: result.query,
      ...(result.fallback
        ? { note: 'Nothing matched the prompt. These are the highest-rated recipes, useful as grammar examples only.' }
        : {}),
    };
  });

  app.post('/api/recipes', async (request, reply) => {
    const writer = writerOf(request, context, store.identity);
    if ('failure' in writer) return sendFailure(reply, writer.failure);
    const actor = writer.actor;

    const body = (request.body ?? {}) as PostBody;

    if (typeof body.soundline !== 'string' || body.soundline.trim() === '') {
      return fail(reply, 400, {
        error: 'missing-soundline',
        message: 'A recipe is its soundline. Send { name, prompt, soundline, tags }.',
      });
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return fail(reply, 400, { error: 'missing-name', message: 'A recipe needs a name.' });
    }
    if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
      return fail(reply, 400, {
        error: 'missing-prompt',
        message: 'A recipe needs the prompt it answers — that is what retrieval matches against.',
      });
    }
    const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : [];

    const parentId = intOf(body.parentId);
    if (parentId !== undefined && bank.get(parentId) === undefined) {
      return fail(reply, 400, {
        error: 'unknown-parent',
        message: `This recipe says it was derived from #${String(parentId)}, and there is no such recipe.`,
      });
    }

    /* Parse first: a syntax error is not a validation issue, and its own message
       already says line, column and what was expected. */
    let ast;
    try {
      ast = parse(body.soundline);
    } catch (error) {
      const detail = error instanceof SoundlineError ? error.message : String(error);
      return fail(reply, 400, { error: 'parse-error', message: detail });
    }

    const issues = validate(ast);
    if (hasErrors(issues)) {
      return fail(reply, 422, {
        error: 'invalid-soundline',
        message: 'The soundline parses but breaks a physical invariant. Every issue below carries a hint you can act on.',
        issues,
      });
    }

    /* A write this endpoint has already accepted must be safe to retry, and the same
       check is what makes flooding pointless: identity is the canonical form, so a
       thousand reposts under a thousand names are one row. 200 rather than 201 says
       plainly that nothing new was created — and nothing is charged for it. */
    const fingerprint = fingerprintOf(body.soundline);
    const duplicate = bank.findByFingerprint(fingerprint);
    if (duplicate !== undefined) {
      return reply.status(200).send({ recipe: duplicate, warnings: issues, created: false });
    }

    const decision = store.limits.spend(actor.id, 'recipe');
    if (!decision.allowed) {
      return reply
        .status(429)
        .header('retry-after', String(decision.retryAfterSeconds))
        .send({
          error: 'rate-limited',
          message:
            `That is enough new recipes for now — try again in ${String(Math.ceil(decision.retryAfterSeconds / 60))} minute(s). ` +
            'The allowance grows as your recipes collect likes.',
        });
    }

    /* Rendered here, not trusted from the body: this is the step that makes the
       profile honest and makes a write cost the work it claims to be worth. */
    let report;
    try {
      report = await options.queue.run(() => measure(ast));
    } catch (error) {
      request.log.warn({ err: error }, 'render refused a posted recipe');
      return fail(reply, 422, {
        error: 'render-failed',
        message: `The soundline parses and validates but the renderer could not build it: ${String(error)}`,
      });
    }

    if (report.peak < SILENCE_PEAK) {
      return fail(reply, 422, {
        error: 'silence',
        message:
          `This renders to silence (peak ${report.peak.toExponential(2)}). Check the envelope — a gain that never ` +
          'opens, or a release shorter than the attack, is the usual cause.',
      });
    }

    const input: RecipeInput = {
      name: body.name,
      prompt: body.prompt,
      soundline: body.soundline,
      profile: report.profile,
      category: ast.category,
      tags,
      durationMs: declaredDurationMs(ast),
    };

    const stored = bank.insert(input, {
      authorId: actor.id,
      ...(parentId === undefined ? {} : { parentId }),
    });
    return reply.status(201).send({
      recipe: stored,
      /* Warnings do not block a write, but silently dropping them would lose the one
         chance to tell the author about them. Clipping is reported the same way the
         renderer reports it everywhere else: said, never fixed behind your back. */
      warnings: issues,
      created: true,
      measured: { peak: report.peak, clipped: report.clipped, durationMs: report.durationMs },
      remaining: decision.remaining,
    });
  });
}
