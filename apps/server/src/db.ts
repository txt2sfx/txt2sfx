/**
 * The recipe bank: SQLite with an FTS5 index, and the queries over it.
 *
 * ## Why `node:sqlite` and not better-sqlite3
 *
 * The plan named better-sqlite3. This uses Node's built-in `node:sqlite`, because
 * the development machine is **Windows on ARM64** and a native addon is exactly
 * where that platform hurts: prebuilt binaries for win32-arm64 have historically
 * been the last ones published, and without one the install falls back to node-gyp
 * and a Visual Studio toolchain. This workspace already narrows
 * `pnpm.onlyBuiltDependencies` to esbuild alone for the same reason. `node:sqlite`
 * is part of the Node binary, so there is nothing to build and nothing to ship per
 * architecture. Verified here: SQLite 3.51.3, `ENABLE_FTS5` in
 * `PRAGMA compile_options`, `bm25()` and external-content tables both working on
 * win32-arm64.
 *
 * The escape hatch, should this ever regress: better-sqlite3 v13+ ships N-API
 * prebuilds inside its own tarball — `prebuilds/win32-arm64.node` included — with
 * no install script, so the toolchain objection no longer applies to it either. It
 * is still one 17 MB dependency against zero, which is why the built-in wins.
 *
 * ## FTS5 is a build flag, and Node has flipped it
 *
 * The JavaScript API of `node:sqlite` has been stable, but whether its SQLite was
 * compiled with FTS5 has not: it is absent in Node 22.5–22.15, arrives in 22.16,
 * is absent again throughout **every** 23.x, and is unconditional from 24.0. So
 * "has `node:sqlite`" does not imply "can run this schema", and the failure mode is
 * a bare `no such module: fts5` from a `CREATE VIRTUAL TABLE` deep in startup.
 * {@link openBank} probes for it and says what is wrong instead.
 *
 * ## Where validation is not
 *
 * This module writes what it is given. Validating a soundline before storing it is
 * the HTTP boundary's job (`routes/recipes.ts`), because that is where untrusted
 * input arrives. The seeder is not untrusted input — it is the repository's own
 * reference set — and it needs to be able to load a recipe the validator objects
 * to while *reporting* the objection, rather than silently ending up with a bank
 * that is missing whichever recipes are currently imperfect.
 *
 * @packageDocumentation
 */

import type * as NodeSqlite from 'node:sqlite';
import type { Recipe, RecipeInput, SoundCategory, SoundProfile } from '@txt2sfx/shared';

/**
 * `node:sqlite`, fetched in a way bundlers cannot mangle.
 *
 * A plain `import { DatabaseSync } from 'node:sqlite'` is correct and works when
 * Node runs this file directly. It breaks under the Vite version this workspace
 * pins — which is how the tests run — because Vite decides what is a builtin by
 * stripping the `node:` prefix and looking the bare name up in
 * `module.builtinModules`, where `sqlite` appears *only* under its prefixed name.
 * Vite concludes there is an npm package called `sqlite`, rewrites the import to
 * it, and cannot resolve it. (Fixed upstream in vitest 3; this workspace is on 2.x.
 * Bumping it is a phase-7 decision, and this line stops mattering when it happens.)
 *
 * `process.getBuiltinModule` is the API for precisely this situation — reaching a
 * builtin without a specifier a bundler can rewrite — so production and tests load
 * the same module through the same line. The type is imported normally; type
 * imports are erased and nothing resolves them at runtime.
 */
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof NodeSqlite;

/* ------------------------------------------------------------------------- *
 * Schema
 * ------------------------------------------------------------------------- */

/**
 * Schema and the triggers that keep the index honest.
 *
 * `content='recipes'` makes the FTS table a pure index — the text lives once, in
 * `recipes`, and FTS5 reads it through the rowid. That rules out the failure where
 * a recipe is edited and its index still matches the old words, but it also means
 * FTS5 does not notice writes on its own, hence the three triggers. Losing them
 * would produce a bank that searches fine until the first update.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS recipes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  prompt       TEXT    NOT NULL,
  soundline    TEXT    NOT NULL,
  profile_json TEXT    NOT NULL,
  category     TEXT    NOT NULL,
  tags         TEXT    NOT NULL DEFAULT '[]',
  duration_ms  INTEGER NOT NULL,
  rating       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS recipes_fts USING fts5(
  name, prompt, tags,
  content='recipes',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS recipes_ai AFTER INSERT ON recipes BEGIN
  INSERT INTO recipes_fts(rowid, name, prompt, tags) VALUES (new.id, new.name, new.prompt, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS recipes_ad AFTER DELETE ON recipes BEGIN
  INSERT INTO recipes_fts(recipes_fts, rowid, name, prompt, tags)
    VALUES ('delete', old.id, old.name, old.prompt, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS recipes_au AFTER UPDATE ON recipes BEGIN
  INSERT INTO recipes_fts(recipes_fts, rowid, name, prompt, tags)
    VALUES ('delete', old.id, old.name, old.prompt, old.tags);
  INSERT INTO recipes_fts(rowid, name, prompt, tags) VALUES (new.id, new.name, new.prompt, new.tags);
END;
`;

/* ------------------------------------------------------------------------- *
 * Rows
 * ------------------------------------------------------------------------- */

