/**
 * `grains` — the field-of-events primitive.
 *
 * Three properties carry their own weight here and are the reason the primitive
 * looks the way it does: the two backends must agree sample for sample (as they do
 * for every other source), the buffer must peak at or below 1 so the mix peak stays
 * predictable from the layer gains, and **density must not change loudness** — if
 * `rate` also made a layer louder, a model reaching for a denser texture would have
 * to re-tune `gain` at the same time, which is exactly the confusion that made the
 * water attempts sound wrong.
 */

import { describe, expect, it } from 'vitest';
import type { SoundAST } from '@txt2sfx/shared';
import { codegen, compileToIR, parse, renderSound } from '../src/index.js';
import { maxAbsDiff, offlineContext, rms } from './helpers/audio.js';

const doc = (layer: string, header = 'sound "t" 400ms foley'): string => `${header}\n  a: ${layer}\n`;

const render = (source: string, seed?: number): Promise<{ buffer: AudioBuffer; peak: number }> =>
  renderSound(parse(source), { context: offlineContext, ...(seed === undefined ? {} : { seed }) });

/** Instantiate the exported function and render it, as a consumer would. */
async function renderExport(ast: SoundAST, length: number, sampleRate: number): Promise<AudioBuffer> {
  const play = new Function(`return ${codegen(ast).code}`)() as (ctx: unknown, when?: number) => void;
  const ctx = offlineContext({ numberOfChannels: 1, length, sampleRate });
  play(ctx, 0);
  return ctx.startRendering();
}

const FIELD = 'grains 1200Hz rate 60 width 10ms spread 1.5 jitter 1 | gain 0.8 decay 300ms';

