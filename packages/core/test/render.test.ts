import { describe, expect, it } from 'vitest';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { DEFAULT_SEED, declaredDurationMs, encodeWav, parse, peakOf, renderSound } from '../src/index.js';
import { loadExamples, offlineContext, rms } from './helpers/audio.js';

const examples = loadExamples();

describe('offline render', () => {
  it('covers the ten reference recipes', () => {
    expect(examples).toHaveLength(10);
  });

  for (const example of examples) {
    describe(example.name, () => {
      it('renders audible, unclipped audio', async () => {
        const result = await renderSound(example.ast, { context: offlineContext });
        expect(result.buffer.length).toBeGreaterThan(0);
        expect(result.buffer.sampleRate).toBe(GLOBAL_LIMITS.sampleRate);
        expect(rms(result.buffer)).toBeGreaterThan(0.001);
        expect(result.peak).toBeGreaterThan(0.1);
        expect(result.peak).toBeLessThanOrEqual(GLOBAL_LIMITS.maxPeak);
        expect(result.clipped).toBe(false);
      });

      it('renders at least the duration its header promises', async () => {
        const result = await renderSound(example.ast, { context: offlineContext, padMs: 0 });
        expect(result.durationMs).toBeGreaterThanOrEqual(declaredDurationMs(example.ast) - 1);
      });
    });
  }
});

describe('determinism', () => {
  it('renders the same samples twice for the same seed', async () => {
    const ast = parse('sound "n" 200ms\n  a: noise pink >> bp 1500Hz Q3 | gain 0.8 decay 150ms\n');
    const first = await renderSound(ast, { context: offlineContext, seed: 4242 });
    const second = await renderSound(ast, { context: offlineContext, seed: 4242 });
    expect([...first.buffer.getChannelData(0)]).toEqual([...second.buffer.getChannelData(0)]);
  });

  it('renders different samples for a different seed', async () => {
    const ast = parse('sound "n" 200ms\n  a: noise white | gain 0.8 decay 150ms\n');
    const first = await renderSound(ast, { context: offlineContext, seed: 1 });
    const second = await renderSound(ast, { context: offlineContext, seed: 2 });
    expect([...first.buffer.getChannelData(0)]).not.toEqual([...second.buffer.getChannelData(0)]);
  });

  it('decorrelates two noise layers within one sound', async () => {
    // Same colour, same envelope, different layer: if the seeds were shared the
    // two would sum to one louder copy of the same texture instead of a wider one.
    const ast = parse(
      'sound "n" 200ms\n  a: noise white | gain 0.4 decay 150ms\n  b: noise white | gain 0.4 decay 150ms\n',
    );
    const ir = (await renderSound(ast, { context: offlineContext })).ir;
    const seeds = ir.buffers.flatMap((spec) => ('seed' in spec ? [spec.seed] : []));
    expect(new Set(seeds).size).toBe(2);
  });

  it('uses a fixed default seed', async () => {
    const ast = parse('sound "n" 100ms\n  a: noise white | gain 0.8 decay 80ms\n');
    const implicit = await renderSound(ast, { context: offlineContext });
    const explicit = await renderSound(ast, { context: offlineContext, seed: DEFAULT_SEED });
    expect([...implicit.buffer.getChannelData(0)]).toEqual([...explicit.buffer.getChannelData(0)]);
  });
});

describe('render length', () => {
  it('allocates room for an effect tail beyond the envelope', async () => {
    const withTail = await renderSound(
      parse('sound "v" 100ms\n  a: noise white >> verb 400ms mix 0.5 | gain 0.8 decay 80ms\n'),
      { context: offlineContext, padMs: 0 },
    );
    // 80 ms of envelope plus a 400 ms tail, not the 100 ms the header declares.
    expect(withTail.durationMs).toBeGreaterThan(400);
  });

  it('caps a runaway feedback delay instead of rendering forever', async () => {
    const result = await renderSound(
      parse('sound "d" 200ms\n  a: sub 60Hz >> delay 100ms feedback 0.95 mix 1 | gain 0.8 decay 50ms\n'),
      { context: offlineContext, maxDurationMs: 1000, padMs: 0 },
    );
    expect(result.durationMs).toBeLessThanOrEqual(1001);
  });

  it('reports clipping rather than hiding it', async () => {
    // Four full-gain layers in phase: this is meant to clip, and the renderer
    // must say so instead of normalizing the problem away.
    const ast = parse(
      [
        'sound "loud" 100ms',
        '  a: tone sine 200Hz | gain 1 attack 0ms decay 80ms',
        '  b: tone sine 200Hz | gain 1 attack 0ms decay 80ms',
        '  c: tone sine 200Hz | gain 1 attack 0ms decay 80ms',
        '',
      ].join('\n'),
    );
    const result = await renderSound(ast, { context: offlineContext });
    expect(result.peak).toBeGreaterThan(GLOBAL_LIMITS.maxPeak);
    expect(result.clipped).toBe(true);
  });
});

describe('peakOf', () => {
  it('finds the largest absolute sample', async () => {
    const result = await renderSound(parse('sound "t" 100ms\n  a: tone sine 440Hz | gain 0.5 decay 80ms\n'), {
      context: offlineContext,
    });
    expect(peakOf(result.buffer)).toBe(result.peak);
    expect(result.peak).toBeCloseTo(0.5, 1);
  });
});

describe('wav', () => {
  const render = async (): Promise<AudioBuffer> =>
    (await renderSound(parse('sound "t" 50ms\n  a: tone sine 440Hz | gain 0.5 decay 40ms\n'), { context: offlineContext }))
      .buffer;

  it('writes a 16-bit RIFF/WAVE header of the right size', async () => {
    const buffer = await render();
    const bytes = encodeWav(buffer);
    const view = new DataView(bytes.buffer);
    const tag = (offset: number): string => String.fromCharCode(...bytes.slice(offset, offset + 4));

    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(12)).toBe('fmt ');
    expect(tag(36)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(buffer.sampleRate);
    expect(view.getUint16(34, true)).toBe(16);
    expect(bytes.length).toBe(44 + buffer.length * 2);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(view.getUint32(40, true)).toBe(buffer.length * 2);
  });

  it('writes 32-bit float when asked, tagged as IEEE float', async () => {
    const buffer = await render();
    const bytes = encodeWav(buffer, { bitDepth: 32 });
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(20, true)).toBe(3);
    expect(view.getUint16(34, true)).toBe(32);
    expect(bytes.length).toBe(44 + buffer.length * 4);
    // Float is lossless, so the samples survive the round trip exactly.
    expect(view.getFloat32(44, true)).toBe(buffer.getChannelData(0)[0]);
  });

  it('preserves sample values through the 16-bit conversion', async () => {
    const buffer = await render();
    const bytes = encodeWav(buffer);
    const view = new DataView(bytes.buffer);
    const source = buffer.getChannelData(0);
    for (let i = 0; i < 200; i++) {
      expect(view.getInt16(44 + i * 2, true) / 32767).toBeCloseTo(source[i] ?? 0, 4);
    }
  });
});
