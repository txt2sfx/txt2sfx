/**
 * What this browser remembers about the catalog, as opposed to what is in it.
 *
 * Three facts, and none of them belong on disk or in the bank:
 *
 * - **Trash.** Removing a sound from the gallery is a *view* decision, not a
 *   deletion. `examples/` is a directory in a git repository and the bank is a
 *   shared store; a button in a playground has no business unlinking either. So
 *   trashing hides a name here and `restore` unhides it, and the file is exactly
 *   where it was the whole time. The alternative — a real delete — would make the
 *   Trash filter a lie, because there would be nothing left to restore from.
 * - **When each recipe was last touched.** Used for the `Recent` rail, which is the
 *   ordering anyone actually wants while working. `examples/*.soundline` have
 *   mtimes, but a recipe edited in this tab and not yet saved has no mtime at all,
 *   and the rail must not sort the thing you are editing to the bottom.
 * - **Whether the three-step hint has been dismissed.** Once.
 *
 * All of it is `localStorage`, all of it is disposable, and every read tolerates
 * garbage: a corrupted key must not be able to stop the playground from starting.
 *
 * @packageDocumentation
 */

/** Where it lives. Versioned, so a shape change is a fresh start rather than a crash. */
const KEY = 'txt2sfx.library.v1';

/** Per-browser catalog metadata. */
export interface Library {
  /** Names hidden from the gallery. */
  readonly trashed: readonly string[];
  /** Name -> epoch milliseconds of the last edit made here. */
  readonly touched: Readonly<Record<string, number>>;
  /** Whether the gallery's three-step hint has been dismissed. */
  readonly onboarded: boolean;
}

const EMPTY: Library = { trashed: [], touched: {}, onboarded: false };

/** Read it, or start fresh. Never throws. */
export function loadLibrary(): Library {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Library>;
    return {
      trashed: Array.isArray(parsed.trashed) ? parsed.trashed.filter((n): n is string => typeof n === 'string') : [],
      touched:
        typeof parsed.touched === 'object' && parsed.touched !== null
          ? (parsed.touched as Record<string, number>)
          : {},
      onboarded: parsed.onboarded === true,
    };
  } catch {
    return EMPTY;
  }
}

/**
 * Write it back.
 *
 * Silent on failure. `localStorage` throws in a private window with a full quota,
 * and losing the ordering of a rail is not worth an error the user cannot act on.
 */
export function saveLibrary(library: Library): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(library));
  } catch {
    // Nothing to do and nothing worth saying.
  }
}
