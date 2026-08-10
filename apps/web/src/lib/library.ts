/**
 * What this browser remembers about the catalog, as opposed to what is in it.
 *
 * Three facts, and none of them belong on disk or in the bank:
 *
 * - **Favourites.** A starred name, and nothing else — the recipe itself is a file in
 *   a git repository or a row in a shared bank, and a button in a playground has no
 *   business writing to either. This replaced a trash list, which was the same
 *   mechanism pointed the other way: hiding things is work that pays off once the
 *   catalog is already too big, and marking the four you keep coming back to pays off
 *   immediately. Nothing was ever deleted by the old one either, so nothing is lost by
 *   dropping it — a stored `trashed` array is simply not read any more.
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
  /** Names starred by this browser. */
  readonly favorites: readonly string[];
  /** Name -> epoch milliseconds of the last edit made here. */
  readonly touched: Readonly<Record<string, number>>;
  /** Whether the gallery's three-step hint has been dismissed. */
  readonly onboarded: boolean;
}

const EMPTY: Library = { favorites: [], touched: {}, onboarded: false };

/** Read it, or start fresh. Never throws. */
export function loadLibrary(): Library {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Library>;
    return {
      /* A payload written before favourites existed has no such key and gets an empty
         list — which is why the storage version did not have to change: the recency
         map and the onboarding flag beside it are still exactly what they were, and
         throwing those away to drop one unused array would cost a user their `Recent`. */
      favorites: Array.isArray(parsed.favorites)
        ? parsed.favorites.filter((n): n is string => typeof n === 'string')
        : [],
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
