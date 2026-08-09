/**
 * Recipe metadata carried in the file's own leading comments.
 *
 * A soundline says everything about the *sound* and nothing about the request it
 * answers. The bank needs both — retrieval ranks a prompt against stored prompts,
 * and the gallery shows one under every card — so `presets/` writes them where a
 * comment already survives every stage of the toolchain:
 *
 * ```
 * # prompt: sci-fi laser pistol zap, quick and thin
 * # tags: laser, pistol, zap, weapon
 * sound "laser pistol" 160ms laser
 * ```
 *
 * ## Why comments rather than a sidecar file or a header field
 *
 * A sidecar (`presets/laser-pistol.json`) is a second file to keep in step with the
 * first, and the failure mode is silent: the recipe is edited, the prompt still
 * describes the old sound. A header field would be a grammar change — new syntax in
 * the parser, the serializer, the contract document and every generated table — for
 * data the compiler never reads. Comments already round-trip byte for byte
 * (`serializer.ts` prints `ast.leading` back out), so the metadata travels with the
 * recipe through parse, optimize and serialize without any of that.
 *
 * The cost is that these markers are a convention, not a checked type: a typo makes
 * the prompt absent rather than wrong. That is what `test/presets.test.ts` is for —
 * it holds every file in `presets/` to a non-empty prompt and at least two tags.
 *
 * @packageDocumentation
 */

import type { SoundAST } from '@txt2sfx/shared';

/** What a recipe's leading comments say about the request it answers. */
export interface RecipeMeta {
  /** The prompt this recipe is an answer to, or `null` when unmarked. */
  readonly prompt: string | null;
  /** Search tags, in written order. Empty when unmarked. */
  readonly tags: readonly string[];
}

/**
 * `# <marker>: <value>` at the start of a comment line.
 *
 * Anchored and case-insensitive, so prose that merely mentions the word — "the
 * prompt asked for something wetter" — is not mistaken for a marker. Leading
 * whitespace is allowed because the serializer prints `#` immediately followed by
 * the stored text and authors write `# prompt:`, not `#prompt:`.
 */
const MARKER = /^\s*(prompt|tags)\s*:\s*(.*)$/i;

/**
 * Read the `prompt:` and `tags:` markers from a document's leading comments.
 *
 * Only the comments above the header are considered: a layer's own comment explains
 * that layer, and promoting it to the recipe's description would put "attack 0ms is
 * required, not stylistic" under a gallery card.
 *
 * The first marker of each kind wins. A file with two `# prompt:` lines is a mistake
 * either way, and taking the first keeps the answer stable while it is being edited
 * from the top down.
 */
export function recipeMeta(ast: SoundAST): RecipeMeta {
  let prompt: string | null = null;
  let tags: readonly string[] | null = null;

  for (const comment of ast.leading) {
    const match = MARKER.exec(comment);
    if (match === null) continue;
    const value = (match[2] ?? '').trim();
    if (match[1]?.toLowerCase() === 'prompt') {
      if (prompt === null && value !== '') prompt = value;
    } else if (tags === null) {
      const parsed = value
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== '');
      if (parsed.length > 0) tags = parsed;
    }
  }

  return { prompt, tags: tags ?? [] };
}
