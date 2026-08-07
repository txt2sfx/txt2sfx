/**
 * `plate` — the dense mode bank whose decay is not a `Q`.
 *
 * The properties tested here are the ones that justify the primitive existing at
 * all, and each was a measured failure of the alternatives first (see
 * `docs/PRIMITIVES.md` for the numbers):
 *
 * - **decay is frequency-independent.** `modal` inherits `tau = Q / (pi * f)` from
 *   its resonators, so a long ring at a high pitch is unreachable — at 3.6 kHz the
 *   `Q 400` ceiling is 35 ms. This one rings for the time it was given at any pitch,
 *   and that is asserted rather than assumed.
 * - **`slope` places the spectrum where a band-pass cannot.** Flattening the
 *   amplitude law lifts the centre by more than an octave; a 12 dB/octave filter
 *   skirt leaves the fundamental dominant.
 * - **nothing aliases.** A mode above Nyquist folds to an arbitrary frequency, which
 *   is heard as a wrong partial rather than as a missing one.
 * - the two backends agree sample for sample, and the buffer stays inside unit peak.
 */

import { describe, expect, it } from 'vitest';
import type { SoundAST } from '@txt2sfx/shared';
import { codegen, compileToIR, parse, renderSound, serialize } from '../src/index.js';
import { maxAbsDiff, offlineContext, rms } from './helpers/audio.js';

const doc = (layer: string, header = 'sound "t" 1400ms impact'): string => `${header}\n  a: ${layer}\n`;

const render = (source: string, seed?: number): Promise<{ buffer: AudioBuffer; peak: number }> =>
  renderSound(parse(source), { context: offlineContext, ...(seed === undefined ? {} : { seed }) });

/** Instantiate the exported function and render it, as a consumer would. */
async function renderExport(ast: SoundAST, length: number, sampleRate: number): Promise<AudioBuffer> {
  const play = new Function(`return ${codegen(ast).code}`)() as (ctx: unknown, when?: number) => void;
  const ctx = offlineContext({ numberOfChannels: 1, length, sampleRate });
  play(ctx, 0);
  return ctx.startRendering();
}

/**
 * Zero crossings per second — a brightness proxy.
 *
 * The analyzer's spectral centroid is the number this property is really about, but
 * `packages/core` does not know `@txt2sfx/analyzer` exists and a test is a poor place
 * to introduce the first dependency in that direction. For a bank of decaying
 * sinusoids the crossing rate tracks the centroid closely enough to assert a
 * monotone trend, which is what matters here.
 */
function crossingRate(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let crossings = 0;
  for (let i = 1; i < data.length; i++) {
    if (((data[i] as number) >= 0) !== ((data[i - 1] as number) >= 0)) crossings++;
  }
  return (crossings * buffer.sampleRate) / data.length;
}

/** Samples until the signal stays below `floor` of its peak for good, in ms. */
function ringMs(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (const value of data) peak = Math.max(peak, Math.abs(value));
  const floor = peak * 0.001; // -60 dB
  let last = 0;
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i] as number) > floor) last = i;
  return (last / buffer.sampleRate) * 1000;
}

const BANK = 'plate 900Hz modes 12 stretch 1.3 decay 900ms tilt 0.7 | gain 0.8 attack 10ms hold 800ms decay 300ms';

