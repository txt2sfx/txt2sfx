/**
 * The recipe bank: the queries over `recipes` and its FTS5 index.
 *
 * The schema, the migrations and the `node:sqlite` handle live in `schema.ts`; this
 * module takes a database and answers questions about recipes. That split arrived
 * with likes and comments — four stores over one file need one place that owns the
 * file, or each of them opens its own handle and WAL turns into a lock fight.
 *
 * ## Where validation is not
 *
 * This module writes what it is given. Validating and *rendering* a soundline before
 * storing it is the HTTP boundary's job (`routes/recipes.ts`), because that is where
 * untrusted input arrives. The seeder is not untrusted input — it is the
 * repository's own reference set — and it needs to be able to load a recipe the
 * validator objects to while *reporting* the objection, rather than silently ending
 * up with a bank that is missing whichever recipes are currently imperfect.
 *
 * ## Hidden rows
 *
 * Every read here excludes `hidden = 1`. Moderation hides rather than deletes, and a
 * single missed filter would put a hidden recipe back into search results, into
 * `retrieve`, and therefore into someone else's model prompt. The one deliberate
 * exception is {@link RecipeBank.getForModeration}, whose name says so.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import type { Recipe, RecipeInput, SoundCategory, SoundProfile } from '@txt2sfx/shared';
import { parse, serialize } from '@txt2sfx/core';
import type { Database } from './schema.js';
import { openDatabase } from './schema.js';

/* ------------------------------------------------------------------------- *
 * Identity of a recipe
 * ------------------------------------------------------------------------- */

/**
 * The canonical-form hash that decides whether two recipes are the same recipe.
 *
 * Not a hash of the posted bytes. `serialize(parse(src))` is byte-stable in this
 * project — the round-trip test asserts it — so re-serializing first collapses the
 * whole family of "same sound, different whitespace, different number formatting"
 * into one identity. That is what makes flooding the bank with a thousand copies of
 * one recipe impossible rather than merely detectable: the unique index refuses the
 * second one.
 *
 * Returns `''` for a source the parser rejects. The caller decides what that means;
 * for the HTTP boundary it cannot happen (parsing comes first), and for the seeder
 * it means an old reference recipe simply does not participate in deduplication.
 */
