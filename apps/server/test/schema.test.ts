/**
 * Migrations, against a database that already has rows in it.
 *
 * This is the test that matters for a schema change: an empty file migrating is not
 * evidence of anything, because `CREATE TABLE IF NOT EXISTS` would pass it. What has
 * to hold is that a bank someone has been using since before likes existed keeps its
 * recipes, its ratings and its search index.
 */

import { describe, expect, it } from 'vitest';
import type * as NodeSqlite from 'node:sqlite';
import { SCHEMA_VERSION, migrate, openDatabase, schemaVersion } from '../src/schema.js';
import { fingerprintOf, recipeBank } from '../src/db.js';
import { storeOver } from '../src/store.js';
import { soloActor } from '../src/identity.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof NodeSqlite;

/** The schema exactly as it stood before any of this existed: version 0, no pragma. */
const LEGACY = `
CREATE TABLE recipes (
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
CREATE VIRTUAL TABLE recipes_fts USING fts5(name, prompt, tags, content='recipes', content_rowid='id');
CREATE TRIGGER recipes_ai AFTER INSERT ON recipes BEGIN
  INSERT INTO recipes_fts(rowid, name, prompt, tags) VALUES (new.id, new.name, new.prompt, new.tags);
END;
INSERT INTO recipes (name, prompt, soundline, profile_json, category, tags, duration_ms, rating, created_at)
VALUES ('coin', 'coin pickup for a platformer', 'sound "coin" 260ms pickup', '{}', 'pickup', '["coin"]', 260, 7, '2026-01-01T00:00:00Z');
`;

describe('migrating a database that predates all of this', () => {
  it('keeps the recipes, the ratings and the index', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(LEGACY);
    expect(schemaVersion(db)).toBe(0);

    expect(migrate(db)).toBe(SCHEMA_VERSION);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);

    const bank = recipeBank(db);
    const stored = bank.list()[0];
    expect(stored?.name).toBe('coin');
    expect(stored?.rating).toBe(7);
    /* The row predates the fingerprint column, so it has none — and must not be
       mistaken for a recipe whose canonical form happens to be the empty string. */
    expect(stored?.fingerprint).toBeUndefined();
    expect(bank.list({ q: 'platformer' }).map((recipe) => recipe.name)).toEqual(['coin']);
    db.close();
  });

  it('is a no-op the second time, and every time after', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(LEGACY);
    migrate(db);
    const before = db.prepare('SELECT COUNT(*) AS n FROM recipes').get() as unknown as { n: number };

    expect(migrate(db)).toBe(SCHEMA_VERSION);
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    const after = db.prepare('SELECT COUNT(*) AS n FROM recipes').get() as unknown as { n: number };
    expect(after.n).toBe(before.n);
    db.close();
  });

  it('leaves the social tables usable straight after the migration', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(LEGACY);
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);

    const store = storeOver(db);
    const id = store.recipes.list()[0]?.id ?? 0;
    const actor = soloActor(store.identity);
    expect(store.social.like(id, actor.id)).toBe(1);
    /* The denormalized count is now the truth of the rows, not the 7 it inherited. */
    expect(store.recipes.get(id)?.rating).toBe(1);
    store.close();
  });
});

describe('a fresh database', () => {
  it('opens at the current version with foreign keys on', () => {
    const db = openDatabase(':memory:');
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    const row = db.prepare('PRAGMA foreign_keys').get() as unknown as { foreign_keys: number };
    expect(Number(row.foreign_keys)).toBe(1);
    db.close();
  });

  /** A like pointing at a recipe that never existed is not a state anything recovers from. */
  it('refuses a like against a recipe that does not exist', () => {
    const db = openDatabase(':memory:');
    const store = storeOver(db);
    const actor = soloActor(store.identity);
    expect(() => store.social.like(9999, actor.id)).toThrow();
    store.close();
  });

  it('hashes the canonical form, not the bytes', () => {
    const a = 'sound "coin" 260ms pickup\n  blip: tone square 988Hz | gain 0.5 decay 70ms\n';
    const b = 'sound "coin" 260ms pickup\n      blip: tone square 988Hz  |  gain 0.5 decay 70ms\n';
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
    expect(fingerprintOf(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
