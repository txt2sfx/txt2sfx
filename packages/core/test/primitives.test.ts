import { describe, expect, it } from 'vitest';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import {
  EFFECT_NAMES,
  MATERIAL_RATIOS,
  PRIMITIVE_NAMES,
  compileToIR,
  effectTailMs,
  envelopeParam,
  envelopeTiming,
  fillBuffer,
  layerEndMs,
  normalizeSeed,
  parse,
  registryGaps,
  renderSound,
  shaperCurve,
  soundDurationMs,
} from '../src/index.js';
import type { AudioIR, IRNode } from '../src/index.js';
import { offlineContext } from './helpers/audio.js';

/** Wrap a layer body in the smallest legal document. */
const doc = (layer: string, header = 'sound "t" 400ms'): string => `${header}\n  a: ${layer}\n`;

const irOf = (layer: string, header?: string): AudioIR => compileToIR(parse(doc(layer, header)));

const firstOf = <K extends IRNode['kind']>(ir: AudioIR, kind: K): Extract<IRNode, { kind: K }> => {
  const node = ir.nodes.find((n): n is Extract<IRNode, { kind: K }> => n.kind === kind);
  if (node === undefined) throw new Error(`no ${kind} node in IR`);
  return node;
};

/* ------------------------------------------------------------------------- *
 * Registry
 * ------------------------------------------------------------------------- */

describe('registry', () => {
  it('builds every word the grammar accepts, and no others', () => {
    expect(registryGaps()).toEqual({ missing: [], extra: [] });
  });

  it('covers the nine primitives and six effects of v0', () => {
    /* Nine since `grains`: `noise` is stationary and `chirp` is one sweep, so a
       dense field of short events had no expression at all. */
    expect(PRIMITIVE_NAMES).toHaveLength(9);
    expect(EFFECT_NAMES).toHaveLength(6);
  });
});

/* ------------------------------------------------------------------------- *
 * Primitives
 * ------------------------------------------------------------------------- */

/** One minimal layer per primitive, exercising its required arguments. */
const PRIMITIVE_LAYERS: Readonly<Record<string, string>> = {
  tone: 'tone sine 440Hz | gain 1 decay 200ms',
  noise: 'noise white | gain 1 decay 200ms',
  chirp: 'chirp saw 1800Hz -> 220Hz in 120ms | gain 1 decay 200ms',
  pluck: 'pluck 440Hz | gain 1 decay 200ms',
  modal: 'modal metal 800Hz | gain 1 decay 200ms',
  fm: 'fm 600Hz | gain 1 decay 200ms',
  sub: 'sub 60Hz | gain 1 decay 200ms',
  click: 'click 2ms | gain 1 decay 30ms',
  grains: 'grains 1200Hz rate 60 width 10ms spread 1.5 | gain 1 decay 200ms',
};

describe('primitives', () => {
  for (const name of PRIMITIVE_NAMES) {
    const layer = PRIMITIVE_LAYERS[name];
    if (layer === undefined) throw new Error(`test is missing a layer for '${name}'`);

    describe(name, () => {
      it('renders audible, unclipped audio', async () => {
        const { buffer, peak } = await renderSound(parse(doc(layer)), { context: offlineContext });
        expect(buffer.length).toBeGreaterThan(0);
        // Loud enough to be a sound, quiet enough to leave the mix headroom: every
        // primitive promises a roughly unit-peak signal so that layer gains mean
        // what they say.
        expect(peak).toBeGreaterThan(0.05);
        expect(peak).toBeLessThanOrEqual(1);
      });
    });
  }

  it('reads defaults from the signature rather than restating them', () => {
    // `chirp` defaults to a saw, `modal` to metal, `pluck` damp/bright to 0.5.
    expect(firstOf(irOf('chirp 1000Hz | gain 1 decay 100ms'), 'osc').wave).toBe('sawtooth');
    const pluck = irOf('pluck 440Hz | gain 1 decay 100ms').buffers[0];
    expect(pluck).toMatchObject({ kind: 'pluck', damp: 0.5, bright: 0.5 });
  });

  it('maps soundline waveform names to Web Audio ones', () => {
    expect(firstOf(irOf('tone tri 440Hz | gain 1 decay 50ms'), 'osc').wave).toBe('triangle');
    expect(firstOf(irOf('tone square 440Hz | gain 1 decay 50ms'), 'osc').wave).toBe('square');
    // `sub` has no waveform of its own and is always a sine.
    expect(firstOf(irOf('sub 60Hz | gain 1 decay 50ms'), 'osc').wave).toBe('sine');
  });

  it('picks partial ratios by material and lets ratios override them', () => {
    const wood = irOf('modal wood 1000Hz | gain 1 decay 100ms').buffers[0];
    expect(wood).toMatchObject({ kind: 'modal', ratios: MATERIAL_RATIOS['wood'] });

    const explicit = irOf('modal metal 1000Hz ratios 1:3:7 | gain 1 decay 100ms').buffers[0];
    expect(explicit).toMatchObject({ kind: 'modal', ratios: [1, 3, 7] });
  });

  it('turns an fm index into a frequency deviation', () => {
    // index 4 on a modulator at 600 * 2.5 = 1500 Hz deviates the carrier by 6000 Hz.
    const ir = irOf('fm 600Hz ratio 2.5 index 4 | gain 1 decay 100ms');
    const deviation = ir.nodes.filter((n) => n.kind === 'gain').map((n) => (n.kind === 'gain' ? n.gain : null));
    const values = deviation.flatMap((p) => (p === null ? [] : p.events.map((e) => e.value)));
    expect(values).toContain(6000);
  });

  it('drives the carrier frequency, not its amplitude', () => {
    const ir = irOf('fm 600Hz | gain 1 decay 100ms');
    const modulation = ir.edges.find((e) => typeof e.to === 'object');
    expect(modulation?.to).toEqual({ node: expect.any(Number), param: 'freq' });
  });

  it('stops a click at its own width, not at the end of the envelope', () => {
    const ir = irOf('click 2ms | gain 1 decay 300ms');
    const player = firstOf(ir, 'player');
    expect(player.stop).toBeCloseTo(0.002, 6);
  });
});

