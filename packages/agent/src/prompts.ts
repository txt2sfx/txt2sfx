/**
 * What we say to the model, and how we read what comes back.
 *
 * Three principles behind every string in this file:
 *
 * 1. **The grammar is not written here.** The system prompt embeds the generated
 *    contract document ({@link llmsText}), so a new primitive appears in the prompt
 *    the moment it appears in the signature table. Prose duplicating the grammar is
 *    prose that will be wrong.
 * 2. **Repair messages are the toolchain's own words.** `formatIssues` and
 *    `humanReadableDiff` already phrase their output as instructions to a model;
 *    this file frames them and adds nothing. Re-describing a validator error in
 *    friendlier language loses the rule id the model needs to reason across
 *    iterations.
 * 3. **Structure is the model's job, numbers are not.** Every message repeats the
 *    tilde-slot rule, and the one message that asks for a structural change says
 *    explicitly that the numbers have already been fitted as far as they go.
 *
 * @packageDocumentation
 */

import type { SoundProfile, ValidationIssue } from '@txt2sfx/shared';
import { formatIssues } from '@txt2sfx/core';
import { diffMarkdown, profileMarkdown } from '@txt2sfx/analyzer';
import { llmsText } from './contract.js';
import type { FewShotExample } from './fewshot.js';

/**
 * The reply format, stated once and repeated in every repair message.
 *
 * "Exactly one fenced block and nothing else" is not tidiness: the extractor takes
 * the last block that looks like a recipe, so a reply that shows a draft, then an
 * explanation, then the real answer is read correctly only by luck. Being explicit
 * costs a sentence and removes the guessing.
 */
const REPLY_RULES = `## How to reply

- Reply with **exactly one fenced code block** containing the complete soundline
  document, and nothing else: no prose before or after it, no JavaScript, no JSON.
- The first line inside the block is the \`sound "<name>" <duration> <category>\`
  header. Layers follow, indented by two spaces.
- Mark every number you are not sure of as \`~value[min..max]\`. A numerical
  optimizer fits those against the target; precision is not your job.
- If the request is for something procedural synthesis cannot do — a human voice, a
  believable animal, a real-world recording — reply with one sentence saying so
  instead of a code block. A disappointing sound is worse than a clear no.`;

/** Note on examples that the validator would reject, when there is nothing better. */
function flawedExampleWarning(examples: readonly FewShotExample[]): string {
  const flawed = examples.filter((example) => example.breaks.length > 0);
  if (flawed.length === 0) return '';
  const lines = flawed.map(
    (example) => `- **${example.recipe.name}** breaks ${example.breaks.join(', ')}`,
  );
  return `

### Careful with the examples above

The bank had nothing that passes validation to show you, so these are the closest it
has, and they break rules this pipeline enforces:

${lines.join('\n')}

Copy their **structure** — layers, primitives, effect chains — and not the numbers
that put them out of contract. Your recipe will be validated by the rules in the
table above, not by these examples.`;
}

/** Options of {@link systemPrompt}. */
export interface SystemPromptOptions {
  /** Examples to show, from `selectFewShot`. */
  readonly examples?: readonly FewShotExample[];
  /**
   * Replace the generated contract document entirely.
   *
   * For a caller that fetched `GET /api/llms.txt` from a bank running a different
   * version of the grammar than the one it imports — the remote document then
   * describes what that bank will actually accept.
   */
  readonly contract?: string;
}

/** The system prompt: the contract document, the examples, and the reply rules. */
export function systemPrompt(options: SystemPromptOptions = {}): string {
  const examples = options.examples ?? [];
  const contract =
    options.contract ?? llmsText(examples.map((example) => example.recipe));
  return `${contract}
${flawedExampleWarning(examples)}

${REPLY_RULES}
`;
}

/** Options of {@link initialMessage}. */
export interface InitialMessageOptions {
  /**
   * Measurements of the sound being matched, when there is a reference.
   *
   * Worth the tokens: a model told "duration 42 ms, dominant partial 836 Hz,
   * flatness 0.001" writes a two-layer tonal transient, while the same model told
   * only "bubble pop" writes whatever a bubble pop means to it. The optimizer can
   * fit numbers inside a structure but cannot turn a noise layer into a tone.
   */
  readonly target?: SoundProfile;
}

/** The first user turn. */
export function initialMessage(prompt: string, options: InitialMessageOptions = {}): string {
  const target =
    options.target === undefined
      ? ''
      : `

The sound to match has been measured. Design the structure so these come out right:

${profileMarkdown('target', options.target)}`;

  return `Write a soundline recipe for this request:

<request>
${prompt.trim()}
</request>${target}
`;
}

