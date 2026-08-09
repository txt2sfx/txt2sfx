/**
 * The master transforms, held to three promises.
 *
 * 1. **It is still the same document.** Scaling rewrites numbers at their spans,
 *    so comments, layer names, waveform words and every literal of another kind
 *    have to come out untouched — a transform that "helpfully" reformatted would
 *    silently destroy the property the recipe bank stores recipes for.
 * 2. **It still parses, and canonically.** The two hard parse errors a scale can
 *    provoke — `slot.range-order` and `slot.start-outside` — are provoked here on
 *    purpose, on a range narrow enough that `roundLiteral` collapses it.
 * 3. **The numbers actually moved.** Checked by walking the re-parsed AST through
 *    the signature table rather than by matching text, so the assertion cannot
 *    agree with the implementation by sharing its bug.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import type { NumberLiteral, ParamKind, SoundAST } from '@txt2sfx/shared';
import {
  ENVELOPE,
  EFFECTS,
  OPEN_CUTOFF_HZ,
  canonicalValue,
  lookupSignature,
  parse,
  scaleBrightness,
  scaleKind,
  serialize,
} from '../src/index.js';
import { loadExamples } from './helpers/audio.js';

const examples = loadExamples();

/**
 * Every literal of one kind in a document, in source order, in canonical units.
 *
 * Mirrors the transform's own traversal — header duration, sources, chains,
 * envelopes, ramp targets and ramp times — but reads the numbers back out
 * instead of writing them, so a missed branch shows up as a length mismatch.
 */
function literalsOfKind(ast: SoundAST, kind: ParamKind): number[] {
  const out: number[] = [];
  const take = (lit: NumberLiteral, litKind: ParamKind): void => {
    out.push(canonicalValue(lit, litKind));
  };

  const walk = (args: Readonly<Record<string, unknown>>, params: readonly { name: string; kind: ParamKind }[]): void => {
    for (const [name, raw] of Object.entries(args)) {
      const arg = raw as { kind: string; head: NumberLiteral; ramp: readonly { to: NumberLiteral; time: NumberLiteral }[] };
      if (arg.kind !== 'number') continue;
      const spec = params.find((p) => p.name === name);
      if (spec === undefined) continue;
      if (spec.kind === kind) take(arg.head, kind);
      for (const segment of arg.ramp) {
        if (spec.kind === kind) take(segment.to, kind);
        if (kind === 'time') take(segment.time, 'time');
      }
    }
  };

  if (kind === 'time') take(ast.duration, 'time');
  for (const layer of ast.layers) {
    walk(layer.source.args, lookupSignature(layer.source.name)?.params ?? []);
    for (const effect of layer.chain) walk(effect.args, lookupSignature(effect.name)?.params ?? []);
    walk(layer.envelope.args, ENVELOPE.params);
  }
  return out;
}

/** Every own-line and trailing comment, so a transform cannot quietly eat one. */
function comments(ast: SoundAST): string[] {
  return [
    ...ast.leading,
    ...(ast.trailing === undefined ? [] : [ast.trailing]),
    ...ast.layers.flatMap((layer) => [...layer.leading, ...(layer.trailing === undefined ? [] : [layer.trailing])]),
  ];
}

/** Structural skeleton: what a scale is never allowed to change. */
function skeleton(ast: SoundAST): unknown {
  return {
    name: ast.name,
    category: ast.category,
    loop: ast.loop,
    comments: comments(ast),
    layers: ast.layers.map((layer) => ({
      name: layer.name,
      source: layer.source.name,
      chain: layer.chain.map((effect) => effect.name),
    })),
  };
}

