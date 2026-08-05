/**
 * The REST surface of the recipe bank.
 *
 * ## Errors are written for two readers
 *
 * Every failure carries a machine-readable `error` code and a human-readable
 * `message`, and a rejected soundline additionally carries the validator's
 * `issues` with their `hint` fields intact. The caller here is usually a language
 * model in a loop: a 400 that says "invalid request" costs it an iteration to
 * discover what was wrong, while a 400 that says `pop.max-freq-ramp ... shorten
 * the frequency ramp to 20ms or less` is a fix it can apply immediately.
 *
 * ## The soundline is the source of truth
 *
 * `category` and `duration_ms` are read from the posted soundline, not from the
 * body, even though a client could send both. A recipe whose stored category
 * disagrees with its own header would be found by the wrong searches forever, and
 * the text is the one field that cannot be wrong about itself.
 *
 * @packageDocumentation
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RecipeInput, SoundProfile, ValidationIssue } from '@txt2sfx/shared';
import { SOUND_CATEGORIES } from '@txt2sfx/shared';
import { SoundlineError, declaredDurationMs, hasErrors, parse, validate } from '@txt2sfx/core';
import { llmsText, selectFewShot } from '@txt2sfx/agent';
import type { RecipeBank } from '../db.js';
import { DEFAULT_LIMIT } from '../db.js';

/**
 * Few-shot examples embedded in `GET /api/llms.txt`.
 *
 * Three establishes the shape of the language and still leaves room for the
 * caller's own task in the context window.
 */
const FEW_SHOT_EXAMPLES = 3;

/** Shape of a rejection. */
interface ErrorBody {
  readonly error: string;
  readonly message: string;
  readonly issues?: readonly ValidationIssue[];
}

function fail(reply: FastifyReply, status: number, body: ErrorBody): FastifyReply {
  return reply.status(status).send(body);
}

/** A positive integer from a query or path parameter. */
function intOf(value: unknown): number | undefined {
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
  readonly profile?: unknown;
  readonly tags?: unknown;
}

/**
 * Whether a value is shaped like a {@link SoundProfile}.
 *
 * Checked rather than trusted because the server has no audio stack and cannot
 * recompute it: the profile is the one field here that arrives on trust, so the
 * least it can do is arrive in the right shape. A recipe stored with a
 * half-populated profile would poison every distance computed against it later,
 * and nothing downstream would be able to tell why.
 */
function isProfile(value: unknown): value is SoundProfile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const numbers = ['durationMs', 'attackMs', 'flatness', 'noiseRatio', 'peakHz', 'loudnessLufsApprox'];
  const arrays = ['rmsEnvelope', 'centroidHz'];
  return (
    numbers.every((key) => typeof candidate[key] === 'number') &&
    arrays.every((key) => Array.isArray(candidate[key]) && (candidate[key] as unknown[]).every((n) => typeof n === 'number'))
  );
}

/** Register every route on an instance. */
export function registerRoutes(app: FastifyInstance, bank: RecipeBank): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    recipes: bank.count(),
    /* Version of the contract, not of the package: a client that caches
       `llms.txt` needs to know when the grammar it learned has moved. */
    grammar: 'soundline/v0',
  }));

  app.get('/api/llms.txt', async (_request, reply) => {
    /* Ask for more than we show, then keep the ones that pass validation. The bank
       is allowed to hold a recipe the validator rejects — the seeder loads
       `helicopter` on purpose — but this document is few-shot material for someone
       else's model, and an example that breaks an invariant teaches it to write
       what `POST /api/recipes` will refuse. See `selectFewShot`. */
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

    const recipes = bank.list({
      ...(q === undefined ? {} : { q }),
      ...(category === undefined ? {} : { category }),
      limit: intOf(query['limit']) ?? DEFAULT_LIMIT,
    });
    return { recipes, count: recipes.length };
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
    const body = (request.body ?? {}) as PostBody;

    if (typeof body.soundline !== 'string' || body.soundline.trim() === '') {
      return fail(reply, 400, {
        error: 'missing-soundline',
        message: 'A recipe is its soundline. Send { name, prompt, soundline, profile, tags }.',
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
    if (!isProfile(body.profile)) {
      return fail(reply, 400, {
        error: 'missing-profile',
        message:
          'A recipe needs its acoustic profile from @txt2sfx/analyzer (extractProfile). The server has no audio stack and cannot measure the sound for you.',
      });
    }
    const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : [];

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

    /* A write this endpoint has already accepted must be safe to retry. An agent
       whose request timed out sends the identical bytes again, and two identical
       rows are worse than a dropped write: both are retrievable, both get used as
       few-shot examples, and votes split between them. 200 rather than 201 says
       plainly that nothing new was created. */
    const duplicate = bank.findIdentical(body.name, body.soundline);
    if (duplicate !== undefined) {
      return reply.status(200).send({ recipe: duplicate, warnings: issues, created: false });
    }

    const input: RecipeInput = {
      name: body.name,
      prompt: body.prompt,
      soundline: body.soundline,
      profile: body.profile,
      category: ast.category,
      tags,
      durationMs: declaredDurationMs(ast),
    };

    const stored = bank.insert(input);
    return reply.status(201).send({
      recipe: stored,
      /* Warnings do not block a write, but silently dropping them would lose the
         one chance to tell the author about them. */
      warnings: issues,
      created: true,
    });
  });

  app.post('/api/recipes/:id/vote', async (request, reply) => {
    const id = intOf((request.params as Record<string, unknown>)['id']);
    if (id === undefined) {
      return fail(reply, 400, { error: 'bad-id', message: 'The recipe id must be an integer.' });
    }
    const delta = intOf((request.body as Record<string, unknown> | undefined)?.['delta']);
    if (delta !== 1 && delta !== -1) {
      return fail(reply, 400, { error: 'bad-delta', message: 'Send { "delta": 1 } or { "delta": -1 }.' });
    }
    const updated = bank.vote(id, delta);
    if (updated === undefined) {
      return fail(reply, 404, { error: 'not-found', message: `No recipe with id ${String(id)}.` });
    }
    return updated;
  });
}
