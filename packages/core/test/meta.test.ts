/**
 * `recipeMeta` — the convention that lets a `presets/` file say what it answers.
 *
 * The cases worth pinning are the ones where a convention quietly goes wrong: a
 * marker that is really prose, a marker on a layer instead of the document, and a
 * recipe with no markers at all — which is every file in `examples/` and must read
 * as "unmarked", never as an empty-string prompt that looks like an answer.
 */

import { describe, expect, it } from 'vitest';
import { parse, recipeMeta, serialize } from '../src/index.js';
import { loadExamples } from './helpers/audio.js';

const withLeading = (lines: readonly string[]): string =>
  `${lines.map((line) => `#${line}`).join('\n')}\nsound "x" 100ms ui\n  a: tone sine 800Hz | gain 0.5 decay 60ms\n`;

describe('recipeMeta', () => {
  it('reads the prompt and the tags a preset declares', () => {
    const meta = recipeMeta(parse(withLeading([' prompt: soft menu hover tick', ' tags: ui, hover, menu, tick'])));
    expect(meta.prompt).toBe('soft menu hover tick');
    expect(meta.tags).toEqual(['ui', 'hover', 'menu', 'tick']);
  });

  it('reports an unmarked recipe as unmarked rather than as an empty answer', () => {
    for (const example of loadExamples()) {
      const meta = recipeMeta(example.ast);
      expect(meta.prompt, example.name).toBeNull();
      expect(meta.tags, example.name).toEqual([]);
    }
  });

  /* The marker is anchored so that prose about a prompt is not read as one. A
     comment is where the reason for a number lives, and most of that prose is
     free-form English. */
  it('ignores a mention of the word in the middle of a sentence', () => {
    const meta = recipeMeta(parse(withLeading([' the prompt: asked for something wetter'])));
    expect(meta.prompt).toBeNull();
  });

  it('takes the markers from the document, not from a layer comment', () => {
    const ast = parse(
      'sound "x" 100ms ui\n  # prompt: not the document\n  a: tone sine 800Hz | gain 0.5 decay 60ms\n',
    );
    expect(recipeMeta(ast).prompt).toBeNull();
  });

  it('keeps the first of a duplicated marker, so editing from the top is stable', () => {
    const meta = recipeMeta(parse(withLeading([' prompt: first', ' prompt: second', ' tags: a, b'])));
    expect(meta.prompt).toBe('first');
  });

  it('drops empty entries in the tag list instead of storing blanks', () => {
    expect(recipeMeta(parse(withLeading([' tags: a,, b , '])))).toMatchObject({ tags: ['a', 'b'] });
  });

  /* The whole reason the markers are comments: they survive the round-trip that
     everything else in the toolchain is built on. */
  it('survives a serialize round-trip', () => {
    const source = withLeading([' prompt: a short bright ping', ' tags: ping, ui']);
    expect(serialize(parse(source))).toBe(source);
    expect(recipeMeta(parse(serialize(parse(source)))).prompt).toBe('a short bright ping');
  });
});
