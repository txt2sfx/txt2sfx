import { describe, expect, it } from 'vitest';
import type { SoundlineError } from '../src/index.js';
import { parse, parseWithDiagnostics } from '../src/index.js';

/** First diagnostic of a document that is expected to be broken. */
function firstError(source: string): SoundlineError {
  const { errors } = parseWithDiagnostics(source);
  const error = errors[0];
  if (error === undefined) throw new Error(`expected a parse error, got none for:\n${source}`);
  return error;
}

/** A layer line wrapped in a minimal valid header. */
const doc = (...lines: string[]): string => ['sound "s" 100ms ui', ...lines, ''].join('\n');

describe('header errors', () => {
  it('rejects a missing sound keyword', () => {
    const error = firstError('sund "x" 35ms\n');
    expect(error.code).toBe('header.keyword');
    expect(error.message).toMatch(/line 1, col 1: expected the header keyword 'sound'/);
    expect(error.hint).toMatch(/did you mean 'sound'/);
  });

  it('rejects an unquoted sound name', () => {
    const error = firstError('sound bubble 35ms\n');
    expect(error.code).toBe('header.name');
    expect(error.message).toMatch(/expected a quoted sound name after 'sound', got 'bubble'/);
  });

  it('rejects a missing duration', () => {
    const error = firstError('sound "x"\n  a: sub 60Hz | gain 1 decay 20ms\n');
    expect(error.code).toBe('value.expected');
    expect(error.message).toMatch(/expected a number for 'duration' of the sound header, got end of line/);
  });

  it('rejects a duration that is not a time', () => {
    const error = firstError('sound "x" 35Hz\n  a: sub 60Hz | gain 1 decay 20ms\n');
    expect(error.code).toBe('unit.wrong');
    expect(error.message).toMatch(/expected unit \(ms\|s\) after number for 'duration'/);
  });

  it('rejects an unknown category and suggests the closest one', () => {
    const error = firstError('sound "x" 35ms popp\n  a: sub 60Hz | gain 1 decay 20ms\n');
    expect(error.code).toBe('header.category');
    expect(error.message).toMatch(/unknown category 'popp'/);
    expect(error.hint).toMatch(/did you mean 'pop'/);
  });

  it('rejects trailing junk in the header', () => {
    const error = firstError('sound "x" 35ms pop loop 5ms\n  a: sub 60Hz | gain 1 decay 20ms\n');
    expect(error.code).toBe('header.trailing');
  });

  it('rejects an empty document', () => {
    expect(firstError('').code).toBe('document.empty');
    expect(firstError('# only a comment\n').code).toBe('document.empty');
  });

  it('rejects a sound with no layers', () => {
    const error = firstError('sound "x" 35ms pop\n');
    expect(error.code).toBe('document.no-layers');
    expect(error.hint).toMatch(/add at least one layer/);
  });
});

describe('layer structure errors', () => {
  it('rejects a missing layer name', () => {
    const error = firstError(doc('  : tone sine 480Hz | gain 1 decay 20ms'));
    expect(error.code).toBe('layer.name');
    expect(error.message).toMatch(/expected a layer name before ':'/);
  });

  it('rejects a missing colon after the layer name', () => {
    const error = firstError(doc('  thud tone sine 480Hz | gain 1 decay 20ms'));
    expect(error.code).toBe('layer.colon');
    expect(error.message).toMatch(/expected ':' after layer name 'thud', got 'tone'/);
  });

  it('rejects an unknown primitive', () => {
    const error = firstError(doc('  thud: boom 480Hz | gain 1 decay 20ms'));
    expect(error.code).toBe('primitive.unknown');
    expect(error.message).toMatch(/expected one of tone\|noise\|chirp\|pluck\|modal\|plate\|fm\|sub\|click/);
  });

  it('rejects an unknown effect and suggests the closest one', () => {
    const error = firstError(doc('  a: noise white >> lowpass 400Hz | gain 1 decay 20ms'));
    expect(error.code).toBe('effect.unknown');
    expect(error.hint).toMatch(/did you mean 'lp'/);
  });

  it('rejects a layer without an envelope', () => {
    const error = firstError(doc('  a: noise white'));
    expect(error.code).toBe('layer.envelope-missing');
    expect(error.hint).toMatch(/gain 0\.8 decay 30ms/);
  });

  it('rejects tokens after the envelope', () => {
    const error = firstError(doc('  a: noise white | gain 0.5 decay 20ms >> lp 400Hz'));
    expect(error.code).toBe('layer.trailing');
  });

  it('rejects duplicate layer names', () => {
    const error = firstError(doc('  a: sub 60Hz | gain 1 decay 20ms', '  a: sub 80Hz | gain 1 decay 20ms'));
    expect(error.code).toBe('layer.duplicate');
    expect(error.message).toMatch(/duplicate layer name 'a'/);
  });
});

