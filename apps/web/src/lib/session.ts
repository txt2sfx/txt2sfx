/**
 * The recipes that exist only in this tab, kept across a reload.
 *
 * ## Why this breaks the "no `localStorage`" rule on purpose
 *
 * The rule it bends says state lives in React state and persistence goes through the
 * bank's API. That is right for a recipe somebody decided to keep: `examples/` is a git
 * directory and the bank is a shared store, and both are deliberate acts. It is wrong for
 * the thing this file stores. A generated recipe is the most expensive artefact on the
 * page — a model call, then a population of renders per generation of the fit — and until
 * it is saved or published it exists in exactly one place: `App`'s `session` array. A
 * reload, a crash, a devtools mishap, and the whole run is gone with nothing to restore
 * from. The bank is not the answer either: publishing is how a recipe joins a shared
 * catalog, and a half-finished candidate has no business being there.
 *
 * So: unsaved work survives here, and nothing else does.
 *
 * - **Never a credential.** A pasted API key still goes to `lib/keystore.ts`, encrypted
 *   under a non-extractable `CryptoKey` in IndexedDB, because `localStorage` holds
 *   plaintext. That half of the rule is not negotiable.
 * - **Never the reference file.** It is the user's audio, it lives in memory, and a
 *   playground has no business copying it anywhere.
 * - **Never a render.** Audio is re-derived from the text in milliseconds; the text is
 *   the thing that cannot be re-derived.
 *
 * Same defensive posture as `lib/library.ts`, and for a sharper reason: this key is bigger
 * and holds a language, so it is likelier to be edited by hand or left behind by an older
 * version. A read that throws would take the page down while holding the user's work
 * hostage, so a single unreadable entry is dropped and the rest still loads.
 *
 * @packageDocumentation
 */

/** Where it lives. Versioned, so a shape change is a fresh start rather than a crash. */
const KEY = 'txt2sfx.session.v1';

/**
 * How many unsaved recipes are kept, newest last.
 *
 * Fifty soundlines at the ~1 KB the largest examples reach is ~50 KB, two orders of
 * magnitude under the ~5 MB an origin gets — the cap is not about the quota. It is
 * about the working set: nobody is coming back for the fortieth candidate of a session,
 * and an unbounded list would grow for the lifetime of the browser profile with no
 * screen in the app that shows how big it got.
 */
export const SESSION_LIMIT = 50;

/** One recipe that has not been saved to `examples/` or published to the bank. */
export interface SessionRecipe {
  readonly name: string;
  /** The soundline as it should reopen — the editor buffer, not a pristine copy. */
  readonly source: string;
  /** The prompt it answers. Empty for a recipe that arrived over a share link. */
  readonly prompt: string;
}

/**
 * Read them back, oldest first. Never throws.
 *
 * Anything without a usable name and body is dropped rather than repaired: a recipe with
 * an empty source would open as a blank editor claiming to be a generated sound, which is
 * worse than the entry simply not being there.
 */
export function loadSession(): SessionRecipe[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const recipes: SessionRecipe[] = [];
    for (const item of parsed as readonly unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const name = record['name'];
      const source = record['source'];
      if (typeof name !== 'string' || name === '') continue;
      if (typeof source !== 'string' || source.trim() === '') continue;
      recipes.push({
        name,
        source,
        prompt: typeof record['prompt'] === 'string' ? record['prompt'] : '',
      });
    }
    return recipes.slice(-SESSION_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Write them back, keeping the newest {@link SESSION_LIMIT}.
 *
 * Silent on failure, like `saveLibrary`: `localStorage` throws in a private window and on
 * a full quota, and there is nothing the user can do with an error about it mid-keystroke.
 * The cap is applied here as well as on the way in, so a quota that is already tight is
 * not made worse by the write that discovers it.
 */
export function saveSession(recipes: readonly SessionRecipe[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(recipes.slice(-SESSION_LIMIT)));
  } catch {
    // Nothing to do and nothing worth saying.
  }
}
