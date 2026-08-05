/**
 * Profile tests.
 *
 * Two halves. Synthetic signals check that each field measures what its name
 * claims — a sine is tonal, noise is not, a decay has a duration — because those
 * are the only cases where the right answer is known in advance. The reference
 * recipes then check the numbers against the sounds the project actually ships,
 * including the plan's acceptance criterion.
 */

import { describe, expect, it } from 'vitest';
import {
  CENTROID_POINTS,
  ENVELOPE_POINTS,
  SILENCE_LUFS,
  extractProfile,
  onsetIndex,
  peakOf,
  profileMarkdown,
  spanOf,
} from '../src/index.js';
import { RATE, noise, pluckedSine, renderExample, sine, withPreRoll, withTail } from './helpers/signals.js';

describe('onset detection', () => {
  /**
   * The case this algorithm exists for: a recording starts when the recorder was
   * rolling. In the project's reference pop the sound sits 125 ms behind a quiet
   * pre-roll, and a threshold-based detector aligns on the room noise instead.
   */
  it('finds a transient behind a pre-roll', () => {
    const signal = withPreRoll(pluckedSine(1000, 200), 125);
    const onsetMs = (onsetIndex(signal) / RATE) * 1000;
    expect(onsetMs).toBeGreaterThan(123);
    expect(onsetMs).toBeLessThan(127);
  });

  it('finds zero for a sound that starts immediately', () => {
    expect(onsetIndex(pluckedSine(1000, 200))).toBeLessThan(RATE / 1000);
  });

  it('survives a signal shorter than one frame', () => {
    expect(onsetIndex({ samples: new Float64Array(10).fill(0.5), sampleRate: RATE })).toBe(0);
  });

  /**
   * Regression: a sound with `attack 0ms` starts at full amplitude and contains
   * no positive rise at all, so a search that skips frame 0 finds its best rise
   * of zero inside the trailing silence every render carries — and reports the
   * onset at the end of the sound. Everything downstream then measured an empty
   * span, with no error anywhere.
   */
  it('puts the onset at zero for a sound that starts at full amplitude', () => {
    const signal = withTail(pluckedSine(1000, 120, 20), 500);
    expect(onsetIndex(signal)).toBeLessThan(RATE / 1000);
    expect(spanOf(signal).durationMs).toBeGreaterThan(100);
  });
});

describe('span', () => {
  it('reports no span for silence', () => {
    const span = spanOf({ samples: new Float64Array(RATE), sampleRate: RATE });
    expect(span).toEqual({ onset: 0, end: 0, attackMs: 0, durationMs: 0 });
  });

  it('ignores trailing silence, which the renderer always adds', () => {
    const bare = spanOf(pluckedSine(1000, 120, 20));
    const padded = spanOf(withTail(pluckedSine(1000, 120, 20), 500));
    expect(padded.durationMs).toBe(bare.durationMs);
  });
});

