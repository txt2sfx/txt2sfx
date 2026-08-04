import { describe, expect, it } from 'vitest';
import { SoundlineError, tokenize } from '../src/index.js';

const types = (src: string): string[] => tokenize(src).map((t) => t.type);
const texts = (src: string): string[] => tokenize(src).map((t) => t.text);

describe('lexer', () => {
  it('keeps the unit inside the number token', () => {
    const [num] = tokenize('480Hz');
    expect(num).toMatchObject({ type: 'number', value: 480, unit: 'Hz' });
  });

  it('accepts every unit', () => {
    expect(tokenize('1Hz 2kHz 3ms 4s -6dB 0.5').map((t) => t.unit)).toEqual([
      'Hz',
      'kHz',
      'ms',
      's',
      'dB',
      '',
      undefined, // eof
    ]);
  });

  it('splits a glued dimensionless parameter', () => {
    expect(texts('Q6')).toEqual(['Q', '6', '']);
    expect(types('Q6')).toEqual(['ident', 'number', 'eof']);
  });

  it('leaves identifiers that merely end in a digit alone', () => {
    expect(texts('snap2:')).toEqual(['snap2', ':', '']);
  });

  it('does not eat the range dots as a decimal point', () => {
    expect(types('~3200Hz[500..8000]')).toEqual([
      'tilde',
      'number',
      'lbracket',
      'number',
      'dotdot',
      'number',
      'rbracket',
      'eof',
    ]);
  });

  it('distinguishes an arrow from a negative number', () => {
    expect(types('-> -6dB')).toEqual(['arrow', 'number', 'eof']);
  });

  it('captures comment text verbatim', () => {
    const [comment] = tokenize('# hello  world');
    expect(comment).toMatchObject({ type: 'comment', text: ' hello  world' });
  });

  it('emits one newline token per line break', () => {
    expect(types('a\nb')).toEqual(['ident', 'newline', 'ident', 'eof']);
  });

  it('tracks line and column for every token', () => {
    const tokens = tokenize('sound "x" 35ms\n  thud: tone sine 480Hz');
    const tone = tokens.find((t) => t.text === 'tone');
    expect(tone?.loc).toMatchObject({ line: 2, column: 9 });
  });

  it('rejects an unknown unit with a case hint', () => {
    expect(() => tokenize('480khz')).toThrowError(/unknown unit 'khz'.*did you mean 'kHz'/s);
  });

  it('rejects an unterminated quoted name', () => {
    try {
      tokenize('sound "bubble pop 35ms');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SoundlineError);
      expect((error as SoundlineError).code).toBe('string.unterminated');
    }
  });

  it('rejects characters outside the grammar', () => {
    expect(() => tokenize('a & b')).toThrowError(/unexpected character '&'/);
  });
});
