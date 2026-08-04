/**
 * Syntax colouring and error underlining for the editor overlay.
 *
 * Both jobs are done by painting a class onto every character and then merging
 * equal neighbours into spans. That sounds wasteful and is not: a soundline is a
 * few hundred characters, and the alternative — reconciling a token stream with
 * an arbitrary set of possibly-overlapping error ranges — is where this kind of
 * code normally goes wrong.
 *
 * The token stream comes from the real lexer, so the colours can never disagree
 * with the language. When the source does not tokenize at all, everything falls
 * back to plain text and only the error underline remains, which is exactly the
 * state the author needs to see.
 *
 * @packageDocumentation
 */

import type { Loc } from '@txt2sfx/shared';
import { EFFECT_NAMES, PRIMITIVE_NAMES, tokenize } from '@txt2sfx/core';

/** A run of characters that share a class. */
export interface Span {
  readonly text: string;
  /** CSS class name, or the empty string for unstyled text. */
  readonly cls: string;
}

/** Words that are structural rather than named things. */
const KEYWORDS = new Set(['sound', 'loop', 'in', 'lin', 'exp']);

const PRIMITIVES = new Set<string>(PRIMITIVE_NAMES);
const EFFECTS = new Set<string>(EFFECT_NAMES);

/** Class for one token, chosen before any error marking is applied. */
function classOf(type: string, text: string): string {
  switch (type) {
    case 'number':
      return 'tk-num';
    case 'string':
      return 'tk-str';
    case 'comment':
      return 'tk-com';
    case 'ident':
      if (KEYWORDS.has(text)) return 'tk-kw';
      if (PRIMITIVES.has(text)) return 'tk-prim';
      if (EFFECTS.has(text)) return 'tk-fx';
      return 'tk-id';
    case 'colon':
    case 'pipe':
    case 'arrow':
    case 'chain':
    case 'tilde':
    case 'lbracket':
    case 'rbracket':
    case 'dotdot':
      return 'tk-punct';
    default:
      return '';
  }
}

/**
 * Split the source into styled spans.
 *
 * @param errors Spans to underline; zero-length ones are widened to one
 *   character so an error at end-of-input is still visible.
 */
export function highlight(source: string, errors: readonly Loc[]): Span[] {
  const classes = new Array<string>(source.length).fill('');

  try {
    for (const token of tokenize(source)) {
      const cls = classOf(token.type, token.text);
      if (cls === '') continue;
      const end = Math.min(source.length, token.loc.offset + token.loc.length);
      for (let i = token.loc.offset; i < end; i++) classes[i] = cls;
    }
  } catch {
    // Unlexable source: no colours, just the underline below.
  }

  const bad = new Array<boolean>(source.length).fill(false);
  for (const loc of errors) {
    const start = Math.max(0, Math.min(source.length - 1, loc.offset));
    const end = Math.min(source.length, loc.offset + Math.max(1, loc.length));
    for (let i = start; i < end; i++) bad[i] = true;
  }

  const spans: Span[] = [];
  let start = 0;
  const keyAt = (i: number): string => `${classes[i] ?? ''}${bad[i] === true ? ' tk-bad' : ''}`;

  for (let i = 1; i <= source.length; i++) {
    if (i < source.length && keyAt(i) === keyAt(start)) continue;
    spans.push({ text: source.slice(start, i), cls: keyAt(start).trim() });
    start = i;
  }
  return spans;
}
