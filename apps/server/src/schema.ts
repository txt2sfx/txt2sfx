/**
 * The database, its schema, and the one-way steps that get an old file to it.
 *
 * ## Why migrations exist at all now
 *
 * Until the bank held only recipes, `CREATE TABLE IF NOT EXISTS` was a complete
 * migration story: the file either had the schema or was empty. Likes and comments
 * end that. There are banks in the wild — the seeded one on a laptop, the one this
 * repository's CI writes — whose `recipes` table has rows worth keeping and no
 * `fingerprint` column, and `IF NOT EXISTS` cannot add a column. So the version is
 * recorded in `PRAGMA user_version` and each step runs exactly once, in a
 * transaction, in order.
 *
 * `user_version` rather than a `migrations` table: it is a 32-bit integer in the
 * database header, SQLite maintains it for free, and there is no way to end up with
 * a migrations table that disagrees with the schema it claims to describe. The cost
 * is that steps cannot be applied out of order or partially — which is the property
 * wanted, not a limitation.
 *
 * ## Version 0 is not "empty"
 *
 * A file written before this module existed reports `user_version = 0` and already
 * has `recipes` and its FTS index. That is why step 1 is written with
 * `IF NOT EXISTS` throughout and is safe to run over such a file: it is the
 * *definition* of what version 1 means, not a set of changes from version 0.
 *
 * @packageDocumentation
 */

import type * as NodeSqlite from 'node:sqlite';

/**
 * `node:sqlite`, fetched in a way bundlers cannot mangle.
 *
 * See the long note in `db.ts`: a plain `import ... from 'node:sqlite'` is rewritten
 * by the Vite version this workspace pins, which is how the tests run.
 */
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof NodeSqlite;

/**
 * Step 1 — recipes and the triggers that keep the index honest.
 *
 * `content='recipes'` makes the FTS table a pure index: the text lives once, in
 * `recipes`, and FTS5 reads it through the rowid. That rules out the failure where a
 * recipe is edited and its index still matches the old words, but it also means FTS5
 * does not notice writes on its own — hence the three triggers. Losing them would
 * produce a bank that searches fine until the first update.
 */
const V1_RECIPES = `
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

/**
 * Step 2 — people, and the things they do to recipes.
 *
 * Decisions worth their column definitions:
 *
 * - **`fingerprint` is the canonical form's hash, and it is unique.** Two recipes
 *   that differ only in whitespace are one recipe; `serialize(parse(src))` is
 *   byte-stable in this project, so the hash of it is a reliable identity. The index
 *   is partial (`WHERE fingerprint <> ''`) because rows written before this step
 *   cannot always be re-serialized — a stored recipe is allowed to be one the parser
 *   now rejects — and a NULL-tolerant unique index would still collide them all on
 *   the empty string.
 *
 * - **`author_id` is nullable and stays that way.** The reference recipes have no
 *   author, and inventing a synthetic one so the column could be `NOT NULL` would
 *   put a fictional person's name under ten sounds in the gallery.
 *
 * - **`likes` is a table of rows, not a counter.** `recipes.rating` is kept as a
 *   denormalized count because retrieval already orders by it, but the rows are the
 *   truth: they are what makes a like revocable, what makes "one per person"
 *   enforceable by the database rather than by a check that can be raced, and what
 *   makes it possible to subtract a banned account's votes instead of guessing.
 *
 * - **`comments.soundline` is nullable, and when present it has been rendered.**
 *   A reply that carries a sound went through the same parse → validate → render as
 *   a published recipe. Storing the two in one table would have been tidier and
 *   wrong: a counter-proposal is not a bank entry, must not be retrieved as few-shot
 *   material, and must not compete for the unique fingerprint.
 *
 * - **`hidden` rather than `DELETE`.** Moderation that destroys evidence cannot be
 *   reviewed or reversed, and the nightly corpus dump simply skips hidden rows.
 */
const V2_SOCIAL = `
CREATE TABLE IF NOT EXISTS actors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT    NOT NULL,
  external_id TEXT    NOT NULL,
  login       TEXT    NOT NULL,
  avatar_url  TEXT    NOT NULL DEFAULT '',
  /* When the *upstream* account was created, not this row. It is what the age gate
     reads, and re-reading it from the provider on every request would be a network
     call per write. */
  origin_at   TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL,
  banned_at   TEXT,
  UNIQUE(provider, external_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  /* The token itself is never stored. A stolen database must not be a stack of
     usable bearer tokens, and nothing here needs to read one back. */
  token_hash TEXT    PRIMARY KEY,
  actor_id   INTEGER NOT NULL REFERENCES actors(id),
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_actor ON sessions(actor_id);

/* After the actors table, because the column references it. SQLite resolves a
   foreign key target at write time rather than at DDL time, so the order is not
   strictly required — but a schema that reads top to bottom is worth more. */
ALTER TABLE recipes ADD COLUMN fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE recipes ADD COLUMN author_id   INTEGER REFERENCES actors(id);
ALTER TABLE recipes ADD COLUMN parent_id   INTEGER REFERENCES recipes(id);
ALTER TABLE recipes ADD COLUMN hidden      INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS recipes_fingerprint
  ON recipes(fingerprint) WHERE fingerprint <> '';

CREATE TABLE IF NOT EXISTS likes (
  recipe_id  INTEGER NOT NULL REFERENCES recipes(id),
  actor_id   INTEGER NOT NULL REFERENCES actors(id),
  created_at TEXT    NOT NULL,
  PRIMARY KEY (recipe_id, actor_id)
);

CREATE INDEX IF NOT EXISTS likes_actor ON likes(actor_id);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id  INTEGER NOT NULL REFERENCES recipes(id),
  actor_id   INTEGER NOT NULL REFERENCES actors(id),
  body       TEXT    NOT NULL,
  soundline  TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS comments_recipe ON comments(recipe_id, id);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT    NOT NULL,
  target_id   INTEGER NOT NULL,
  actor_id    INTEGER NOT NULL REFERENCES actors(id),
  reason      TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  UNIQUE(target_kind, target_id, actor_id)
);

