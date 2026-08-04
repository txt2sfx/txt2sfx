/**
 * The recipe bank, phase-5-free edition.
 *
 * Until the bank server exists (phase 5) the gallery is the repository's
 * `examples/` directory, read two ways for two different situations:
 *
 * - **Under `vite dev`** the dev endpoint (`plugins/examples-fs.ts`) is asked, so
 *   the list is whatever is on disk right now — including recipes saved from the
 *   playground a moment ago.
 * - **In a static build** there is no endpoint, so the bundled `import.meta.glob`
 *   snapshot is used and saving is disabled.
 *
 * The glob is kept in both cases because it also gives the first paint something
 * to show before the fetch resolves.
 *
 * @packageDocumentation
 */

/** One recipe as it exists on disk. */
export interface Recipe {
  readonly name: string;
  readonly source: string;
}

const RAW = import.meta.glob('../../../../examples/*.soundline', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Swallow HMR for the globbed recipes.
 *
 * Saving a recipe changes a file this module imports, and Vite's answer to "a raw
 * import changed and nobody accepted it" is a full page reload — which would
 * throw away every unsaved buffer the instant you press Save. The authoritative
 * list comes from the dev endpoint anyway, so ignoring the module update is
 * correct rather than merely convenient.
 */
import.meta.hot?.accept(() => {});

/** Whether write-back is available — true under `vite dev`, false in a build. */
export const canSave: boolean = import.meta.env.DEV;

const byName = (a: Recipe, b: Recipe): number => a.name.localeCompare(b.name);

/** The snapshot bundled at build time. Instant, possibly stale under dev. */
export function bundledRecipes(): Recipe[] {
  return Object.entries(RAW)
    .map(([path, source]) => ({
      name: (path.split('/').pop() ?? path).replace(/\.soundline$/, ''),
      source,
    }))
    .sort(byName);
}

/**
 * The authoritative list: the dev endpoint when it exists, the bundle otherwise.
 *
 * Never rejects — a playground that shows nothing because a fetch failed is worse
 * than one showing a slightly stale gallery.
 */
export async function fetchRecipes(): Promise<Recipe[]> {
  if (!canSave) return bundledRecipes();
  try {
    const response = await fetch('/__examples');
    if (!response.ok) return bundledRecipes();
    const body = (await response.json()) as { recipes?: readonly Recipe[] };
    return body.recipes === undefined ? bundledRecipes() : [...body.recipes].sort(byName);
  } catch {
    return bundledRecipes();
  }
}

/**
 * Write a recipe to `examples/<name>.soundline`.
 *
 * @throws When the dev endpoint is absent (static build) or rejects the name.
 */
export async function saveRecipe(name: string, source: string): Promise<string> {
  const response = await fetch('/__examples', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, source }),
  });
  const body = (await response.json()) as { path?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? `save failed with ${String(response.status)}`);
  return body.path ?? `examples/${name}.soundline`;
}
