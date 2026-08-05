/**
 * Distance tests.
 *
 * A metric is only useful if it is zero on identity, symmetric, and orders
 * things the way a listener would. The third is the one that actually matters
 * and the only one that cannot be proved — so it is tested against the reference
 * recipes, where the intended ordering is known from what the sounds are.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE_WEIGHTS,
  alignAndNormalize,
  extractProfile,
  profileDistance,
  profileDistanceParts,
  soundDistance,
  stftDistance,
} from '../src/index.js';
import { RATE, noise, pluckedSine, renderExample, sine, withPreRoll } from './helpers/signals.js';

describe('profileDistance', () => {
  it('is zero on identity and symmetric', () => {
    const a = extractProfile(pluckedSine(900, 200));
    const b = extractProfile(noise(200));
    expect(profileDistance(a, a)).toBe(0);
    expect(profileDistance(a, b)).toBeCloseTo(profileDistance(b, a), 12);
  });

  it('stays inside 0..1 for unrelated sounds', () => {
    const a = extractProfile(sine(80, 2000));
    const b = extractProfile(noise(30));
    const distance = profileDistance(a, b);
    expect(distance).toBeGreaterThan(0.2);
    expect(distance).toBeLessThanOrEqual(1);
  });

  it('weights sum to one, so the total is on the same scale as its parts', () => {
    const sum = Object.values(DEFAULT_PROFILE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it('measures pitch in octaves, not hertz', () => {
    /* 200 -> 400 Hz and 2000 -> 4000 Hz are the same interval and must cost the
       same, or the optimizer spends its whole budget in the treble. */
    const low = profileDistanceParts(extractProfile(sine(200, 300)), extractProfile(sine(400, 300)));
    const high = profileDistanceParts(extractProfile(sine(2000, 300)), extractProfile(sine(4000, 300)));
    expect(low.peakHz).toBeCloseTo(high.peakHz, 2);
  });

  it('treats a zero attack as a legitimate value rather than a singularity', () => {
    const parts = profileDistanceParts(
      { ...extractProfile(pluckedSine(900, 200)), attackMs: 0 },
      { ...extractProfile(pluckedSine(900, 200)), attackMs: 1 },
    );
    expect(Number.isFinite(parts.attack)).toBe(true);
    expect(parts.attack).toBeLessThan(0.5);
  });

  it('handles silence, which reports -Infinity loudness', () => {
    const silent = extractProfile({ samples: new Float64Array(RATE), sampleRate: RATE });
    const real = extractProfile(pluckedSine(900, 200));
    expect(Number.isFinite(profileDistance(silent, real))).toBe(true);
  });
});

describe('alignAndNormalize', () => {
  /**
   * The reason alignment is not optional: a reference recording starts when the
   * recorder was rolling. Two copies of one sound, one of them behind 125 ms of
   * silence, have to come out on the same time base.
   */
  it('lines up two copies of a sound that start at different times', () => {
    const bare = pluckedSine(1000, 200, 40);
    const pair = alignAndNormalize(bare, withPreRoll(bare, 125));
    expect(pair.onsetB - pair.onsetA).toBeGreaterThan((120 / 1000) * RATE);
    expect(pair.a).toHaveLength(pair.b.length);
  });

  it('matches peaks when asked and leaves them alone when not', () => {
    const loud = pluckedSine(1000, 200);
    const quiet = { ...loud, samples: Float64Array.from(loud.samples, (v) => v * 0.1) };
    const normalized = alignAndNormalize(loud, quiet);
    expect(Math.max(...normalized.a)).toBeCloseTo(Math.max(...normalized.b), 6);
    const raw = alignAndNormalize(loud, quiet, false);
    expect(Math.max(...raw.a) / Math.max(...raw.b)).toBeCloseTo(10, 1);
  });

  it('refuses to compare two different sample rates instead of resampling silently', () => {
    expect(() => alignAndNormalize(sine(1000, 100), sine(1000, 100, 0.8, 48000))).toThrow(/sample rates differ/);
  });
});

describe('stftDistance', () => {
  it('is zero on identity', () => {
    const signal = pluckedSine(900, 200);
    expect(stftDistance(signal, signal)).toBe(0);
  });

  it('is near zero for the same sound behind a pre-roll', () => {
    const bare = pluckedSine(900, 200, 40);
    const shifted = withPreRoll(bare, 125);
    const same = stftDistance(bare, shifted);
    const different = stftDistance(bare, noise(200));
    expect(same).toBeLessThan(0.1);
    expect(same * 3).toBeLessThan(different);
  });

  it('ignores a constant level difference, which alignment normalizes away', () => {
    const loud = pluckedSine(900, 200);
    const quiet = { ...loud, samples: Float64Array.from(loud.samples, (v) => v * 0.25) };
    expect(stftDistance(loud, quiet)).toBeLessThan(0.02);
  });

  it('hears a partial in the wrong place', () => {
    expect(stftDistance(sine(1000, 300), sine(1400, 300))).toBeGreaterThan(0.15);
  });

  it('survives a signal too short for the largest window', () => {
    const tiny = pluckedSine(2000, 3, 1);
    expect(Number.isFinite(stftDistance(tiny, tiny))).toBe(true);
  });
});

describe('soundDistance on the reference recipes', () => {
  it('ranks a pop closer to a ui click than to an explosion', async () => {
    const pop = await renderExample('bubble-pop');
    const click = await renderExample('ui-click');
    const explosion = await renderExample('explosion');
    const of = (signal: Awaited<ReturnType<typeof renderExample>>) => ({
      signal,
      profile: extractProfile(signal),
    });

    const near = soundDistance(of(pop), of(click));
    const far = soundDistance(of(pop), of(explosion));
    expect(near).toBeLessThan(far);
  });

  it('is zero for a recipe against itself, which is the fitness floor', async () => {
    const signal = await renderExample('laser');
    const laser = { signal, profile: extractProfile(signal) };
    expect(soundDistance(laser, laser)).toBe(0);
  });
});
