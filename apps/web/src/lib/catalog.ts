/**
 * What the gallery is showing, and where each entry came from.
 *
 * Four origins, kept distinct because they behave differently rather than to
 * decorate the list:
 *
 * - **`examples`** — the repository's reference set. Writable under `vite dev`, so
 *   this is where a recipe is authored and kept.
 * - **`preset`** — the fifty sounds bundled with the build (`presets/`). Read-only
 *   and always present, which is the point: without a key and without a bank the
 *   gallery is still a catalog with something in every category. They rank *below*
 *   the bank, because a live bank holds the same recipes with an id, a rating and a
 *   comment thread attached, and the bundled copy would only shadow them.
 * - **`bank`** — the running bank server. Read over HTTP, searchable, and the
 *   source of the few-shot examples the agent gets; a recipe goes there to be
 *   published, not to be edited in place.
 * - **`session`** — generated a moment ago by the prompt bar, or renamed here. It
 *   belongs to this browser and nowhere else until it is saved to `examples/` or
 *   published to the bank, and the gallery says so rather than pretending it is
 *   stored. It does survive a reload — `lib/session.ts` argues why work that exists
 *   in one place only is worth persisting even though a shared store is not involved.
 *
 * Session entries win over stored ones with the same name. A generated recipe is
 * given a non-colliding name (`recipeName`), so this only bites when the user
 * deliberately renames one onto an existing recipe — and in that case the buffer
 * they are looking at is the one they mean.
 *
 * @packageDocumentation
 */

import type { Recipe } from '@txt2sfx/shared';
import type { Preset } from './presets.js';

/** Where an entry came from. */
export type Origin = 'session' | 'examples' | 'bank' | 'preset';

/** One entry in the gallery. */
export interface Entry {
  readonly name: string;
  /** The soundline as stored — not the editor buffer, which may differ. */
  readonly source: string;
  readonly origin: Origin;
  /** The prompt this recipe answers, when it is known. Needed to publish. */
  readonly prompt?: string;
  readonly category?: string;
  readonly rating?: number;
  /** The bank's id, for entries that live there. */
  readonly id?: number;
  /** How many visible comments the bank reports. */
  readonly comments?: number;
  /** Who published it. Absent for the reference set, which has no author. */
  readonly author?: string;
}

/** Alphabetical, the order the sidebar has always used. */
export function byName(a: Entry, b: Entry): number {
  return a.name.localeCompare(b.name);
}

/** Turn what the bank listed into gallery entries. */
export function bankEntries(recipes: readonly Recipe[]): Entry[] {
  return recipes
    .map((recipe) => ({
      name: recipe.name,
      source: recipe.soundline,
      origin: 'bank' as const,
      prompt: recipe.prompt,
      category: recipe.category,
      rating: recipe.rating,
      id: recipe.id,
      comments: recipe.comments ?? 0,
      ...(recipe.author === undefined ? {} : { author: recipe.author.login }),
    }))
    .sort(byName);
}

/** Turn files on disk into gallery entries. */
export function exampleEntries(files: readonly { name: string; source: string }[]): Entry[] {
  return files.map((file) => ({ name: file.name, source: file.source, origin: 'examples' as const })).sort(byName);
}

/**
 * Turn the bundled presets into gallery entries.
 *
 * The prompt is carried over because a preset has one — it is declared in the file
 * — and the gallery's fallback of showing the leading comment would print the
 * `prompt:` marker itself under the card.
 */
export function presetEntries(presets: readonly Preset[]): Entry[] {
  return presets
    .map((preset) => ({
      name: preset.name,
      source: preset.source,
      origin: 'preset' as const,
      prompt: preset.prompt,
      category: preset.category,
    }))
    .sort(byName);
}

/**
 * The list the sidebar renders: this session's recipes first, then the store.
 *
 * A stored entry with a name a session entry already uses is dropped rather than
 * shown twice — two rows with one name would select the same editor buffer and
 * differ only in a badge.
 */
export function mergeCatalog(session: readonly Entry[], stored: readonly Entry[]): Entry[] {
  const claimed = new Set(session.map((entry) => entry.name));
  return [...session].sort(byName).concat(stored.filter((entry) => !claimed.has(entry.name)));
}