/** Why an attempt was sent back. */
export type Failure =
  | { readonly kind: 'no-soundline' }
  | { readonly kind: 'parse-error'; readonly detail: string }
  | { readonly kind: 'invalid'; readonly issues: readonly ValidationIssue[] }
  | { readonly kind: 'render'; readonly issues: readonly ValidationIssue[] }
  | {
      readonly kind: 'stalled';
      readonly distance: number;
      readonly targetDistance: number;
      readonly directives: readonly string[];
    };

/**
 * The next user turn after a rejected attempt.
 *
 * One failure per message. A model handed a parse error and six validator issues
 * fixes the parse error and rewrites something unrelated; the pipeline can only
 * report the issues it could reach anyway — an unparseable document has no
 * invariants to check.
 */
export function repairMessage(failure: Failure): string {
  switch (failure.kind) {
    case 'no-soundline':
      return `Your reply contained no soundline. Reply with exactly one fenced code block whose first line is the \`sound "<name>" <duration> <category>\` header, and nothing else.
`;

    case 'parse-error':
      return `That soundline does not parse:

${failure.detail}

Fix that line and send the whole document again, in one fenced block. Line and column
are 1-based and refer to the block you just sent.
`;

    case 'invalid':
      return `That soundline parses, but it breaks physical invariants this project
enforces. Each line below names the rule, what you wrote, what is required, and the
fix:

${formatIssues(failure.issues)}

Send the corrected document in one fenced block. Change the recipe, not the category:
the category is the contract you chose to be judged against.
`;

    case 'render':
      return `That soundline is valid on paper, but the render says otherwise:

${formatIssues(failure.issues)}

These are measured, not derived — layers do not peak together, and a high-pass can
lift the peak above its input, so the text alone cannot predict them. Adjust the
gains or the envelope and send the whole document again.
`;

    case 'stalled':
      /* This is the one message that asks for a structural change, and the hard
         rule from the plan is why it is the only one: the optimizer has to be
         genuinely stuck first. Otherwise the model rebuilds a topology whose
         numbers were still improving, and the run loses everything the search had
         found so far. */
      return `The numerical optimizer fitted every \`~\` slot in your recipe and stopped
improving at a distance of ${failure.distance.toFixed(3)} — the target is ${failure.targetDistance.toFixed(3)}.
The numbers are as good as this structure allows, so the structure is what has to
change: different layers, different primitives, a different effect chain.

What the render still gets wrong, worst first:

${diffMarkdown(failure.directives)}

Send a new recipe in one fenced block. Keep what the measurements say is right and
rebuild what they say is wrong; mark the numbers you are unsure of as
\`~value[min..max]\` again.
`;
  }
}

/** Fenced code blocks, in source order. */
const FENCE = /```[^\n]*\n([\s\S]*?)```/g;
/** A line that starts a soundline document. */
const HEADER = /^[ \t]*sound[ \t]+"/m;

/** Canonical form: LF endings, no leading blank lines, exactly one trailing newline. */
function normalize(body: string): string {
  const text = body.replace(/\r\n/g, '\n').replace(/^\n+/, '').trimEnd();
  return text === '' ? '' : `${text}\n`;
}

/**
 * Pull the soundline out of a reply.
 *
 * Takes the **last** fenced block that carries a `sound "` header: a model that
 * shows its work writes the draft first and the answer last. Falls back to the text
 * from the first header line onwards, because a reply with the recipe but no fence
 * is a formatting mistake, not a failed attempt, and spending an iteration on it
 * would be waste.
 *
 * A fenced block *without* a header is deliberately not a candidate. The tempting
 * "well, take the last block then" rule reads a JavaScript snippet as a recipe and
 * turns a clean "you sent no soundline" into a parse error about someone's
 * `play(ctx, 0)` — one wasted iteration, and a confusing message in the transcript.
 *
 * @returns The document with a trailing newline, or `undefined` when the reply
 *   contains nothing that looks like a recipe (which is the answer when the model
 *   correctly refuses a request for a human voice).
 */
export function extractSoundline(reply: string): string | undefined {
  const blocks: string[] = [];
  for (const match of reply.matchAll(FENCE)) {
    const body = match[1];
    if (body !== undefined) blocks.push(body);
  }

  const chosen = blocks.filter((block) => HEADER.test(block)).at(-1);
  if (chosen !== undefined) {
    const normalized = normalize(chosen);
    if (normalized !== '') return normalized;
  }

  const match = HEADER.exec(reply);
  if (match !== null) {
    const normalized = normalize(reply.slice(match.index));
    if (normalized !== '') return normalized;
  }

  return undefined;
}