describe('scaleKind', () => {
  for (const example of examples) {
    describe(example.name, () => {
      for (const kind of ['freq', 'time'] as const) {
        it(`multiplies every ${kind} literal and leaves the rest alone`, () => {
          const before = parse(example.source);
          const result = scaleKind(example.source, kind, 2);
          const after = parse(result.source);

          const other: ParamKind = kind === 'freq' ? 'time' : 'freq';
          expect(literalsOfKind(after, kind)).toEqual(literalsOfKind(before, kind).map((v) => v * 2));
          expect(literalsOfKind(after, other)).toEqual(literalsOfKind(before, other));
          expect(literalsOfKind(after, 'level')).toEqual(literalsOfKind(before, 'level'));
          expect(literalsOfKind(after, 'ratio')).toEqual(literalsOfKind(before, 'ratio'));
          expect(skeleton(after)).toEqual(skeleton(before));
          expect(result.touched).toBe(literalsOfKind(before, kind).length);
        });

        it(`leaves the result in canonical form (${kind})`, () => {
          const scaled = scaleKind(example.source, kind, 2).source;
          expect(serialize(parse(scaled))).toBe(scaled);
        });

        /* Ratio 1 is not *required* to be a fixed point — rounding is allowed to
           move a number that was never written at writing precision — but the
           reference recipes are, so this pins the behaviour the jog slider's
           "back to centre" rests on. */
        it(`is the identity at ratio 1 on a canonical recipe (${kind})`, () => {
          expect(scaleKind(example.source, kind, 1).source).toBe(example.source);
        });
      }

      it('keeps the result canonical after brightness', () => {
        const scaled = scaleBrightness(example.source, 0.5).source;
        expect(serialize(parse(scaled))).toBe(scaled);
      });
    });
  }

  it('moves a slot range together with its value', () => {
    const src =
      'sound "s" 40ms pop\n  a: noise white >> bp ~3200Hz[500..8000] Q6 | gain 0.7 decay 18ms\n';
    const scaled = scaleKind(src, 'freq', 2).source;
    expect(scaled).toContain('bp ~6400Hz[1000..16000]');
    expect(() => parse(scaled)).not.toThrow();
  });

  it('normalizes a bound written in another unit of the same kind', () => {
    const src = 'sound "s" 900ms foley\n  a: noise white >> verb ~500ms[200ms..1s] mix 0.3 | gain 0.5 decay 20ms\n';
    const scaled = scaleKind(src, 'time', 0.5).source;
    expect(scaled).toContain('verb ~250ms[100..500]');
  });

  it('scales the header duration and the ramp times, but not a ramp target of another kind', () => {
    const src =
      'sound "s" 300ms misc\n  a: fm 1200Hz ratio 3.5 index 6 -> 0.5 in 200ms | gain 0.25 decay 250ms\n';
    const scaled = scaleKind(src, 'time', 2).source;
    expect(scaled).toContain('sound "s" 600ms');
    expect(scaled).toContain('index 6 -> 0.5 in 400ms');
    expect(scaled).toContain('decay 500ms');
  });

  /* `roundLiteral` keeps whole numbers above 100, so a range this narrow lands on
     a single integer once it is multiplied. Leaving the bounds alone and clamping
     the value is the only outcome that still parses. */
  it('refuses to collapse a slot range that rounding would invert', () => {
    const src = 'sound "s" 40ms pop\n  a: tone sine ~100.05Hz[100..100.1] | gain 0.7 decay 18ms\n';
    const scaled = scaleKind(src, 'freq', 4).source;
    expect(scaled).toContain('[100..100.1]');
    expect(() => parse(scaled)).not.toThrow();
    const head = parse(scaled).layers[0]?.source.args['freq'];
    if (head?.kind !== 'number') throw new Error('expected a number argument');
    expect(head.head.value).toBeLessThanOrEqual(100.1);
    expect(head.head.value).toBeGreaterThanOrEqual(100);
  });

  it('reports nothing to turn when the recipe has no literal of that kind', () => {
    const src = 'sound "s" 40ms pop\n  a: noise white | gain 0.7 decay 18ms\n';
    const result = scaleKind(src, 'freq', 2);
    expect(result.touched).toBe(0);
    expect(result.source).toBe(src);
  });
});

describe('scaleBrightness', () => {
  it('moves an existing low-pass, its ramp target and its slot bounds', () => {
    const src = examples.find((e) => e.name === 'explosion')?.source ?? '';
    const scaled = scaleBrightness(src, 0.5).source;
    expect(scaled).toContain('lp ~600Hz[200..2000] -> 90Hz in 700ms');
    /* The other layers' filters move too — a brightness that only touched one
       layer would rebalance the sound rather than darken it. */
    expect(scaled).toContain('hp 1500Hz');
    expect(scaled).toContain('lp 150Hz');
  });

  it('inserts a low-pass into a layer that has no filter of its own', () => {
    const src = examples.find((e) => e.name === 'coin')?.source ?? '';
    const scaled = scaleBrightness(src, 0.5).source;
    const cutoff = OPEN_CUTOFF_HZ / 2;
    expect(scaled).toContain(`blip: tone square 988Hz >> lp ${String(cutoff)}Hz | gain 0.5 decay 70ms`);
    expect(serialize(parse(scaled))).toBe(scaled);
  });

  it('leaves a band-pass alone — its centre is the layer’s pitch, not its brightness', () => {
    const src = 'sound "s" 40ms pop\n  a: noise white >> bp 3200Hz Q6 | gain 0.7 decay 18ms\n';
    const scaled = scaleBrightness(src, 0.5).source;
    expect(scaled).toContain('bp 3200Hz Q6');
    /* No filter it owns, so the layer gets one — which is the point. */
    expect(scaled).toContain(`>> lp ${String(OPEN_CUTOFF_HZ / 2)}Hz |`);
  });

  it('clamps a cutoff to what the filter signature allows', () => {
    const spec = EFFECTS['lp']?.params.find((p) => p.name === 'freq');
    const max = spec?.max ?? 0;
    const src = 'sound "s" 40ms pop\n  a: noise white >> lp 8000Hz | gain 0.7 decay 18ms\n';
    expect(scaleBrightness(src, 4).source).toContain(`lp ${String(max)}Hz`);

    const low = 'sound "s" 40ms pop\n  a: noise white >> hp 60Hz | gain 0.7 decay 18ms\n';
    expect(scaleBrightness(low, 0.25).source).toContain(`hp ${String(spec?.min ?? 0)}Hz`);
  });

  it('keeps a kHz cutoff in kHz', () => {
    const src = 'sound "s" 40ms pop\n  a: noise white >> lp 4kHz | gain 0.7 decay 18ms\n';
    expect(scaleBrightness(src, 0.5).source).toContain('lp 2kHz');
  });
});
