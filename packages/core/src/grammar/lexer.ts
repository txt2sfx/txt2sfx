/**
 * soundline tokenizer.
 *
 * The language is line-oriented and tiny, so the lexer is a single pass with no
 * lookahead beyond one character. Two rules deserve attention:
 *
 * - **Units are part of the number token.** `480Hz` is one token, `480 Hz` is
 *   not valid. That is deliberate: it makes "every number carries a unit" a
 *   lexical property rather than a convention the model can forget.
 * - **Glued dimensionless parameters.** `Q6` is emitted as `ident(Q)` followed
 *   by `number(6)`. The split only happens for the closed set of dimensionless
 *   parameter names taken from the signature table, so a layer named `snap2`
 *   remains a single identifier.
 *
 * @packageDocumentation
 */

import type { Loc, Unit } from '@txt2sfx/shared';
import { UNITS } from '@txt2sfx/shared';
import { SoundlineError, didYouMean } from './errors.js';
import { GLUED_PARAM_NAMES } from './signatures.js';

/** Token categories produced by {@link tokenize}. */
export type TokenType =
  | 'ident'
  | 'number'
  | 'string'
  | 'colon'
  | 'pipe'
  | 'arrow'
  | 'chain'
  | 'tilde'
  | 'lbracket'
  | 'rbracket'
  | 'dotdot'
  | 'comment'
  | 'newline'
  | 'eof';

/** A lexical token with its exact source span. */
export interface Token {
  readonly type: TokenType;
  /**
   * Token text. For `string` tokens this is the decoded content without the
   * surrounding quotes; for `comment` tokens the raw text after `#`, kept
   * verbatim so comments survive a round-trip; otherwise the raw source text.
   */
  readonly text: string;
  /** Numeric value, present on `number` tokens only. */
  readonly value?: number;
  /** Unit suffix, present on `number` tokens only (`''` when dimensionless). */
  readonly unit?: Unit;
  readonly loc: Loc;
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isAlpha = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
const isIdentChar = (c: string | undefined): boolean => isAlpha(c) || isDigit(c);

/**
 * Turn soundline source into a token stream ending with a single `eof` token.
 *
 * Newlines are significant (the grammar is line-oriented) and are emitted as
 * `newline` tokens; other whitespace and indentation are skipped.
 *
 * @throws {SoundlineError} on an unknown character, an unterminated string or
 * an unrecognised unit suffix.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const locAt = (offset: number, length: number): Loc => ({
    line,
    column: offset - lineStart + 1,
    offset,
    length,
  });

  const push = (type: TokenType, text: string, start: number, length: number): void => {
    tokens.push({ type, text, loc: locAt(start, length) });
  };

  while (i < source.length) {
    const start = i;
    const ch = source[i] as string;

    // --- whitespace and line breaks ---------------------------------------
    if (ch === '\n') {
      push('newline', '\n', start, 1);
      i += 1;
      line += 1;
      lineStart = i;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }

    // --- comments ----------------------------------------------------------
    if (ch === '#') {
      i += 1;
      const textStart = i;
      while (i < source.length && source[i] !== '\n') i += 1;
      push('comment', source.slice(textStart, i), start, i - start);
      continue;
    }

    // --- quoted sound name --------------------------------------------------
    if (ch === '"') {
      i += 1;
      let text = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i] as string;
        if (c === '\\' && i + 1 < source.length) {
          text += source[i + 1] as string;
          i += 2;
          continue;
        }
        if (c === '"') {
          i += 1;
          closed = true;
          break;
        }
        if (c === '\n') break;
        text += c;
        i += 1;
      }
      if (!closed) {
        throw new SoundlineError({
          code: 'string.unterminated',
          detail: 'unterminated quoted name — the closing double quote is missing',
          loc: locAt(start, Math.max(1, i - start)),
          hint: 'write the sound name as a single quoted string, e.g. sound "bubble pop" 35ms',
        });
      }
      push('string', text, start, i - start);
      continue;
    }

    // --- two-character operators -------------------------------------------
    if (ch === '-' && source[i + 1] === '>') {
      push('arrow', '->', start, 2);
      i += 2;
      continue;
    }
    if (ch === '>' && source[i + 1] === '>') {
      push('chain', '>>', start, 2);
      i += 2;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.') {
      push('dotdot', '..', start, 2);
      i += 2;
      continue;
    }

    // --- numbers ------------------------------------------------------------
    const signed = (ch === '-' || ch === '+') && (isDigit(source[i + 1]) || source[i + 1] === '.');
    if (isDigit(ch) || signed || (ch === '.' && isDigit(source[i + 1]))) {
      if (signed) i += 1;
      while (isDigit(source[i])) i += 1;
      // A dot only belongs to the number when a digit follows it, so the range
      // syntax `500..8000` lexes as number, dotdot, number.
      if (source[i] === '.' && isDigit(source[i + 1])) {
        i += 1;
        while (isDigit(source[i])) i += 1;
      }
      const numberText = source.slice(start, i);
      const value = Number.parseFloat(numberText);

      let unit: Unit = '';
      if (isAlpha(source[i])) {
        const unitStart = i;
        while (isAlpha(source[i])) i += 1;
        const raw = source.slice(unitStart, i);
        if (!(UNITS as readonly string[]).includes(raw)) {
          const guess = didYouMean(raw, UNITS);
          throw new SoundlineError({
            code: 'unit.unknown',
            detail: `unknown unit '${raw}' after number — expected one of Hz|kHz|ms|s|dB`,
            loc: locAt(unitStart, raw.length),
            ...(guess === undefined ? {} : { hint: `did you mean '${guess}'? units are case-sensitive` }),
          });
        }
        unit = raw as Unit;
      }

      tokens.push({
        type: 'number',
        text: source.slice(start, i),
        value,
        unit,
        loc: locAt(start, i - start),
      });
      continue;
    }

    // --- identifiers (with the glued-parameter split) ------------------------
    if (isAlpha(ch)) {
      while (isIdentChar(source[i])) i += 1;
      let text = source.slice(start, i);
      const glued = /^([A-Za-z]+)[0-9]/.exec(text);
      if (glued !== null && GLUED_PARAM_NAMES.has(glued[1] as string)) {
        text = glued[1] as string;
        i = start + text.length;
      }
      push('ident', text, start, text.length);
      continue;
    }

    // --- single-character punctuation ---------------------------------------
    const single: Partial<Record<string, TokenType>> = {
      ':': 'colon',
      '|': 'pipe',
      '~': 'tilde',
      '[': 'lbracket',
      ']': 'rbracket',
    };
    const type = single[ch];
    if (type !== undefined) {
      push(type, ch, start, 1);
      i += 1;
      continue;
    }

    throw new SoundlineError({
      code: 'char.unexpected',
      detail: `unexpected character '${ch}'`,
      loc: locAt(start, 1),
      hint: 'the soundline grammar uses only : | ~ [ ] .. -> >> # and quoted names',
    });
  }

  tokens.push({ type: 'eof', text: '', loc: locAt(i, 0) });
  return tokens;
}

/** Numeric value of a `number` token. */
export function tokenNumber(token: Token): number {
  if (token.type !== 'number' || token.value === undefined) {
    throw new TypeError(`token '${token.text}' is not a number`);
  }
  return token.value;
}

/** Human-readable description of a token, used in "unexpected ..." messages. */
export function describeToken(token: Token): string {
  switch (token.type) {
    case 'eof':
      return 'end of input';
    case 'newline':
      return 'end of line';
    case 'string':
      return `quoted name "${token.text}"`;
    case 'comment':
      return 'comment';
    default:
      return `'${token.text}'`;
  }
}