describe('plate', () => {
  it('renders a non-empty, non-clipping bank', async () => {
    const { buffer, peak } = await render(doc(BANK));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(0.95);
    expect(rms(buffer)).toBeGreaterThan(0.005);
  });

  it('round-trips through the serializer', () => {
    const source = doc(BANK);
    expect(serialize(parse(source))).toBe(source);
  });

  /* The two-halves-of-one-generator discipline in `buffers.ts`. A single mismatched
     operation order shows up here and nowhere else. */
  it('exports code that renders bit-identically to the live graph', async () => {
    const ast = parse(doc(BANK));
    const live = await render(doc(BANK));
    const exported = await renderExport(ast, live.buffer.length, live.buffer.sampleRate);
    expect(maxAbsDiff(live.buffer, exported)).toBe(0);
  });

  it('is deterministic for a seed, and different for another', async () => {
    const a = await render(doc(BANK), 7);
    const b = await render(doc(BANK), 7);
    const c = await render(doc(BANK), 8);
    expect(maxAbsDiff(a.buffer, b.buffer)).toBe(0);
    expect(maxAbsDiff(a.buffer, c.buffer)).toBeGreaterThan(0);
  });

  /**
   * The reason this primitive exists.
   *
   * `modal metal 3600Hz Q400` — the longest ring the modal grammar can express at
   * that pitch — is 60 dB down inside ~250 ms, because `tau = Q / (pi * f)`. A plate
   * asked for 900 ms rings for 900 ms whether it is asked at 400 Hz or at 4 kHz.
   */
  it('rings for the time it was given, at any pitch', async () => {
    const flat = '| gain 0.8 attack 2ms hold 1000ms decay 100ms';
    const low = await render(doc(`plate 400Hz modes 8 decay 900ms ${flat}`));
    const high = await render(doc(`plate 4000Hz modes 8 decay 900ms ${flat}`));
    for (const [name, result] of [
      ['low', low],
      ['high', high],
    ] as const) {
      expect(ringMs(result.buffer), name).toBeGreaterThan(700);
    }

    const modal = await render(doc(`modal metal 3600Hz Q400 ${flat}`));
    expect(ringMs(modal.buffer)).toBeLessThan(400);
  });

  /**
   * `slope` is the spectral placement control, and the reason it exists.
   *
   * Flattening the amplitude law moves energy up into the stretched modes: measured
   * with the analyzer, the mean centroid of this bank runs 832 Hz at `slope 2` to
   * 2942 Hz at `slope 0`.
   * A band-pass on the layer cannot do the same job — a 12 dB/octave skirt leaves the
   * fundamental dominant — and that is what kept the fitted dominant partial an
   * octave below the reference until this parameter existed.
   *
   * Note what is deliberately *not* asserted: that more modes lower the crest factor.
   * It was predicted and measured false (3 modes 21.7 dB, 12 modes 23.4 dB) because
   * `1/k` leaves the lowest mode owning the peak. Density here is spectral.
   */
  it('moves its spectral centre with slope, not with a filter', async () => {
    const bank = (slope: number): string =>
      doc(`plate 600Hz modes 16 stretch 1.2 slope ${slope} decay 900ms tilt 0.4 | gain 0.8 attack 5ms hold 800ms decay 200ms`);
    const brightness: number[] = [];
    for (const slope of [0, 0.5, 1, 2]) {
      const { buffer } = await render(bank(slope));
      brightness.push(crossingRate(buffer));
    }
    /* Monotone: every step towards a steeper law is a step down in centre frequency. */
    for (let i = 1; i < brightness.length; i++) {
      expect(brightness[i] as number, `slope step ${i}`).toBeLessThan(brightness[i - 1] as number);
    }
    expect(brightness[0] as number).toBeGreaterThan(2 * (brightness[3] as number));
  });

  it('keeps every bank inside the peak the mix budget assumes', async () => {
    for (const slope of [0, 1, 2.5]) {
      const { peak } = await render(
        doc(`plate 600Hz modes 24 stretch 1.2 slope ${slope} decay 600ms tilt 0.2 | gain 0.95 hold 500ms decay 100ms`),
      );
      expect(peak, `slope ${slope}`).toBeLessThanOrEqual(0.95);
    }
  });

  /**
   * A mode above Nyquist would fold to an arbitrary frequency and be heard as a
   * wrong partial. Skipping it also has to cost no level, which is what the second
   * assertion is about: the normalizer counts only the modes that ring.
   */
  it('drops modes above Nyquist instead of aliasing them', async () => {
    const asked = doc('plate 8000Hz modes 16 stretch 1.4 decay 400ms | gain 0.8 hold 300ms decay 100ms');
    const fits = doc('plate 8000Hz modes 2 stretch 1.4 decay 400ms | gain 0.8 hold 300ms decay 100ms');
    const wide = await render(asked);
    const narrow = await render(fits);
    /* 8000 * 2**1.4 = 21 kHz fits, 8000 * 3**1.4 = 37 kHz does not: asking for 16
       modes and asking for 2 must therefore render the same sound. */
    expect(maxAbsDiff(wide.buffer, narrow.buffer)).toBe(0);
    expect(wide.peak).toBeGreaterThan(0.1);
  });

  it('sizes its table to the decay it was given, not to the header', () => {
    const short = compileToIR(parse(doc('plate 900Hz decay 200ms | gain 0.8 decay 200ms')));
    const long = compileToIR(parse(doc('plate 900Hz decay 1200ms | gain 0.8 hold 1000ms decay 200ms')));
    const secOf = (ir: ReturnType<typeof compileToIR>): number => {
      const spec = ir.buffers.find((b) => b.kind === 'plate');
      if (spec === undefined) throw new Error('no plate buffer in the IR');
      return spec.sec;
    };
    /* Not the header's 1400 ms in either case. The short one is bounded by its own
       envelope instead (`voiceSeconds`), which is the tighter of the two rules and
       the reason this asserts a range rather than `decay + 0.01` exactly. */
    expect(secOf(short)).toBeLessThan(0.25);
    expect(secOf(long)).toBeGreaterThan(1.1);
    expect(secOf(long)).toBeLessThan(1.3);
  });

  it('costs what a procedural generator costs, and no more', () => {
    const { bytes } = codegen(parse(doc(BANK)));
    expect(bytes).toBeGreaterThan(300);
    expect(bytes).toBeLessThan(900);
  });
});