/* ------------------------------------------------------------------------- *
 * Effects
 * ------------------------------------------------------------------------- */

/** One minimal chain per effect. */
const EFFECT_CHAINS: Readonly<Record<string, string>> = {
  lp: '>> lp 1200Hz',
  hp: '>> hp 800Hz',
  bp: '>> bp 2000Hz Q4',
  dist: '>> dist drive 3 mix 0.5',
  delay: '>> delay 40ms feedback 0.4 mix 0.5',
  verb: '>> verb 120ms mix 0.3',
};

describe('effects', () => {
  for (const name of EFFECT_NAMES) {
    const chain = EFFECT_CHAINS[name];
    if (chain === undefined) throw new Error(`test is missing a chain for '${name}'`);

    it(`${name} renders audible, unclipped audio`, async () => {
      const source = `noise white ${chain} | gain 0.5 decay 150ms`;
      const { peak } = await renderSound(parse(doc(source)), { context: offlineContext });
      expect(peak).toBeGreaterThan(0.02);
      expect(peak).toBeLessThanOrEqual(GLOBAL_LIMITS.maxPeak);
    });
  }

  it('can raise the peak above its input, which is why peak is measured, not predicted', async () => {
    // A high-pass differentiates: neighbouring samples of white noise differ by up
    // to twice the peak, so the filter output legitimately overshoots its input.
    // Any invariant about clipping therefore has to be checked on the rendered
    // mix — the sum of the layer gains is not an upper bound.
    const { peak } = await renderSound(parse(doc('noise white >> hp 800Hz | gain 0.8 decay 150ms')), {
      context: offlineContext,
    });
    expect(peak).toBeGreaterThan(0.8);
  });

  it('applies the signature Q default per filter kind', () => {
    expect(firstOf(irOf('noise white >> lp 1000Hz | gain 1 decay 50ms'), 'filter').q).toBe(0.7);
    expect(firstOf(irOf('noise white >> bp 1000Hz | gain 1 decay 50ms'), 'filter').q).toBe(4);
  });

  it('builds no wet path at mix 0 and no dry bus at mix 1', () => {
    const bypassed = irOf('noise white >> dist drive 3 mix 0 | gain 1 decay 50ms');
    expect(bypassed.nodes.some((n) => n.kind === 'shaper')).toBe(false);

    const wetOnly = irOf('noise white >> dist drive 3 mix 1 | gain 1 decay 50ms');
    expect(wetOnly.nodes.filter((n) => n.kind === 'shaper')).toHaveLength(1);
    // Only the envelope gain: no dry/wet/bus trio.
    expect(wetOnly.nodes.filter((n) => n.kind === 'gain')).toHaveLength(1);
  });

  it('closes the delay feedback loop through the delay line', () => {
    const ir = irOf('sub 60Hz >> delay 90ms feedback 0.8 mix 1 | gain 1 decay 50ms');
    const line = firstOf(ir, 'delay');
    const loop = ir.edges.filter((e) => e.to === line.id);
    // The envelope feeds it and the feedback gain feeds it back.
    expect(loop).toHaveLength(2);
    expect(ir.edges.some((e) => e.from === line.id && typeof e.to === 'number')).toBe(true);
  });

  it('keeps the delay line longer than the delay it holds', () => {
    const line = firstOf(irOf('sub 60Hz >> delay 90ms | gain 1 decay 50ms'), 'delay');
    expect(line.max).toBeGreaterThan(line.time);
  });
});