/** A row as SQLite hands it back. */
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
}

/**
 * Row to {@link Recipe}.
 *
 * `profile_json` is parsed defensively. It was written by whoever posted the
 * recipe, and a bank that throws on one malformed row would stop serving every
 * search that happens to rank that row highly — a corrupt profile should cost
 * that recipe its usefulness, not the endpoint its availability.
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

/* ------------------------------------------------------------------------- *
 * Full-text queries
 * ------------------------------------------------------------------------- */

/**
 * English function words, dropped from a search.
 *
 * Deliberately short. FTS5 ranks with bm25, which already gives a term appearing
 * in every document almost no weight, so a long stopword list would be
 * duplicating the ranker's job and would eventually delete a word that mattered.
 * These are here because they are pure syntax — "a pop for the menu" should find
 * the same thing as "pop menu".
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'on', 'at', 'to', 'with',
  'my', 'me', 'i', 'it', 'is', 'that', 'this', 'some', 'like',
]);

/**
 * A user prompt turned into an FTS5 expression.
 *
 * Two things this has to get right. **Quoting:** every token becomes an FTS5
 * string literal, because a prompt is user text and words like `NEAR`, `OR` or a
 * bare `*` are operators in FTS5 syntax — an unquoted prompt is a query-injection
 * bug that shows up as a 500 on the day someone searches for "near miss".
 * **`OR`, not the implicit `AND`:** FTS5 defaults to requiring every term, and no
 * recipe in the bank contains all of "coin", "pickup" and "sound", so the default
 * would answer a perfectly good prompt with nothing.
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
 * The name is what a recipe is called and is the shortest, most deliberate field
 * — a match there is nearly always the right answer. Tags come next because they
 * were chosen to be searched. The prompt is prose and matches loosely, so it
 * ranks lowest per hit while still carrying most of the recall.
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
}

/** Outcome of a retrieval. */
export interface RetrieveResult {
  readonly recipes: readonly Recipe[];
  /**
   * True when the search matched nothing and these are stand-ins.
   *
   * An empty answer is the worst thing this endpoint can return: its caller is a
   * language model that needs examples of the grammar before it can write any,
   * and it has no other source for them. Highest-rated recipes are a poor answer
   * to the prompt but a good answer to "show me what a recipe looks like" — and
   * the flag keeps the caller from mistaking one for the other.
   */
  readonly fallback: boolean;
  /** The FTS expression used, or null when the prompt had no usable words. */
  readonly query: string | null;
}

/** Default page size, and the ceiling a caller cannot exceed. */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * Fail early and legibly when this Node cannot do full-text search.
 *
 * The probe lives in `temp`, so it touches nothing in a real database file. Without
 * it, an unlucky Node version reports `no such module: fts5` from inside a
 * `CREATE VIRTUAL TABLE` during startup, which reads as a corrupt schema rather
 * than as a missing build flag — see the note at the top of this module about which
 * versions have it.
 */
function assertFts5(db: NodeSqlite.DatabaseSync): void {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(probe)');
    db.exec('DROP TABLE temp.__fts5_probe');
  } catch (cause) {
    throw new Error(
      `this Node build has no SQLite FTS5, which the recipe bank needs for search. ` +
        `Running ${process.version}; FTS5 is compiled in from Node 22.16 (but not in any 23.x) and from 24.0 onwards. ` +
        `Upgrade Node, or use a build of Node with SQLITE_ENABLE_FTS5.`,
      { cause },
    );
  }
}