/* One row per (actor, kind of write). Tokens are a float because refill is
   continuous — storing whole tokens would round every partial refill down to zero
   and make a slow drip of writes free. */
CREATE TABLE IF NOT EXISTS buckets (
  actor_id   INTEGER NOT NULL,
  bucket     TEXT    NOT NULL,
  tokens     REAL    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (actor_id, bucket)
);
`;

/** Every step, in order. The index in this array is the version it produces. */
const STEPS: readonly string[] = [V1_RECIPES, V2_SOCIAL];

/** The version a freshly migrated database reports. */
export const SCHEMA_VERSION = STEPS.length;

/**
 * Fail early and legibly when this Node cannot do full-text search.
 *
 * The probe lives in `temp`, so it touches nothing in a real database file. Without
 * it, an unlucky Node version reports `no such module: fts5` from inside a
 * `CREATE VIRTUAL TABLE` during startup, which reads as a corrupt schema rather than
 * as a missing build flag.
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

/** The version recorded in the file. */
export function schemaVersion(db: NodeSqlite.DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
  return Number(row.user_version);
}

/**
 * Bring a database up to {@link SCHEMA_VERSION}.
 *
 * Each step is its own transaction, so an interrupted migration leaves the file at
 * the last version that fully applied rather than half-way into the next one.
 * `user_version` cannot be set through a bound parameter — it is a pragma, not a
 * statement — so the number is interpolated; it comes from this module's own array
 * length and never from input.
 */
export function migrate(db: NodeSqlite.DatabaseSync): number {
  const from = schemaVersion(db);
  for (let version = from; version < STEPS.length; version++) {
    const step = STEPS[version];
    if (step === undefined) continue;
    db.exec('BEGIN');
    try {
      db.exec(step);
      db.exec(`PRAGMA user_version = ${String(version + 1)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `migration to schema version ${String(version + 1)} failed on this database; ` +
          `it is still at version ${String(schemaVersion(db))} and usable. Cause: ${String(error)}`,
        { cause: error },
      );
    }
  }
  return STEPS.length;
}

/**
 * Open (or create) the database file, migrated and ready.
 *
 * @param path - File path, or `':memory:'` for a throwaway database. Tests use the
 *   second; it exercises the same schema and the same queries, which is the only way
 *   a search test is worth anything.
 */
export function openDatabase(path: string): NodeSqlite.DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  /* Off by default in SQLite, and this schema leans on it: a like row pointing at a
     recipe that never existed is not a state anything downstream can recover from. */
  db.exec('PRAGMA foreign_keys = ON');
  assertFts5(db);
  migrate(db);
  return db;
}

/** The handle type, for modules that take a database rather than open one. */
export type Database = NodeSqlite.DatabaseSync;