describe('extractProfile: synthetic signals', () => {
  it('calls a sine tonal and finds its frequency', () => {
    const profile = extractProfile(sine(1000, 300));
    expect(profile.peakHz).toBeGreaterThan(990);
    expect(profile.peakHz).toBeLessThan(1010);
    expect(profile.flatness).toBeLessThan(0.01);
    expect(profile.noiseRatio).toBeLessThan(0.05);
  });

  it('calls white noise noisy', () => {
    const profile = extractProfile(noise(300));
    expect(profile.flatness).toBeGreaterThan(0.2);
    expect(profile.noiseRatio).toBeGreaterThan(0.8);
  });

  it('separates the two by a wide margin, which is the whole point', () => {
    const tone = extractProfile(sine(1200, 300));
    const hiss = extractProfile(noise(300));
    expect(hiss.noiseRatio - tone.noiseRatio).toBeGreaterThan(0.7);
  });

  it('normalizes the envelope to a peak of exactly one', () => {
    const profile = extractProfile(pluckedSine(800, 200));
    expect(profile.rmsEnvelope).toHaveLength(ENVELOPE_POINTS);
    expect(Math.max(...profile.rmsEnvelope)).toBeCloseTo(1, 12);
    expect(profile.centroidHz).toHaveLength(CENTROID_POINTS);
  });

  it('sees a decay as front-loaded and a steady tone as flat', () => {
    const half = ENVELOPE_POINTS / 2;
    const tail = (values: readonly number[]): number =>
      values.slice(half).reduce((a, b) => a + b, 0) / values.slice(0, half).reduce((a, b) => a + b, 0);
    expect(tail(extractProfile(pluckedSine(800, 300, 30)).rmsEnvelope)).toBeLessThan(0.2);
    expect(tail(extractProfile(sine(800, 300)).rmsEnvelope)).toBeCloseTo(1, 1);
  });

  /**
   * Silence floors at {@link SILENCE_LUFS} rather than reporting `-Infinity`, and
   * that is a transport requirement, not a preference: a profile is stored in the
   * recipe bank and sent over HTTP, and `-Infinity` arrives from JSON as `null`.
   */
  it('reports level in a plausible LUFS range and floors silence', () => {
    expect(extractProfile(sine(1000, 300, 1)).loudnessLufsApprox).toBeGreaterThan(-10);
    expect(extractProfile(sine(1000, 300, 0.05)).loudnessLufsApprox).toBeLessThan(-20);

    const silence = extractProfile({ samples: new Float64Array(RATE), sampleRate: RATE });
    expect(silence.loudnessLufsApprox).toBe(SILENCE_LUFS);
    expect(JSON.parse(JSON.stringify(silence)).loudnessLufsApprox).toBe(SILENCE_LUFS);
  });

  /**
   * The invariant that makes candidate-vs-reference comparison possible at all:
   * a profile describes the sound, not where in the file it happened to sit.
   */
  it('is unchanged by pre-roll and by trailing silence', () => {
    const bare = extractProfile(pluckedSine(900, 150, 40));
    const padded = extractProfile(withTail(withPreRoll(pluckedSine(900, 150, 40), 125), 400));
    expect(padded.durationMs).toBeCloseTo(bare.durationMs, 0);
    expect(padded.peakHz).toBeCloseTo(bare.peakHz, 0);
    expect(padded.flatness).toBeCloseTo(bare.flatness, 2);
  });

  it('is deterministic', () => {
    const signal = noise(200, 12345);
    expect(extractProfile(signal)).toEqual(extractProfile(signal));
  });
});

describe('extractProfile: reference recipes', () => {
  /** The plan's phase-3 acceptance criterion. */
  it('measures bubble-pop as a transient under 60 ms', async () => {
    const profile = extractProfile(await renderExample('bubble-pop'));
    expect(profile.durationMs).toBeLessThan(60);
    expect(profile.attackMs).toBeLessThan(5);
  });

  /**
   * Recovering the number that was written in the recipe is the strongest check
   * available without a reference recording: `modal metal 2100Hz` has to come
   * back out of the spectrum as 2100 Hz.
   */
  it.each([
    ['sword-clash', 2100],
    ['coin', 1319],
    ['ui-click', 1800],
    ['helicopter', 62],
  ] as const)('recovers the written fundamental of %s', async (name, expected) => {
    const profile = extractProfile(await renderExample(name));
    expect(Math.abs(Math.log2(profile.peakHz / expected))).toBeLessThan(0.1);
  });

  it('agrees with the compiler about how long helicopter really is', async () => {
    /* `soundDurationMs` estimates 4046 ms from the text alone; the render is the
       independent measurement of the same claim. */
    const profile = extractProfile(await renderExample('helicopter'));
    expect(profile.durationMs).toBeGreaterThan(3500);
    expect(profile.durationMs).toBeLessThan(4100);
  });

  it('ranks the recipes by texture the way a listener would', async () => {
    const gravel = extractProfile(await renderExample('footstep-gravel'));
    const coin = extractProfile(await renderExample('coin'));
    expect(gravel.noiseRatio).toBeGreaterThan(0.5);
    expect(coin.noiseRatio).toBeLessThan(0.2);
  });

  it('never reports a peak louder than the render, or a negative duration', async () => {
    for (const name of ['explosion', 'laser', 'powerup', 'door-creak']) {
      const signal = await renderExample(name);
      const profile = extractProfile(signal);
      expect(profile.durationMs).toBeGreaterThan(0);
      expect(profile.peakHz).toBeGreaterThan(0);
      expect(profile.peakHz).toBeLessThan(signal.sampleRate / 2);
      expect(peakOf(signal.samples)).toBeLessThanOrEqual(1);
    }
  });
});

describe('profileMarkdown', () => {
  it('renders a table with every field a model needs', () => {
    const table = profileMarkdown('candidate', extractProfile(pluckedSine(1000, 200)));
    expect(table).toContain('| metric | candidate |');
    expect(table).toContain('dominant partial');
    expect(table.split('\n')).toHaveLength(10);
  });
});