/** Everything the HTTP layer is allowed to do to the bank. */
export interface RecipeBank {
  list(query?: ListQuery): Recipe[];
  get(id: number): Recipe | undefined;
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
   * The stored recipe with exactly this name and this soundline, if any.
   *
   * For making writes safe to retry. A client whose request timed out will send the
   * identical bytes again, and two identical rows in a bank is worse than a dropped
   * write: both are retrievable, both are used as few-shot examples, and votes
   * split between them.
   */
  findIdentical(name: string, soundline: string): Recipe | undefined;
  /** Stores a recipe as given. Validation belongs to the caller. */
  insert(input: RecipeInput): Recipe;
  /** Adjusts a rating and returns the updated recipe, or undefined if unknown. */
  vote(id: number, delta: number): Recipe | undefined;
  /** Top-k for few-shot prompting. */
  retrieve(prompt: string, k?: number): RetrieveResult;
  count(): number;
  close(): void;
}

/**
 * Open (or create) a bank.
 *
 * @param path - File path, or `':memory:'` for a throwaway database. Tests use
 *   the second; it exercises the same schema and the same queries, which is the
 *   only way a search test is worth anything.
 */
export function openBank(path: string): RecipeBank {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  assertFts5(db);
  db.exec(SCHEMA);

  const clampLimit = (limit: number | undefined): number =>
    Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit ?? DEFAULT_LIMIT)));

  const selectById = db.prepare('SELECT * FROM recipes WHERE id = ?');

  const byRating = (limit: number, category?: string): Recipe[] => {
    const rows =
      category === undefined
        ? db.prepare('SELECT * FROM recipes ORDER BY rating DESC, id DESC LIMIT ?').all(limit)
        : db
            .prepare('SELECT * FROM recipes WHERE category = ? ORDER BY rating DESC, id DESC LIMIT ?')
            .all(category, limit);
    return (rows as unknown as RecipeRow[]).map(toRecipe);
  };

  const search = (expression: string, limit: number, category?: string): Recipe[] => {
    const sql = `
      SELECT recipes.*, bm25(recipes_fts, ${BM25_WEIGHTS}) AS score
      FROM recipes_fts
      JOIN recipes ON recipes.id = recipes_fts.rowid
      WHERE recipes_fts MATCH ?${category === undefined ? '' : ' AND recipes.category = ?'}
      ORDER BY score, recipes.rating DESC
      LIMIT ?
    `;
    const rows =
      category === undefined
        ? db.prepare(sql).all(expression, limit)
        : db.prepare(sql).all(expression, category, limit);
    return (rows as unknown as RecipeRow[]).map(toRecipe);
  };

  return {
    list(query: ListQuery = {}): Recipe[] {
      const limit = clampLimit(query.limit);
      const expression = query.q === undefined ? null : ftsQuery(query.q);
      if (expression === null) {
        const rows =
          query.category === undefined
            ? db.prepare('SELECT * FROM recipes ORDER BY id DESC LIMIT ?').all(limit)
            : db
                .prepare('SELECT * FROM recipes WHERE category = ? ORDER BY id DESC LIMIT ?')
                .all(query.category, limit);
        return (rows as unknown as RecipeRow[]).map(toRecipe);
      }
      return search(expression, limit, query.category);
    },

    get(id: number): Recipe | undefined {
      const row = selectById.get(id) as unknown as RecipeRow | undefined;
      return row === undefined ? undefined : toRecipe(row);
    },

    hasName(name: string): boolean {
      return db.prepare('SELECT 1 AS found FROM recipes WHERE name = ? LIMIT 1').get(name) !== undefined;
    },

    findIdentical(name: string, soundline: string): Recipe | undefined {
      const row = db
        .prepare('SELECT * FROM recipes WHERE name = ? AND soundline = ? ORDER BY id LIMIT 1')
        .get(name, soundline) as unknown as RecipeRow | undefined;
      return row === undefined ? undefined : toRecipe(row);
    },

    insert(input: RecipeInput): Recipe {
      const result = db
        .prepare(
          `INSERT INTO recipes (name, prompt, soundline, profile_json, category, tags, duration_ms, rating, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
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
        );
      const id = Number(result.lastInsertRowid);
      const stored = this.get(id);
      if (stored === undefined) throw new Error(`insert lost recipe ${String(id)}`);
      return stored;
    },

    vote(id: number, delta: number): Recipe | undefined {
      const result = db.prepare('UPDATE recipes SET rating = rating + ? WHERE id = ?').run(Math.trunc(delta), id);
      return result.changes === 0 ? undefined : this.get(id);
    },

    retrieve(prompt: string, k = 3): RetrieveResult {
      const limit = clampLimit(k);
      const expression = ftsQuery(prompt);
      const matches = expression === null ? [] : search(expression, limit);
      if (matches.length > 0) return { recipes: matches, fallback: false, query: expression };
      return { recipes: byRating(limit), fallback: true, query: expression };
    },

    count(): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM recipes').get() as unknown as { n: number };
      return Number(row.n);
    },

    close(): void {
      db.close();
    },
  };
}
