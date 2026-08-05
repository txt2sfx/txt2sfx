/**
 * Reading a soundline out of a model's reply.
 *
 * Every case here was observed in practice or is one iteration of the loop away
 * from being observed: models add prose, label the fence, show a draft before the
 * answer, forget the fence entirely, or correctly refuse. Extraction that guesses
 * wrong costs a whole iteration, so each of these is pinned.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@txt2sfx/core';
import { extractSoundline } from '../src/index.js';

const RECIPE = 'sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n';

describe('extractSoundline', () => {
  it('takes the block out of a reply wrapped in prose', () => {
    const reply = `Here is a short UI click:\n\n\`\`\`\n${RECIPE}\`\`\`\n\nIt is two layers.`;
    expect(extractSoundline(reply)).toBe(RECIPE);
  });

  it('ignores a language tag on the fence', () => {
    expect(extractSoundline(`\`\`\`soundline\n${RECIPE}\`\`\``)).toBe(RECIPE);
  });

  /* A model that shows its work writes the draft first and the answer last. */
  it('prefers the last block that looks like a recipe', () => {
    const draft = 'sound "draft" 45ms ui\n  body: tone sine 900Hz | gain 0.6 decay 25ms\n';
    const reply = `First attempt:\n\n\`\`\`\n${draft}\`\`\`\n\nThat is too dull. Better:\n\n\`\`\`\n${RECIPE}\`\`\``;
    expect(extractSoundline(reply)).toBe(RECIPE);
  });

  /* A JS snippet has no `sound "` header, so it must not win over the recipe. */
  it('skips fenced blocks that are not soundline', () => {
    const reply = `\`\`\`\n${RECIPE}\`\`\`\n\nAnd to use it:\n\n\`\`\`js\nplay(ctx, 0);\n\`\`\``;
    expect(extractSoundline(reply)).toBe(RECIPE);
  });

  /* A missing fence is a formatting slip, not a failed attempt — repairing it
     would spend an iteration on something we can already read. */
  it('reads an unfenced recipe from its header onwards', () => {
    const reply = `Sure, this should work:\n\n${RECIPE}`;
    expect(extractSoundline(reply)).toBe(RECIPE);
  });

  it('normalizes CRLF and guarantees exactly one trailing newline', () => {
    const crlf = RECIPE.replace(/\n/g, '\r\n');
    const reply = `\`\`\`\n\n${crlf}\n\n\`\`\``;
    const extracted = extractSoundline(reply);
    expect(extracted).toBe(RECIPE);
    /* The point of normalizing: what comes out has to parse. */
    expect(() => parse(extracted ?? '')).not.toThrow();
  });

  it('returns undefined for a refusal, which is a valid answer', () => {
    expect(
      extractSoundline(
        'Procedural synthesis cannot make a believable human voice, so I would rather not pretend.',
      ),
    ).toBeUndefined();
  });

  it('returns undefined for an empty block rather than an empty recipe', () => {
    expect(extractSoundline('```\n\n```')).toBeUndefined();
  });
});
