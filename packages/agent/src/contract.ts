/**
 * The contract document: everything a language model needs to write soundline,
 * in one text.
 *
 * It has two consumers and is deliberately one function. `GET /api/llms.txt`
 * serves it to **someone else's** agent, which must be able to use this project
 * without installing it — one request, no round trips spent discovering the
 * grammar. {@link systemPrompt} embeds the same text for **our own** loop. Two
 * documents would drift, and the one that drifted would be the one nobody reads
 * while debugging.
 *
 * Everything here is **generated from the same tables the parser and the
 * validator use** — `PRIMITIVES`, `EFFECTS`, `ENVELOPE`, `CATEGORY_LIMITS`,
 * `GLOBAL_LIMITS`. A hand-written document would be correct on the day it was
 * written and quietly wrong a phase later; this one cannot describe a primitive
 * that does not exist or omit a parameter that does.
 *
 * @packageDocumentation
 */

import type { ParamSpec, Recipe, Signature } from '@txt2sfx/shared';
import { CATEGORY_LIMITS, GLOBAL_LIMITS, SOUND_CATEGORIES } from '@txt2sfx/shared';
import { EFFECTS, ENVELOPE, PRIMITIVES, describeUnits } from '@txt2sfx/core';

/** How a parameter is written, e.g. `wave` or `[Q]`. */
function paramSyntax(spec: ParamSpec): string {
  const name = spec.positional === true ? spec.name : `${spec.name} <value>`;
  return spec.required === true ? `<${name}>` : `[${name}]`;
}

/** One row of the primitive or effect table. */
function signatureRow(signature: Signature): string {
  const syntax = [signature.name, ...signature.params.map(paramSyntax)].join(' ');
  return `| \`${syntax}\` | ${signature.doc} |`;
}

/** Every parameter of one signature, with units, ranges and defaults. */
function paramRows(signature: Signature): string {
  return signature.params
    .map((spec) => {
      const units = spec.kind === 'enum' ? (spec.values ?? []).join('\\|') : describeUnits(spec.kind);
      const range =
        spec.min === undefined && spec.max === undefined
          ? '—'
          : `${spec.min ?? '−∞'}..${spec.max ?? '∞'}`;
      const fallback =
        spec.default === undefined
          ? spec.required === true
            ? '**required**'
            : '—'
          : `\`${String(spec.default)}\``;
      const ramp = spec.rampable === true ? ' rampable' : '';
      return `| \`${signature.name}.${spec.name}\` | ${units} | ${range} | ${fallback} | ${spec.doc}${ramp} |`;
    })
    .join('\n');
}

/** The category table, straight out of `CATEGORY_LIMITS`. */
function categoryTable(): string {
  const head =
    '| category | duration, ms | max layer decay, ms | max freq ramp, ms | max layers | loop | what it is |\n' +
    '| --- | --- | --- | --- | --- | --- | --- |';
  const rows = SOUND_CATEGORIES.map((category) => {
    const limits = CATEGORY_LIMITS[category];
    return `| \`${category}\` | ${limits.minDurationMs}–${limits.maxDurationMs} | ${limits.maxLayerDecayMs} | ${limits.maxFreqRampMs} | ${limits.maxLayers} | ${limits.requiresLoop ? 'required' : '—'} | ${limits.doc} |`;
  });
  return [head, ...rows].join('\n');
}

/** Few-shot examples, as complete recipes. */
function examples(recipes: readonly Recipe[]): string {
  if (recipes.length === 0) {
    return 'The bank is empty. Run the seeder (`pnpm --filter @txt2sfx/server seed`) to load the reference recipes.';
  }
  return recipes
    .map((recipe) => {
      /* A recipe posted over HTTP need not end in a newline, and gluing the closing
         fence to the last layer would break the code block for every reader. */
      const body = recipe.soundline.endsWith('\n') ? recipe.soundline : `${recipe.soundline}\n`;
      return `**${recipe.name}** — asked for as *"${recipe.prompt}"*\n\n\`\`\`\n${body}\`\`\``;
    })
    .join('\n\n');
}

/**
 * Build the document.
 *
 * @param recipes - Few-shot examples to include, best first. Three is enough to
 *   establish the shape and cheap enough to send in every prompt; more crowds out
 *   the task itself. **Filter these before passing them in** — an example that
 *   the validator rejects teaches the model to write a recipe this same pipeline
 *   will refuse. `selectFewShot` is that filter.
 */