/* ------------------------------------------------------------------------- *
 * Envelope
 * ------------------------------------------------------------------------- */

describe('envelope', () => {
  const timingOf = (layer: string): ReturnType<typeof envelopeTiming> => {
    const node = parse(doc(layer)).layers[0]?.envelope;
    if (node === undefined) throw new Error('no envelope');
    return envelopeTiming(node);
  };

  it('applies signature defaults for the parameters left unwritten', () => {
    const timing = timingOf('tone sine 440Hz | decay 100ms');
    expect(timing).toMatchObject({ peak: 1, attackSec: 0.001, holdSec: 0, decaySec: 0.1, curve: 'exp', startSec: 0 });
  });

  it('converts a dB gain to linear', () => {
    expect(timingOf('tone sine 440Hz | gain -6dB decay 100ms').peak).toBeCloseTo(0.5012, 4);
  });

  // `envelopeParam` is read here before `quantizeIR` has rounded the IR, so the
  // event times still carry binary-float noise; compare them numerically.
  it('rises linearly from zero and decays exponentially to a floor', () => {
    const events = envelopeParam(timingOf('tone sine 440Hz | gain 0.8 attack 5ms decay 100ms')).events;
    expect(events.map((e) => e.type)).toEqual(['set', 'lin', 'exp']);
    expect(events[0]).toMatchObject({ value: 0, at: 0 });
    expect(events[1]?.value).toBe(0.8);
    expect(events[1]?.at).toBeCloseTo(0.005, 9);
    expect(events[2]?.value).toBe(GLOBAL_LIMITS.minExpTarget);
    expect(events[2]?.at).toBeCloseTo(0.105, 9);
  });

  it('holds at peak before decaying when hold is set', () => {
    const events = envelopeParam(timingOf('tone sine 440Hz | gain 0.5 hold 20ms decay 50ms')).events;
    expect(events.map((e) => e.type)).toEqual(['set', 'lin', 'set', 'exp']);
    expect(events[2]?.value).toBe(0.5);
    expect(events[2]?.at).toBeCloseTo(0.021, 9);
  });

  it('decays to true zero only on a linear curve', () => {
    const events = envelopeParam(timingOf('tone sine 440Hz | gain 0.5 decay 50ms curve lin')).events;
    expect(events[events.length - 1]).toMatchObject({ type: 'lin', value: 0 });
  });

  it('offsets the whole layer by the envelope delay', () => {
    const timing = timingOf('tone sine 440Hz | gain 0.5 decay 50ms delay 70ms');
    expect(timing.startSec).toBeCloseTo(0.07, 6);
    expect(timing.endSec).toBeCloseTo(0.121, 6);
  });
});