describe('argument errors', () => {
  it('rejects a number without a unit', () => {
    const error = firstError(doc('  thud: tone sine 480 -> 80Hz in 12ms | gain 0.9 decay 30ms'));
    expect(error.code).toBe('unit.missing');
    expect(error.message).toBe(
      "line 2, col 19: expected unit (Hz|kHz) after number for 'freq' of primitive 'tone' (every number in a soundline carries its unit)",
    );
  });

  it('rejects a unit on a dimensionless parameter', () => {
    const error = firstError(doc('  a: noise white >> bp 3000Hz Q6Hz | gain 0.5 decay 20ms'));
    expect(error.code).toBe('unit.unexpected');
    expect(error.message).toMatch(/parameter 'Q' of effect 'bp' is dimensionless/);
  });

  it('rejects an invalid enum value', () => {
    const error = firstError(doc('  a: tone triangle 480Hz | gain 0.5 decay 20ms'));
    expect(error.code).toBe('enum.invalid');
    expect(error.message).toMatch(/expected wave \(sine\|tri\|saw\|square\) in primitive 'tone'/);
  });

  it('rejects an unknown envelope parameter and suggests the closest one', () => {
    const error = firstError(doc('  a: sub 60Hz | gain 0.5 decy 20ms'));
    expect(error.code).toBe('arg.unknown');
    expect(error.message).toMatch(/unknown parameter 'decy' for the envelope/);
    expect(error.hint).toMatch(/did you mean 'decay'/);
  });

  it('rejects an envelope without a decay', () => {
    const error = firstError(doc('  a: sub 60Hz | gain 0.5'));
    expect(error.code).toBe('arg.required');
    expect(error.message).toMatch(/the envelope requires parameter 'decay'/);
  });

  it('rejects an effect that is missing a required parameter', () => {
    const error = firstError(doc('  a: noise white >> dist mix 0.5 | gain 0.5 decay 20ms'));
    expect(error.code).toBe('arg.required');
    expect(error.message).toMatch(/effect 'dist' requires parameter 'drive'/);
  });

  it('rejects a duplicated parameter', () => {
    const error = firstError(doc('  a: sub 60Hz | gain 0.5 decay 20ms decay 30ms'));
    expect(error.code).toBe('arg.duplicate');
  });

  it('rejects a missing positional argument', () => {
    const error = firstError(doc('  a: tone sine | gain 0.5 decay 20ms'));
    expect(error.code).toBe('arg.missing');
    expect(error.message).toMatch(/primitive 'tone' needs 'freq' \(Hz\|kHz\)/);
  });
});

describe('ramp and slot errors', () => {
  it('rejects a ramp without a duration', () => {
    const error = firstError(doc('  a: tone sine 480Hz -> 80Hz 12ms | gain 0.5 decay 20ms'));
    expect(error.code).toBe('ramp.in-missing');
    expect(error.hint).toMatch(/-> 80Hz in 12ms/);
  });

  it('rejects a ramp on a parameter that cannot move', () => {
    const error = firstError(doc('  a: noise white >> delay 90ms -> 200ms in 50ms | gain 0.5 decay 20ms'));
    expect(error.code).toBe('ramp.unsupported');
    expect(error.message).toMatch(/parameter 'time' of effect 'delay' cannot ramp/);
  });

  it('rejects a slot without a range', () => {
    const error = firstError(doc('  a: noise white >> bp ~3200Hz | gain 0.5 decay 20ms'));
    expect(error.code).toBe('slot.range-missing');
    expect(error.hint).toMatch(/~3200Hz\[500\.\.8000\]/);
  });

  it('rejects a range that is not attached to a slot', () => {
    const error = firstError(doc('  a: noise white >> bp [500..8000] | gain 0.5 decay 20ms'));
    expect(error.code).toBe('slot.no-tilde');
  });

  it('rejects a decreasing slot range', () => {
    const error = firstError(doc('  a: noise white >> bp ~3200Hz[8000..500] | gain 0.5 decay 20ms'));
    expect(error.code).toBe('slot.range-order');
    expect(error.message).toMatch(/slot range must increase, got \[8000\.\.500\]/);
  });

  it('rejects a start value outside its slot range', () => {
    const error = firstError(doc('  a: noise white >> bp ~9000Hz[500..8000] | gain 0.5 decay 20ms'));
    expect(error.code).toBe('slot.start-outside');
  });

  it('rejects slot bounds in another unit', () => {
    const error = firstError(doc('  a: noise white >> bp ~3200Hz[500ms..8000] | gain 0.5 decay 20ms'));
    expect(error.code).toBe('slot.unit-mismatch');
  });
});

describe('diagnostics', () => {
  it('reports one error per broken line and keeps the good layers', () => {
    const { ast, errors } = parseWithDiagnostics(
      doc(
        '  good: sub 60Hz | gain 0.5 decay 20ms',
        '  bad1: tone sine 480 | gain 0.5 decay 20ms',
        '  bad2: noise green | gain 0.5 decay 20ms',
        '  good2: click 2ms | gain 0.5 decay 20ms',
      ),
    );
    expect(errors.map((e) => e.line)).toEqual([3, 4]);
    expect(ast?.layers.map((l) => l.name)).toEqual(['good', 'good2']);
  });

  it('every message carries a line and a column', () => {
    const { errors } = parseWithDiagnostics(doc('  a: tone 480Hz | gain 0.5 decy 20ms', '  b: boom 1Hz'));
    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error.message).toMatch(/^line \d+, col \d+: /);
      expect(error.loc.length).toBeGreaterThan(0);
    }
  });

  it('renders a caret under the offending span', () => {
    const source = doc('  thud: tone sine 480 -> 80Hz in 12ms | gain 0.9 decay 30ms');
    const error = firstError(source);
    expect(error.format(source)).toContain('\n                  ^^^');
  });

  it('throws the first error from the strict parse entry point', () => {
    expect(() => parse('sound "x" 35ms\n  a: sub 60Hz\n')).toThrowError(/line 2, col 14: layer 'a' has no envelope/);
  });
});
