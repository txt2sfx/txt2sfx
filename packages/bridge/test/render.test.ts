/**
 * Renderer resolution: the three tiers, and above all the graceful floor —
 * a missing native module must cost features, never a startup.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@txt2sfx/core';
import { createNativeRenderer, resolveRenderer } from '../src/index.js';

const broken = createNativeRenderer(() => Promise.reject(new Error('No prebuilt binary for haiku-os')));

describe('the guarded import', () => {
  it('degrades to unavailable instead of throwing', async () => {
    await expect(broken.available()).resolves.toBe(false);
    await expect(broken.reason()).resolves.toContain('not installed');
  });

  it('refuses to render with the reason as the message', async () => {
    const ast = parse('sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n');
    await expect(broken.render(ast)).rejects.toThrow('not installed');
  });
});

describe('tier resolution, re-evaluated per call', () => {
  it('prefers a connected playground over everything', async () => {
    const resolution = await resolveRenderer(true, broken);
    expect(resolution.renderer).toBe('playground');
    expect(resolution.why).toContain('OfflineAudioContext');
  });

  it('falls to none with a why naming both fixes when nothing is available', async () => {
    const resolution = await resolveRenderer(false, broken);
    expect(resolution.renderer).toBe('none');
    expect(resolution.why).toContain('no playground tab is connected');
    expect(resolution.why).toContain('node-web-audio-api');
  });

  it('uses the real native module when it is installed', async () => {
    /* The workspace installs node-web-audio-api (optional dep), so the default
       importer succeeds here — the test that it *renders* lives in tools. */
    const native = createNativeRenderer();
    if (!(await native.available())) return; // a platform with no prebuilt binary is exactly the degradation case
    const resolution = await resolveRenderer(false, native);
    expect(resolution.renderer).toBe('native');
    expect(resolution.why).toContain('in-process');
  });
});

describe('a native render', () => {
  it('measures and copies out of the native buffer', async () => {
    const native = createNativeRenderer();
    if (!(await native.available())) return;
    const ast = parse('sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n');
    const result = await native.render(ast, 4242);
    expect(result.peak).toBeGreaterThan(0.1);
    expect(result.clipped).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(45);
    expect(result.bytes).toBeGreaterThan(100);
    expect(result.profile.peakHz).toBeGreaterThan(1000);
    /* A copy, not a view: still finite after another render on the same module. */
    await native.render(ast, 1);
    expect(Number.isFinite(result.samples[100] ?? NaN)).toBe(true);
  });
});
