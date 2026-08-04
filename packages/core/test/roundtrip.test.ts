import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SoundAST } from '@txt2sfx/shared';
import { parse, parseWithDiagnostics, serialize } from '../src/index.js';

const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples', import.meta.url));

const exampleFiles = readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith('.soundline'))
  .sort();

/** Git on Windows may hand us CRLF; the canonical form is always LF. */
const read = (file: string): string =>
  readFileSync(join(EXAMPLES_DIR, file), 'utf8').replace(/\r\n/g, '\n');

/** Structural comparison ignoring source positions. */
const stripLoc = (ast: SoundAST): unknown =>
  JSON.parse(JSON.stringify(ast, (key, value: unknown) => (key === 'loc' ? undefined : value)));

describe('examples', () => {
  it('ships the ten reference recipes', () => {
    expect(exampleFiles).toHaveLength(10);
  });

  for (const file of exampleFiles) {
    describe(file, () => {
      const source = read(file);

      it('parses without diagnostics', () => {
        const { ast, errors } = parseWithDiagnostics(source);
        expect(errors.map((e) => e.message)).toEqual([]);
        expect(ast).not.toBeNull();
      });

      it('is already in canonical form (parse -> serialize is byte-identical)', () => {
        expect(serialize(parse(source))).toBe(source);
      });

      it('round-trips structurally (parse -> serialize -> parse)', () => {
        const first = parse(source);
        const second = parse(serialize(first));
        expect(stripLoc(second)).toEqual(stripLoc(first));
      });
    });
  }
});

describe('canonicalization', () => {
  it('normalizes indentation, spacing and blank lines', () => {
    const messy = [
      'sound   "pop"    35ms   pop',
      '',
      '      thud:tone   sine   480Hz->80Hz in 12ms|decay 30ms gain 0.9',
      '',
    ].join('\n');
    expect(serialize(parse(messy))).toBe(
      'sound "pop" 35ms pop\n  thud: tone sine 480Hz -> 80Hz in 12ms | gain 0.9 decay 30ms\n',
    );
  });

  it('drops the implicit misc category and keeps the loop flag', () => {
    const src = 'sound "hum" 1s misc loop\n  h: tone sine 120Hz | gain 0.4 decay 900ms\n';
    expect(serialize(parse(src))).toBe(
      'sound "hum" 1s loop\n  h: tone sine 120Hz | gain 0.4 decay 900ms\n',
    );
  });

  it('preserves comments, including layer-level ones', () => {
    const src = [
      '# file note',
      'sound "pop" 35ms pop # header note',
      '  # layer note',
      '  thud: tone sine 480Hz | gain 0.9 decay 30ms # tail note',
      '',
    ].join('\n');
    expect(serialize(parse(src))).toBe(src);
  });

  it('keeps units as written and does not convert them', () => {
    const src = 'sound "hum" 1.5s cycle loop\n  h: tone sine 1.2kHz | gain 0.4 decay 1s\n';
    const ast = parse(src);
    expect(ast.duration).toMatchObject({ value: 1.5, unit: 's' });
    expect(serialize(ast)).toBe(src);
  });

  it('escapes quotes in the sound name', () => {
    const src = 'sound "the \\"big\\" one" 300ms impact\n  h: sub 60Hz | gain 0.8 decay 250ms\n';
    expect(parse(src).name).toBe('the "big" one');
    expect(serialize(parse(src))).toBe(src);
  });
});

describe('slots', () => {
  it('records the optimizer range on the literal', () => {
    const ast = parse('sound "s" 40ms pop\n  a: noise white >> bp ~3200Hz[500..8000] Q6 | gain 0.7 decay 18ms\n');
    const bp = ast.layers[0]?.chain[0];
    expect(bp?.name).toBe('bp');
    const freq = bp?.args['freq'];
    expect(freq?.kind).toBe('number');
    if (freq?.kind !== 'number') throw new Error('expected a number argument');
    expect(freq.head.slot).toEqual({ min: 500, max: 8000 });
    expect(freq.head.value).toBe(3200);
  });

  it('accepts a slot on a ramp target', () => {
    const src = 'sound "s" 180ms laser\n  a: chirp saw 1800Hz -> ~300Hz[120..900] in 120ms | gain 0.6 decay 150ms\n';
    expect(serialize(parse(src))).toBe(src);
  });
});
