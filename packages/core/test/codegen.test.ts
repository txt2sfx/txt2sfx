import { describe, expect, it } from 'vitest';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import type { SoundAST } from '@txt2sfx/shared';
import { codegen, compileToIR, parse, renderSound } from '../src/index.js';
import { loadExamples, maxAbsDiff, offlineContext, rmsEnvelope } from './helpers/audio.js';

const examples = loadExamples();

/** Instantiate an exported function the way a consumer would: from its source. */
function instantiateExport(code: string): (ctx: unknown, when?: number) => void {
  return new Function(`return ${code}`)() as (ctx: unknown, when?: number) => void;
}

/** Render a sound through the exported code rather than the live graph. */
async function renderExport(ast: SoundAST, length: number, sampleRate: number, when = 0): Promise<AudioBuffer> {
  const play = instantiateExport(codegen(ast).code);
  const ctx = offlineContext({ numberOfChannels: 1, length, sampleRate });
  play(ctx, when);
  return ctx.startRendering();
}

/**
 * Recorded export sizes, as a regression ceiling.
 *
 * `GLOBAL_LIMITS.maxExportBytes` is 1 KB and the four two-layer examples are
 * comfortably inside it. The larger sounds are not, and the reason is structural
 * rather than sloppy emission: a sound that asks for three noise colours, a modal
 * bank and a convolution reverb pays for three procedural generators, and those
 * generators are the price of shipping no assets at all. These ceilings are the
 * measured sizes with a little slack, so an emitter change that costs bytes shows
 * up here as a failure rather than as drift.
 */
const EXPORT_CEILING: Readonly<Record<string, number>> = {
  'bubble-pop': 900,
  coin: 600,
  'door-creak': 1250,
  explosion: 1550,
  'footstep-gravel': 1800,
  helicopter: 1150,
  laser: 600,
  powerup: 1250,
  'sword-clash': 1650,
  'ui-click': 900,
};

describe('codegen', () => {
  it('emits a callable arrow function taking a context and a start time', () => {
    const { code } = codegen(parse('sound "t" 50ms\n  a: tone sine 440Hz | gain 0.8 decay 40ms\n'));
    expect(code.startsWith('(c,w=0)=>{')).toBe(true);
    expect(code.endsWith('}')).toBe(true);
    expect(typeof instantiateExport(code)).toBe('function');
  });

  it('carries no imports and no reference to this package', () => {
    for (const example of examples) {
      const { code } = codegen(example.ast);
      expect(code, example.name).not.toMatch(/\b(import|require|txt2sfx)\b/);
    }
  });

  for (const example of examples) {
    describe(example.name, () => {
      it('renders bit-identically to the live graph', async () => {
        const reference = await renderSound(example.ast, { context: offlineContext });
        const exported = await renderExport(
          example.ast,
          reference.buffer.length,
          reference.buffer.sampleRate,
        );

        // Both backends play the same IR through the same audio engine, so this is
        // not a tolerance test: any difference at all means the emitter and the
        // instantiator disagree about the graph.
        expect(maxAbsDiff(reference.buffer, exported)).toBe(0);
      });

      it('matches the reference RMS envelope', async () => {
        const reference = await renderSound(example.ast, { context: offlineContext });
        const exported = await renderExport(example.ast, reference.buffer.length, reference.buffer.sampleRate);

        const a = rmsEnvelope(reference.buffer);
        const b = rmsEnvelope(exported);
        for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i] ?? 0, 6);
      });

      it('stays inside its recorded size ceiling', () => {
        const { bytes } = codegen(example.ast);
        const ceiling = EXPORT_CEILING[example.name];
        expect(ceiling, `no recorded ceiling for ${example.name}`).toBeDefined();
        expect(bytes).toBeLessThanOrEqual(ceiling ?? 0);
      });

      it('fits the 1 KB budget when the sound has at most two layers', () => {
        const { bytes, withinBudget } = codegen(example.ast);
        if (example.ast.layers.length > 2) return;
        expect(withinBudget, `${example.name} is ${bytes} bytes`).toBe(true);
        expect(bytes).toBeLessThanOrEqual(GLOBAL_LIMITS.maxExportBytes);
      });
    });
  }

  it('honours the start-time argument', async () => {
    const ast = parse('sound "t" 100ms\n  a: tone sine 880Hz | gain 0.8 attack 1ms decay 60ms\n');
    const rate = GLOBAL_LIMITS.sampleRate;
    const offsetSec = 0.2;

    const late = await renderExport(ast, Math.ceil(rate * 0.4), rate, offsetSec);
    const samples = late.getChannelData(0);
    const onset = Math.floor(offsetSec * rate);

    // Silent before the offset, sounding after it.
    let before = 0;
    for (let i = 0; i < onset - 1; i++) before = Math.max(before, Math.abs(samples[i] ?? 0));
    let after = 0;
    for (let i = onset; i < Math.min(samples.length, onset + 1000); i++) {
      after = Math.max(after, Math.abs(samples[i] ?? 0));
    }
    expect(before).toBe(0);
    expect(after).toBeGreaterThan(0.1);
  });

  it('is a pure function of the AST and the seed', () => {
    const ast = parse('sound "n" 120ms\n  a: noise pink >> bp 1200Hz | gain 0.7 decay 90ms\n');
    expect(codegen(ast).code).toBe(codegen(ast).code);
    expect(codegen(ast, { seed: 1 }).code).not.toBe(codegen(ast, { seed: 2 }).code);
  });

  it('emits only the noise colours the sound uses', () => {
    // The pink filter coefficients are the tell: a white-only sound must not ship them.
    const white = codegen(parse('sound "n" 80ms\n  a: noise white | gain 0.7 decay 60ms\n')).code;
    const pink = codegen(parse('sound "n" 80ms\n  a: noise pink | gain 0.7 decay 60ms\n')).code;
    expect(white).not.toContain('.99765');
    expect(pink).toContain('.99765');
    // With one colour there is no colour argument to pass either.
    expect(white).not.toContain('k==1');
  });

  it('skips values Web Audio already defaults to', () => {
    const code = codegen(parse('sound "t" 80ms\n  a: tone sine 440Hz | gain 1 decay 60ms\n')).code;
    // A sine oscillator needs no `type`, and the mix bus gain of 1 needs no write.
    expect(code).not.toContain('.type="sine"');
    expect(code).not.toContain('.gain.value=1;');
  });

  it('writes a parameter that never moves as a plain assignment', () => {
    const code = codegen(parse('sound "t" 80ms\n  a: noise white >> lp 1200Hz | gain 0.7 decay 60ms\n')).code;
    expect(code).toContain('.frequency.value=1200');
    expect(code).not.toContain('setValueAtTime(1200');
  });

  it('reports its size rather than truncating to fit', () => {
    const big = examples.find((e) => e.name === 'footstep-gravel');
    if (big === undefined) throw new Error('missing example');
    const result = codegen(big.ast);
    expect(result.withinBudget).toBe(false);
    expect(result.bytes).toBeGreaterThan(GLOBAL_LIMITS.maxExportBytes);
    // Still complete and still runnable — the budget is a report, not a limit.
    expect(typeof instantiateExport(result.code)).toBe('function');
  });

  it('reuses one buffer recipe for identical layers', () => {
    const ir = compileToIR(
      parse('sound "m" 200ms\n  a: modal metal 800Hz | gain 0.5 decay 150ms\n  b: modal metal 800Hz | gain 0.5 decay 150ms\n'),
    );
    expect(ir.buffers).toHaveLength(1);
  });
});
