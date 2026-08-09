/**
 * The shipped catalog: `presets/*.soundline`, bundled into the build.
 *
 * ## Why this is not `examples.ts`
 *
 * `examples/` is editable — under `vite dev` the playground writes recipes back to
 * disk, so that module has to prefer a dev endpoint over its bundled snapshot.
 * Presets are read-only by contract (`presets/README.md`): they are the fifty
 * sounds the gallery has before anybody has a key, and saving one from the studio
 * puts a copy in `examples/`, which is where authored work belongs. Read-only means
 * one code path and no endpoint, so this module is the glob and nothing else.
 *
 * Metadata comes out of the file rather than a table here — `recipeMeta` reads the
 * `# prompt:` and `# tags:` markers the contract requires, which is what keeps a
 * card's description in step with the sound it describes.
 *
 * @packageDocumentation
 */

import { parseWithDiagnostics, recipeMeta } from '@txt2sfx/core';

/** One preset, with everything the gallery and the local search need. */
export interface Preset {
  /** File name without the extension; also the catalog's key. */
  readonly name: string;
  readonly source: string;
  /** The prompt this recipe answers, from its `# prompt:` marker. */
  readonly prompt: string;
  /** Search tags, from its `# tags:` marker. */
  readonly tags: readonly string[];
  readonly category: string;
}

const RAW = import.meta.glob('../../../../presets/*.soundline', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const byName = (a: Preset, b: Preset): number => a.name.localeCompare(b.name);

/**
 * Every bundled preset, parsed.
 *
 * A file that fails to parse is **skipped, not thrown**. This runs at first paint,
 * and one bad character in one preset taking down the whole playground would be a
 * spectacular way to fail at "be useful without a key". The gate that keeps this
 * directory clean is `test/presets.test.ts`, which is allowed to be loud because
 * nobody is looking at a screen when it runs.
 */
export function bundledPresets(): Preset[] {
  const presets: Preset[] = [];
  for (const [path, source] of Object.entries(RAW)) {
    const { ast } = parseWithDiagnostics(source);
    if (ast === null) continue;
    const meta = recipeMeta(ast);
    presets.push({
      name: (path.split('/').pop() ?? path).replace(/\.soundline$/, ''),
      source,
      /* The name is a poor prompt and a good last resort: an entry with an empty
         one would rank against nothing in the offline search. */
      prompt: meta.prompt ?? ast.name,
      tags: meta.tags,
      category: ast.category,
    });
  }
  return presets.sort(byName);
}