export function fingerprintOf(source: string): string {
  try {
    return createHash('sha256').update(serialize(parse(source)), 'utf8').digest('hex');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------------- *
 * Rows
 * ------------------------------------------------------------------------- */

/** A row as SQLite hands it back, with the author joined in. */
interface RecipeRow {
  readonly id: number;
  readonly name: string;
  readonly prompt: string;
  readonly soundline: string;
  readonly profile_json: string;
  readonly category: string;
  readonly tags: string;
  readonly duration_ms: number;
  readonly rating: number;
  readonly created_at: string;
  readonly fingerprint: string;
  readonly author_id: number | null;
  readonly parent_id: number | null;
  readonly hidden: number;
  readonly author_login: string | null;
  readonly author_avatar: string | null;
  readonly comment_count: number | null;
}

/**
 * Row to {@link Recipe}.
 *
 * `profile_json` is parsed defensively. It was written by whoever posted the recipe,
 * and a bank that throws on one malformed row would stop serving every search that
 * happens to rank that row highly — a corrupt profile should cost that recipe its
 * usefulness, not the endpoint its availability.
 *
 * The optional fields are spread conditionally rather than set to `undefined`:
 * `exactOptionalPropertyTypes` is on, and more to the point a reference recipe has
 * no author at all — `author: undefined` and "no author" should not be two states.
 */
function toRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    soundline: row.soundline,
    profile: parseJson<SoundProfile>(row.profile_json) ?? EMPTY_PROFILE,
    category: row.category as SoundCategory,
    tags: parseJson<string[]>(row.tags) ?? [],
    durationMs: row.duration_ms,
    rating: row.rating,
    createdAt: row.created_at,
    ...(row.author_id === null || row.author_login === null
      ? {}
      : { author: { id: row.author_id, login: row.author_login, avatarUrl: row.author_avatar ?? '' } }),
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    ...(row.fingerprint === '' ? {} : { fingerprint: row.fingerprint }),
    ...(row.comment_count === null ? {} : { comments: row.comment_count }),
  };
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Stand-in for an unreadable profile: measurably empty, never mistaken for real. */
const EMPTY_PROFILE: SoundProfile = {
  durationMs: 0,
  attackMs: 0,
  rmsEnvelope: [],
  centroidHz: [],
  flatness: 0,
  noiseRatio: 0,
  peakHz: 0,
  loudnessLufsApprox: -Infinity,
};

/**
 * The columns every read needs, with the author and the comment count attached.
 *
 * One string rather than one per query: the author join is easy to forget, and a
 * listing where half the recipes silently lost their attribution is the kind of bug
 * that reaches production because it looks like data, not like code.
 */
const SELECT_RECIPE = `
  SELECT recipes.*,
         actors.login      AS author_login,
         actors.avatar_url AS author_avatar,
         (SELECT COUNT(*) FROM comments WHERE comments.recipe_id = recipes.id AND comments.hidden = 0)
           AS comment_count
  FROM recipes
  LEFT JOIN actors ON actors.id = recipes.author_id
`;

/* ------------------------------------------------------------------------- *
 * Full-text queries
 * ------------------------------------------------------------------------- */

/**
 * English function words, dropped from a search.
 *
 * Deliberately short. FTS5 ranks with bm25, which already gives a term appearing in
 * every document almost no weight, so a long stopword list would be duplicating the
 * ranker's job and would eventually delete a word that mattered. These are here
 * because they are pure syntax — "a pop for the menu" should find the same thing as
 * "pop menu".
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'on', 'at', 'to', 'with',
  'my', 'me', 'i', 'it', 'is', 'that', 'this', 'some', 'like',
]);

/**
 * A user prompt turned into an FTS5 expression.
 *
 * Two things this has to get right. **Quoting:** every token becomes an FTS5 string
 * literal, because a prompt is user text and words like `NEAR`, `OR` or a bare `*`
 * are operators in FTS5 syntax — an unquoted prompt is a query-injection bug that
 * shows up as a 500 on the day someone searches for "near miss". **`OR`, not the
 * implicit `AND`:** FTS5 defaults to requiring every term, and no recipe in the bank
 * contains all of "coin", "pickup" and "sound", so the default would answer a
 * perfectly good prompt with nothing.
 */
export function ftsQuery(prompt: string): string | null {
  const tokens = prompt
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * bm25 column weights: name, prompt, tags.
 *
 * The name is what a recipe is called and is the shortest, most deliberate field — a
 * match there is nearly always the right answer. Tags come next because they were
 * chosen to be searched. The prompt is prose and matches loosely, so it ranks lowest
 * per hit while still carrying most of the recall.
 */
const BM25_WEIGHTS = '5.0, 1.0, 3.0';

/* ------------------------------------------------------------------------- *
 * The bank
 * ------------------------------------------------------------------------- */

/** Filters of {@link RecipeBank.list}. */
export interface ListQuery {
  /** Free text. Omitted or empty returns the newest recipes. */
  readonly q?: string;
  readonly category?: SoundCategory;
  readonly limit?: number;
  /** Only recipes published by this actor. */
  readonly authorId?: number;
  /**
   * Order a text-free listing by likes rather than by recency.
   *
   * The gallery's two tabs. Newest is the default because a bank whose front page
   * cannot change is a bank nobody returns to.
   */
  readonly sort?: 'new' | 'top';
}

/** Outcome of a retrieval. */
export interface RetrieveResult {
  readonly recipes: readonly Recipe[];
  /**
   * True when the search matched nothing and these are stand-ins.
   *
   * An empty answer is the worst thing this endpoint can return: its caller is a
   * language model that needs examples of the grammar before it can write any, and
   * it has no other source for them. Highest-rated recipes are a poor answer to the
   * prompt but a good answer to "show me what a recipe looks like" — and the flag
   * keeps the caller from mistaking one for the other.
   */
  readonly fallback: boolean;
  /** The FTS expression used, or null when the prompt had no usable words. */
  readonly query: string | null;
}

/** Default page size, and the ceiling a caller cannot exceed. */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** What a recipe carries beyond its text when it is published by a person. */
export interface Attribution {
  readonly authorId?: number;
  /** The recipe this one was derived from. */
  readonly parentId?: number;
}

/** Everything the HTTP layer is allowed to do to the bank. */
export interface RecipeBank {
  list(query?: ListQuery): Recipe[];
  get(id: number): Recipe | undefined;
  /** Ignores `hidden`. For moderation, and named so nothing else reaches for it. */
  getForModeration(id: number): Recipe | undefined;
  /**
   * Whether a recipe by this name is already stored.
   *
   * Asked per name rather than answered by listing everything: `list` is capped at
   * {@link MAX_LIMIT}, so a seeder that deduplicated against a listing would start
   * re-inserting the moment the bank grew past that cap — and it would do it
   * silently, once per run, for every recipe outside the newest hundred.
   */
  hasName(name: string): boolean;
  /**
   * The stored recipe with this canonical fingerprint, if any.
   *
   * This is both the retry-safety and the anti-flood mechanism. A client whose
   * request timed out sends the identical bytes again, and two identical rows in a
   * bank is worse than a dropped write: both are retrievable, both are used as
   * few-shot examples, and likes split between them. Someone posting the same sound
   * a thousand times under a thousand names hits exactly the same wall.
   */
  findByFingerprint(fingerprint: string): Recipe | undefined;
  /** Stores a recipe as given. Validation belongs to the caller. */
  insert(input: RecipeInput, attribution?: Attribution): Recipe;
  /** Sets the denormalized like count. Owned by the social store. */
  setRating(id: number, rating: number): void;
  /** Hides or unhides. Returns false when there is no such recipe. */
  setHidden(id: number, hidden: boolean): boolean;
  /** Top-k for few-shot prompting. */
  retrieve(prompt: string, k?: number): RetrieveResult;
  count(): number;
  /** Every non-hidden recipe, oldest first. For the corpus dump. */
  all(): Recipe[];
  close(): void;
}

/**
 * The bank over an already-open database.
 *
 * @param db - A handle from {@link openDatabase}, migrated. Shared with the identity
 *   and social stores; closing it is the owner's job, not this object's, except
 *   through {@link RecipeBank.close} which exists for the callers that own both.
 */
export function recipeBank(db: Database): RecipeBank {
  const clampLimit = (limit: number | undefined): number =>
    Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit ?? DEFAULT_LIMIT)));

  const rowsToRecipes = (rows: unknown): Recipe[] => (rows as RecipeRow[]).map(toRecipe);

  const byRating = (limit: number, category?: string): Recipe[] =>
    rowsToRecipes(
      category === undefined
        ? db
            .prepare(`${SELECT_RECIPE} WHERE recipes.hidden = 0 ORDER BY recipes.rating DESC, recipes.id DESC LIMIT ?`)
            .all(limit)
        : db
            .prepare(
              `${SELECT_RECIPE} WHERE recipes.hidden = 0 AND recipes.category = ? ORDER BY recipes.rating DESC, recipes.id DESC LIMIT ?`,
            )
            .all(category, limit),
    );

  const search = (expression: string, limit: number, category?: string): Recipe[] => {
    const sql = `
      SELECT recipes.*,
             actors.login      AS author_login,
             actors.avatar_url AS author_avatar,
             (SELECT COUNT(*) FROM comments WHERE comments.recipe_id = recipes.id AND comments.hidden = 0)
               AS comment_count,
             bm25(recipes_fts, ${BM25_WEIGHTS}) AS score
      FROM recipes_fts
      JOIN recipes ON recipes.id = recipes_fts.rowid
      LEFT JOIN actors ON actors.id = recipes.author_id
      WHERE recipes_fts MATCH ? AND recipes.hidden = 0${category === undefined ? '' : ' AND recipes.category = ?'}
      ORDER BY score, recipes.rating DESC
      LIMIT ?
    `;
    return rowsToRecipes(
      category === undefined
        ? db.prepare(sql).all(expression, limit)
        : db.prepare(sql).all(expression, category, limit),
    );
  };

  const bank: RecipeBank = {
    list(query: ListQuery = {}): Recipe[] {
      const limit = clampLimit(query.limit);
      const expression = query.q === undefined ? null : ftsQuery(query.q);
      if (expression !== null) return search(expression, limit, query.category);

      /* Built rather than enumerated: three optional filters times two orderings is
         twelve hand-written statements, and the twelfth is where the `hidden`
         predicate goes missing. Every value is still bound, never interpolated. */
      const where: string[] = ['recipes.hidden = 0'];
      const params: (string | number)[] = [];
      if (query.category !== undefined) {
        where.push('recipes.category = ?');
        params.push(query.category);
      }
      if (query.authorId !== undefined) {
        where.push('recipes.author_id = ?');
        params.push(query.authorId);
      }
      const order = query.sort === 'top' ? 'recipes.rating DESC, recipes.id DESC' : 'recipes.id DESC';
      params.push(limit);
      return rowsToRecipes(
        db.prepare(`${SELECT_RECIPE} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...params),
      );
    },

    get(id: number): Recipe | undefined {
      const row = db.prepare(`${SELECT_RECIPE} WHERE recipes.id = ? AND recipes.hidden = 0`).get(id) as
        | unknown
        | undefined;
      return row === undefined ? undefined : toRecipe(row as RecipeRow);
    },

    getForModeration(id: number): Recipe | undefined {
      const row = db.prepare(`${SELECT_RECIPE} WHERE recipes.id = ?`).get(id) as unknown | undefined;
      return row === undefined ? undefined : toRecipe(row as RecipeRow);
    },

    hasName(name: string): boolean {
      return db.prepare('SELECT 1 AS found FROM recipes WHERE name = ? LIMIT 1').get(name) !== undefined;
    },

    findByFingerprint(fingerprint: string): Recipe | undefined {
      if (fingerprint === '') return undefined;
      const row = db.prepare(`${SELECT_RECIPE} WHERE recipes.fingerprint = ? LIMIT 1`).get(fingerprint) as
        | unknown
        | undefined;
      return row === undefined ? undefined : toRecipe(row as RecipeRow);
    },

    insert(input: RecipeInput, attribution: Attribution = {}): Recipe {
      const result = db
        .prepare(
          `INSERT INTO recipes
             (name, prompt, soundline, profile_json, category, tags, duration_ms, rating, created_at,
              fingerprint, author_id, parent_id, hidden)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0)`,
        )
        .run(
          input.name,
          input.prompt,
          input.soundline,
          JSON.stringify(input.profile),
          input.category,
          JSON.stringify(input.tags),
          Math.round(input.durationMs),
          new Date().toISOString(),
          fingerprintOf(input.soundline),
          attribution.authorId ?? null,
          attribution.parentId ?? null,
        );
      const id = Number(result.lastInsertRowid);
      const stored = bank.getForModeration(id);
      if (stored === undefined) throw new Error(`insert lost recipe ${String(id)}`);
      return stored;
    },

    setRating(id: number, rating: number): void {
      db.prepare('UPDATE recipes SET rating = ? WHERE id = ?').run(Math.trunc(rating), id);
    },

    setHidden(id: number, hidden: boolean): boolean {
      const result = db.prepare('UPDATE recipes SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
      return result.changes > 0;
    },

    retrieve(prompt: string, k = 3): RetrieveResult {
      const limit = clampLimit(k);
      const expression = ftsQuery(prompt);
      const matches = expression === null ? [] : search(expression, limit);
      if (matches.length > 0) return { recipes: matches, fallback: false, query: expression };
      return { recipes: byRating(limit), fallback: true, query: expression };
    },

    count(): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE hidden = 0').get() as unknown as { n: number };
      return Number(row.n);
    },

    all(): Recipe[] {
      return rowsToRecipes(db.prepare(`${SELECT_RECIPE} WHERE recipes.hidden = 0 ORDER BY recipes.id`).all());
    },

    close(): void {
      db.close();
    },
  };

  return bank;
}

/**
 * Open a database and return just its recipe bank.
 *
 * Kept because the seeder and a good many tests want nothing else. Anything that
 * needs likes, comments or identities wants `openStore` in `store.ts`, which builds
 * all four over a single handle.
 */
export function openBank(path: string): RecipeBank {
  return recipeBank(openDatabase(path));
}
