/**
 * One database file, four stores over it.
 *
 * Recipes, identities, social rows and rate-limit buckets all live in the same
 * SQLite file and must share one handle. Two handles on a WAL database are not
 * wrong, but they are two write locks racing over a bank that has exactly one
 * writer, and the failure — `SQLITE_BUSY` from a like, at random, under no load —
 * would be blamed on anything but the extra handle.
 *
 * @packageDocumentation
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type RecipeBank, recipeBank } from './db.js';
import { type IdentityStore, identityStore } from './identity.js';
import { type Limiter, limiter } from './limits.js';
import { type Database, openDatabase } from './schema.js';
import { type SocialStore, socialStore } from './social.js';

/** Everything the HTTP layer reads and writes. */
export interface Store {
  readonly db: Database;
  readonly recipes: RecipeBank;
  readonly identity: IdentityStore;
  readonly social: SocialStore;
  readonly limits: Limiter;
  close(): void;
}

/** Build the stores over an already-open database. Tests use `:memory:` this way. */
export function storeOver(db: Database): Store {
  return {
    db,
    recipes: recipeBank(db),
    identity: identityStore(db),
    social: socialStore(db),
    limits: limiter(db),
    close(): void {
      db.close();
    },
  };
}

/**
 * Open the file — creating its directory on a first run — and build the stores.
 *
 * @param path - File path, or `':memory:'`.
 */
export function openStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return storeOver(openDatabase(path));
}