export function llmsText(recipes: readonly Recipe[]): string {
  return `# txt2sfx — soundline for language models

You are writing \`soundline\`: a text description of a sound effect that compiles to
a compact procedural Web Audio function. You do **not** write JavaScript, and you do
not produce audio. You write soundline, and the toolchain renders, measures and
optimizes it.

Two rules that save the most iterations:

1. **Never repair generated JavaScript.** If a sound is wrong, the soundline is
   wrong. Fix the soundline; the JavaScript is regenerated from it.
2. **Write \`~value[min..max]\` for every number you are unsure about.** A tilde
   marks a value a numerical optimizer will fit against the target sound. Guessing
   precisely is not your job; getting the structure right is.

## Grammar

\`\`\`
sound "<name>" <duration> [<category>] [loop]
  <layer>: <primitive> <args> [>> <effect> <args>]... | <envelope>
  <layer>: ...
\`\`\`

- The header name is how the sound is filed: it becomes the catalog entry and the file
  name, and nothing downstream renames it. Write **two to four English words naming the
  event and its material** — \`ui click\`, \`stone splash\`, \`rusty gate\`, \`coin\` —
  whatever the language of the request. Not a sentence, not the request translated word
  for word, not a description of how it was made.
- Layers are indented by exactly two spaces and named; the name appears in error
  messages and in every diff, so name it after its job (\`body\`, \`snap\`, \`tail\`).
- \`>>\` chains effects. \`|\` starts the amplitude envelope.
- **Signal order is \`source → envelope → chain\`**: the envelope shapes the source,
  and effects run after it, so \`delay\` and \`verb\` tails outlive the decay and
  count against the header's duration.
- Every number carries a unit except dimensionless ratios: \`Hz\`, \`kHz\`, \`ms\`,
  \`s\`, \`dB\`. \`480Hz\`, \`1.2kHz\`, \`35ms\`, \`-6dB\`, \`Q6\`.
- A slot is \`~<value>[<min>..<max>]\`. The bounds are read in the unit of the value,
  so write them bare: \`~500ms[200..1500]\`, \`~3.2kHz[1.5..6]\`. Repeating a unit of
  the same kind is accepted and converted; mixing kinds is an error.
- A trajectory is \`<value> -> <target> in <time>\`, exponential by default,
  \`-> lin <target> in <time>\` for linear. Chain segments for multi-stage sweeps.
- \`#\` starts a comment. Comments survive every transformation — use them to record
  *why* a number is what it is.

## Sources

| syntax | what it is |
| --- | --- |
${Object.values(PRIMITIVES).map(signatureRow).join('\n')}

| parameter | unit | range | default | notes |
| --- | --- | --- | --- | --- |
${Object.values(PRIMITIVES).map(paramRows).join('\n')}

## Effects

| syntax | what it is |
| --- | --- |
${Object.values(EFFECTS).map(signatureRow).join('\n')}

| parameter | unit | range | default | notes |
| --- | --- | --- | --- | --- |
${Object.values(EFFECTS).map(paramRows).join('\n')}

## Envelope

Written after \`|\`. ${ENVELOPE.doc}

| parameter | unit | range | default | notes |
| --- | --- | --- | --- | --- |
${paramRows(ENVELOPE)}

## Categories and their physical limits

The category is not a label, it is a contract. A validator enforces this table and
rejects a soundline that breaks it, so pick the category that matches the event and
then stay inside its numbers.

${categoryTable()}

Also enforced, for every category:

- peak amplitude of the render ≤ ${GLOBAL_LIMITS.maxPeak} — checked on the render, not on the text;
- at most ${GLOBAL_LIMITS.maxLayers} layers;
- the sound must not outlive the duration in its header, tails included;
- an \`attack\` longer than the source it shapes is an error — a \`click 0.5ms\` under
  the default \`attack 1ms\` renders about 40 dB below its gain and is inaudible.
  Write \`attack 0ms\` on clicks;
- an exponential ramp cannot reach zero; write the floor you mean.

## What procedural synthesis is good at

Impacts, clicks, zaps, UI feedback, sci-fi, mechanical textures. It is **weak** at
organic sound: voice, believable animals, complex real-world recordings. If the
request is for a human voice or a realistic animal, say so rather than producing
something that will disappoint.

## Examples from the bank

${examples(recipes)}

## API

- \`GET /api/health\` — liveness and how many recipes the bank holds.
- \`GET /api/retrieve?prompt=<text>&k=3\` — closest recipes, for few-shot. Check
  \`fallback\`: when true, nothing matched and these are only shape examples. These
  are matches, not endorsements: the bank stores what it was given, so a retrieved
  recipe may break one of the invariants above. Copy structure from them and trust
  the tables in this document over any example. (The examples embedded below are
  already filtered to recipes that validate.)
- \`GET /api/recipes?q=<text>&category=<category>&limit=20\` — search.
- \`GET /api/recipes/:id\` — one recipe.
- \`POST /api/recipes\` — store a solved sound. The soundline is **validated before
  it is written**; on rejection the response lists every issue with a \`hint\`
  phrased as an instruction. Body: \`{ name, prompt, soundline, profile, tags }\`.
  Category and duration are read from the soundline itself, never from the body.
- \`POST /api/recipes/:id/vote\` — \`{ "delta": 1 }\` or \`{ "delta": -1 }\`.

Everything is CORS-open and needs no key. This document is generated from the same
tables the parser and the validator use, so it cannot drift from what they accept.
`;
}