describe('grains', () => {
  it('renders a non-empty, non-clipping field', async () => {
    const { buffer, peak } = await render(doc(FIELD));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(0.95);
    expect(rms(buffer)).toBeGreaterThan(0.005);
  });

  /* The whole point of the two-halves-of-one-generator discipline in `buffers.ts`.
     A single mismatched operation order shows up here and nowhere else. */
  it('exports code that renders bit-identically to the live graph', async () => {
    const ast = parse(doc(FIELD));
    const live = await render(doc(FIELD));
    const exported = await renderExport(ast, live.buffer.length, live.buffer.sampleRate);
    expect(maxAbsDiff(live.buffer, exported)).toBe(0);
  });

  it('is deterministic for a seed, and different for another', async () => {
    const a = await render(doc(FIELD), 12345);
    const b = await render(doc(FIELD), 12345);
    const c = await render(doc(FIELD), 999);
    expect(maxAbsDiff(a.buffer, b.buffer)).toBe(0);
    expect(maxAbsDiff(a.buffer, c.buffer)).toBeGreaterThan(0.01);
  });

  /**
   * Density changes the texture, not the level.
   *
   * The generator normalizes to unit peak, so ten grains a second and two hundred
   * reach the same peak while the dense field carries far more energy. Without this
   * the two knobs would be entangled and `rate` would read as a volume control.
   */
  it('makes a denser field busier, not louder', async () => {
    const sparse = await render(doc('grains 1200Hz rate 12 width 10ms | gain 0.8 decay 300ms'));
    const dense = await render(doc('grains 1200Hz rate 220 width 10ms | gain 0.8 decay 300ms'));

    /* Measured: 0.545 against 0.477. Not equal, and the direction is worth knowing —
       the buffer's single loudest sample lands wherever it lands under the decaying
       envelope, so a denser field is if anything a shade *quieter* at the peak. What
       must never happen is the opposite: density buying level. */
    expect(dense.peak).toBeLessThan(sparse.peak * 1.1);
    /* Energy, though, roughly doubles: 0.0218 -> 0.0442 RMS. */
    expect(rms(dense.buffer)).toBeGreaterThan(rms(sparse.buffer) * 1.5);
  });

  /**
   * `bend` is the parameter that decides water from ice.
   *
   * It was a hidden 1.06 until someone listened to a grain field and heard "small
   * shards of ice scattering" — correct: a short bright ping whose pitch does not move
   * is glass, and the rising chirp is the cue for water. Two things are checked, the
   * second being the one a wrong sign or a stray factor would break: `bend 1` really
   * leaves the pitch alone, and bending up and bending down are not the same sound.
   */
  it('bends each grain by the factor it was given', async () => {
    const flat = await render(doc('grains 900Hz rate 30 width 30ms bend 1 | gain 0.8 decay 300ms'));
    const up = await render(doc('grains 900Hz rate 30 width 30ms bend 1.6 | gain 0.8 decay 300ms'));
    const down = await render(doc('grains 900Hz rate 30 width 30ms bend 0.6 | gain 0.8 decay 300ms'));

    expect(maxAbsDiff(flat.buffer, up.buffer)).toBeGreaterThan(0.05);
    expect(maxAbsDiff(up.buffer, down.buffer)).toBeGreaterThan(0.05);

    /* A grain that bends upward ends brighter than one that does not, measured as
       high-frequency energy over the second half of the field. */
    const highs = (buffer: AudioBuffer): number => {
      const data = buffer.getChannelData(0);
      let sum = 0;
      for (let i = 1; i < data.length; i++) sum += ((data[i] ?? 0) - (data[i - 1] ?? 0)) ** 2;
      return Math.sqrt(sum / data.length);
    };
    expect(highs(up.buffer)).toBeGreaterThan(highs(flat.buffer));
    expect(highs(down.buffer)).toBeLessThan(highs(flat.buffer));
  });

  /* `jitter 0` is a machine and `jitter 1` is a rainstorm; a field that ignored the
     parameter would still pass every other test here. */
  it('honours jitter', async () => {
    const metronomic = await render(doc('grains 1200Hz rate 40 width 8ms jitter 0 | gain 0.8 decay 300ms'));
    const scattered = await render(doc('grains 1200Hz rate 40 width 8ms jitter 1 | gain 0.8 decay 300ms'));
    expect(maxAbsDiff(metronomic.buffer, scattered.buffer)).toBeGreaterThan(0.01);
  });

  /**
   * `spread` is what turns pings into noise.
   *
   * With no scatter every grain sits at `freq`, so the field is periodic-ish and its
   * energy is concentrated; with three octaves of scatter it is broadband. Compared
   * as a ratio of energy above 4 kHz, measured crudely by a one-pole difference —
   * the analyzer package does this properly, and core keeps no dependency on it.
   */
  it('turns into broadband texture as spread widens', async () => {
    const narrow = await render(doc('grains 800Hz rate 80 width 8ms spread 0 | gain 0.8 decay 300ms'));
    const wide = await render(doc('grains 800Hz rate 80 width 8ms spread 3 | gain 0.8 decay 300ms'));

    const highs = (buffer: AudioBuffer): number => {
      const data = buffer.getChannelData(0);
      let sum = 0;
      for (let i = 1; i < data.length; i++) sum += ((data[i] ?? 0) - (data[i - 1] ?? 0)) ** 2;
      return Math.sqrt(sum / data.length);
    };

    expect(highs(wide.buffer)).toBeGreaterThan(highs(narrow.buffer) * 1.3);
  });

  /**
   * The table spans the whole voice rather than looping a short one.
   *
   * A looped grain field puts a periodicity at the seam, and the analyzer reads that
   * as a spectral peak — a pitch the sound does not have. Checked on the IR, not by
   * comparing halves of the render: a sparse field is mostly exact zeros, so half the
   * samples match each other whether it loops or not.
   */
  it('sizes its table to the voice, not to a loop', () => {
    const ir = compileToIR(parse(doc('grains 1000Hz rate 30 width 8ms | gain 0.8 decay 900ms', 'sound "t" 1s foley')));
    const spec = ir.buffers[0];
    expect(spec?.kind).toBe('grains');
    /* attack + decay of the layer, 0.901 s as measured — not a fraction of it. */
    expect(spec?.sec).toBeGreaterThan(0.85);
  });

  it('costs what a procedural generator costs, and no more', () => {
    const { bytes } = codegen(parse(doc(FIELD)));
    /* Measured at 980 B for a one-layer recipe, of which the generator is the bulk.
       A ceiling rather than a target, so an emitter change that costs bytes shows up
       as a failure instead of drift. This is the same trade §5.4 of the plan already
       names: procedural generators are the fixed cost of shipping no assets. */
    expect(bytes).toBeLessThan(1050);
  });
});
