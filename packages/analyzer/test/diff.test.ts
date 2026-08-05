/**
 * Diff tests.
 *
 * These strings are an interface, not a nicety: the agent loop pastes them into
 * a prompt and the model edits the soundline from them. So the tests check the
 * things a consumer depends on — that a directive names a direction, that it
 * names a layer when the AST is available, that identical sounds produce nothing,
 * and that the worst problem is first.
 */

import { describe, expect, it } from 'vitest';
import type { SoundProfile } from '@txt2sfx/shared';
import { parse } from '@txt2sfx/core';
import { diffMarkdown, extractProfile, humanReadableDiff } from '../src/index.js';
import { noise, pluckedSine, renderExample, sine } from './helpers/signals.js';

/** A profile with every field at a neutral value, to vary one at a time. */
const base: SoundProfile = {
  durationMs: 100,
  attackMs: 8,
  rmsEnvelope: Array.from({ length: 64 }, (_, i) => 1 - i / 64),
  centroidHz: Array.from({ length: 32 }, () => 2000),
  flatness: 0.2,
  noiseRatio: 0.4,
  peakHz: 1000,
  loudnessLufsApprox: -18,
};

const withField = (patch: Partial<SoundProfile>): SoundProfile => ({ ...base, ...patch });

describe('thresholds', () => {
  it('says nothing about a sound that already matches', () => {
    expect(humanReadableDiff(base, base)).toEqual([]);
  });

  it('says nothing about differences too small to act on', () => {
    expect(humanReadableDiff(withField({ durationMs: 103, peakHz: 1010 }), base)).toEqual([]);
  });
});

describe('directives', () => {
  /** The plan's own example of the shape these strings take. */
  it('phrases an attack difference as an instruction', () => {
    const lines = humanReadableDiff(withField({ attackMs: 45 }), withField({ attackMs: 8 }));
    expect(lines[0]).toBe('attack is 45ms, target 8ms — shorten the gain ramp');
  });

  it('reverses the instruction when the error reverses', () => {
    const lines = humanReadableDiff(withField({ attackMs: 1 }), withField({ attackMs: 40 }));
    expect(lines[0]).toContain('lengthen the gain ramp');
  });

  it('tells a too-long sound what to shorten', () => {
    const lines = humanReadableDiff(withField({ durationMs: 400 }), base);
    expect(lines.some((line) => line.includes('duration is 400ms, target 100ms'))).toBe(true);
    expect(lines.some((line) => line.includes('shorten the layer decays'))).toBe(true);
  });

  it('names the direction to move a filter', () => {
    const dull = withField({ centroidHz: Array.from({ length: 32 }, () => 1200) });
    const bright = withField({ centroidHz: Array.from({ length: 32 }, () => 3400) });
    const lines = humanReadableDiff(dull, bright);
    expect(lines.some((line) => line.includes('centroid 1.2kHz vs 3.4kHz — raise'))).toBe(true);
  });

  /**
   * With an AST the directive can name the layer and the effect, which is the
   * difference between a model editing the right line and a model guessing.
   */
  it('names the layer whose filter should move', () => {
    const ast = parse(
      'sound "pop" 55ms pop\n' +
        '  body: tone tri 700Hz | gain 0.8 decay 38ms\n' +
        '  snap: noise white >> bp 1300Hz Q6 | gain 0.7 decay 18ms\n',
    );
    const dull = withField({ centroidHz: Array.from({ length: 32 }, () => 1200) });
    const bright = withField({ centroidHz: Array.from({ length: 32 }, () => 3400) });
    const lines = humanReadableDiff(dull, bright, ast);
    expect(lines.some((line) => line.includes("raise bp frequency in layer 'snap'"))).toBe(true);
  });

  it('falls back to a generic instruction with no AST to name', () => {
    const dull = withField({ centroidHz: Array.from({ length: 32 }, () => 1200) });
    const bright = withField({ centroidHz: Array.from({ length: 32 }, () => 3400) });
    expect(humanReadableDiff(dull, bright).some((line) => line.includes('the layer carrying the texture'))).toBe(true);
  });

  it('explains why a wrong dominant partial matters', () => {
    const lines = humanReadableDiff(withField({ peakHz: 97 }), withField({ peakHz: 1055 }));
    expect(lines[0]).toContain('dominant partial 97Hz vs 1.1kHz — raise the source frequency');
    expect(lines[0]).toContain('wrong object');
  });

  it('distinguishes too tonal from too noisy', () => {
    expect(humanReadableDiff(withField({ flatness: 0.02 }), withField({ flatness: 0.5 }))[0]).toContain('too tonal');
    expect(humanReadableDiff(withField({ flatness: 0.5 }), withField({ flatness: 0.02 }))[0]).toContain('too noisy');
  });

  it('reports the level error against the loudest layer', () => {
    const ast = parse(
      'sound "pop" 55ms pop\n' +
        '  quiet: tone tri 700Hz | gain 0.2 decay 38ms\n' +
        '  loud: tone tri 900Hz | gain 0.9 decay 30ms\n',
    );
    const lines = humanReadableDiff(withField({ loudnessLufsApprox: -30 }), base, ast);
    expect(lines.some((line) => line.includes("quieter than the target — adjust gain in layer 'loud'"))).toBe(true);
  });

  it('reports envelope shape, which duration and attack can both hide', () => {
    /* Same duration, same attack, energy in the other half of the span. */
    const front = withField({ rmsEnvelope: Array.from({ length: 64 }, (_, i) => (i < 32 ? 1 : 0.02)) });
    const back = withField({ rmsEnvelope: Array.from({ length: 64 }, (_, i) => (i < 32 ? 0.3 : 0.9)) });
    expect(humanReadableDiff(front, back).some((line) => line.includes('energy sits too early'))).toBe(true);
    expect(humanReadableDiff(back, front).some((line) => line.includes('energy sits too late'))).toBe(true);
  });
});

describe('ordering', () => {
  it('puts the worst problem first', () => {
    /* A wrong dominant partial outweighs a small level error. */
    const lines = humanReadableDiff(
      withField({ peakHz: 120, loudnessLufsApprox: -21 }),
      withField({ peakHz: 1000, loudnessLufsApprox: -18 }),
    );
    expect(lines[0]).toContain('dominant partial');
  });
});

describe('on real renders', () => {
  it('describes a tone asked to become noise', async () => {
    const lines = humanReadableDiff(extractProfile(sine(1000, 200)), extractProfile(noise(200)));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((line) => line.includes('too tonal') || line.includes('broadband'))).toBe(true);
  });

  it('has nothing to say about a recipe compared with itself', async () => {
    const profile = extractProfile(await renderExample('coin'));
    expect(humanReadableDiff(profile, profile)).toEqual([]);
  });

  it('tells a pop rendered as a thud to raise its pitch', async () => {
    /* The project's own reference mistake: energy at 97 Hz instead of ~1 kHz. */
    const thud = extractProfile(pluckedSine(97, 40, 12));
    const pop = extractProfile(await renderExample('bubble-pop'));
    expect(humanReadableDiff(thud, pop)[0]).toContain('raise the source frequency');
  });
});

describe('diffMarkdown', () => {
  it('numbers the directives', () => {
    const lines = humanReadableDiff(withField({ attackMs: 45, durationMs: 400 }), base);
    const markdown = diffMarkdown(lines);
    expect(markdown.split('\n')).toHaveLength(lines.length);
    expect(markdown.startsWith('1. ')).toBe(true);
  });

  it('says so when there is nothing to report', () => {
    expect(diffMarkdown([])).toBe('No significant differences.');
  });
});