describe('exponential ramp safety', () => {
  it('never targets zero, in any example or ramp', () => {
    const cases = [
      'tone sine 2000Hz -> 0Hz in 40ms | gain 1 decay 100ms',
      'fm 600Hz index 6 -> 0 in 80ms | gain 1 decay 100ms',
      'tone sine 440Hz | gain 0.0001 decay 100ms',
    ];
    for (const layer of cases) {
      for (const node of irOf(layer).nodes) {
        const params = node.kind === 'osc' ? [node.freq] : node.kind === 'gain' ? [node.gain] : [];
        for (const param of params) {
          for (const event of param.events) {
            if (event.type !== 'exp') continue;
            expect(Math.abs(event.value)).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

/* ------------------------------------------------------------------------- *
 * Tails and duration
 * ------------------------------------------------------------------------- */

describe('duration', () => {
  it('gives a biquad no tail of its own', () => {
    expect(effectTailMs('lp', parse(doc('noise white >> lp 1kHz | gain 1 decay 50ms')).layers[0]!.chain[0]!.args)).toBe(0);
  });

  it('counts a reverb tail as exactly its declared time', () => {
    const chain = parse(doc('noise white >> verb 220ms mix 0.2 | gain 1 decay 50ms')).layers[0]!.chain[0]!;
    expect(effectTailMs('verb', chain.args)).toBe(220);
  });

  it('estimates a feedback delay tail from the time it takes to fall 60 dB', () => {
    const chain = parse(doc('sub 60Hz >> delay 100ms feedback 0.5 mix 0.5 | gain 1 decay 50ms')).layers[0]!.chain[0]!;
    // 0.5^n = 0.001 at n = 9.97 repeats.
    expect(effectTailMs('delay', chain.args)).toBeCloseTo(996.6, 1);
  });

  it('adds the chain tail to the envelope, since the chain runs after it', () => {
    const layer = parse(doc('noise white >> verb 200ms mix 0.5 | gain 1 decay 100ms')).layers[0]!;
    expect(layerEndMs(layer)).toBeCloseTo(301, 6);
  });

  it('reports a sound that outlives its header contract', () => {
    // The helicopter's 0.88-feedback delay rings far past the declared 1500 ms.
    // Phase 3 turns this into a validation issue; phase 2 only has to see it.
    const helicopter = parse(
      'sound "h" 1500ms cycle loop\n  chop: sub 62Hz >> delay 90ms feedback 0.88 mix 1 | gain 0.55 decay 45ms\n',
    );
    expect(soundDurationMs(helicopter)).toBeGreaterThan(1500);
  });
});

/* ------------------------------------------------------------------------- *
 * Buffer generators
 * ------------------------------------------------------------------------- */

describe('buffer generators', () => {
  const rate = GLOBAL_LIMITS.sampleRate;

  it('are deterministic for a given seed', () => {
    const spec = { kind: 'noise', color: 'pink', seed: 12345, sec: 0.05 } as const;
    expect([...fillBuffer(spec, rate)]).toEqual([...fillBuffer(spec, rate)]);
  });

  it('decorrelate on a different seed', () => {
    const a = fillBuffer({ kind: 'noise', color: 'white', seed: 1, sec: 0.05 }, rate);
    const b = fillBuffer({ kind: 'noise', color: 'white', seed: 2, sec: 0.05 }, rate);
    expect([...a]).not.toEqual([...b]);
  });

  it('keep every colour inside unit peak', () => {
    for (const color of ['white', 'pink', 'brown'] as const) {
      const samples = fillBuffer({ kind: 'noise', color, seed: 99, sec: 0.5 }, rate);
      const peak = samples.reduce((worst, v) => Math.max(worst, Math.abs(v)), 0);
      expect(peak, color).toBeLessThanOrEqual(1);
      expect(peak, color).toBeGreaterThan(0.1);
    }
  });

  it('tilt the spectrum the way each colour claims', () => {
    // Mean absolute first difference falls as a noise gets darker: white jumps
    // sample to sample, brown wanders.
    const roughness = (color: 'white' | 'pink' | 'brown'): number => {
      const s = fillBuffer({ kind: 'noise', color, seed: 7, sec: 0.5 }, rate);
      let total = 0;
      for (let i = 1; i < s.length; i++) total += Math.abs((s[i] ?? 0) - (s[i - 1] ?? 0));
      return total / (s.length - 1);
    };
    expect(roughness('white')).toBeGreaterThan(roughness('pink'));
    expect(roughness('pink')).toBeGreaterThan(roughness('brown'));
  });

  it('normalize the modal bank below unit peak', () => {
    const samples = fillBuffer({ kind: 'modal', freq: 800, ratios: [1, 2.41, 3.86], q: 80, sec: 0.2 }, rate);
    const peak = samples.reduce((worst, v) => Math.max(worst, Math.abs(v)), 0);
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.3);
  });

  it('make a damped pluck decay faster than a ringing one', () => {
    const energy = (damp: number): number => {
      const s = fillBuffer({ kind: 'pluck', freq: 440, damp, bright: 0.5, seed: 3, sec: 0.3 }, rate);
      let total = 0;
      for (let i = Math.floor(s.length / 2); i < s.length; i++) total += (s[i] ?? 0) ** 2;
      return total;
    };
    expect(energy(0.9)).toBeLessThan(energy(0.1));
  });

  it('fold any seed into the generator range, zero included', () => {
    expect(normalizeSeed(0)).toBeGreaterThan(0);
    expect(normalizeSeed(-5)).toBeGreaterThan(0);
    expect(normalizeSeed(2 ** 32)).toBeLessThan(2147483647);
    // A zero seed would otherwise be absorbing and render pure silence.
    const samples = fillBuffer({ kind: 'noise', color: 'white', seed: normalizeSeed(0), sec: 0.01 }, rate);
    expect(samples.some((v) => v !== 0)).toBe(true);
  });
});

describe('waveshaper curve', () => {
  it('maps full scale to full scale, whatever the drive', () => {
    for (const drive of [0.5, 2, 10, 20]) {
      const curve = shaperCurve(drive);
      expect(curve[0], `drive ${drive}`).toBeCloseTo(-1, 6);
      expect(curve[curve.length - 1], `drive ${drive}`).toBeCloseTo(1, 6);
    }
  });

  it('passes zero through and rises monotonically', () => {
    const curve = shaperCurve(4);
    expect(curve[128]).toBeCloseTo(0, 12);
    for (let i = 1; i < curve.length; i++) expect(curve[i]!).toBeGreaterThan(curve[i - 1]!);
  });

  it('bends harder as drive rises', () => {
    // Half-scale input is pushed further up by a heavier drive.
    expect(shaperCurve(10)[192]!).toBeGreaterThan(shaperCurve(1)[192]!);
  });
});
