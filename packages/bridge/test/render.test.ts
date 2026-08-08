/**
 * Renderer resolution: the three tiers, and above all the graceful floor —
 * a missing native module must cost features, never a startup.
 *
 * The subprocess renderer is tested through an injected spawn rather than a
 * real fork, for the reason the injected importer exists: the interesting
 * cases are a child that never becomes available, a child that dies holding a
 * render, and the recycle — none of which a real process would produce on
 * demand. One test does fork the real thing, and it is the one that matters
 * most: a render must not change because it crossed a process boundary.
 */

import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from '@txt2sfx/core';
import {
  childEntryPath,
  createChildRenderer,
  createNativeRenderer,
  resolveRenderer,
} from '../src/index.js';
import type { ChildReply, ChildRequest } from '../src/index.js';

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

/* --- the subprocess renderer --------------------------------------------- */

const TICK = 'sound "tick" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n';

/** A child that speaks the protocol without being a process. */
class FakeChild extends EventEmitter {
  readonly seen: ChildRequest[] = [];
  killed = false;

  constructor(private readonly behaviour: { available: boolean; reason: string; die?: boolean }) {
    super();
    setTimeout(() => {
      this.emit('message', {
        t: 'ready',
        available: behaviour.available,
        reason: behaviour.reason,
      } satisfies ChildReply);
    }, 0);
  }

  send(message: ChildRequest, callback?: (error: Error | null) => void): boolean {
    this.seen.push(message);
    callback?.(null);
    setTimeout(() => {
      if (this.behaviour.die === true) {
        this.emit('exit', null, 'SIGKILL');
        return;
      }
      this.emit('message', {
        t: 'rendered',
        id: message.id,
        result: {
          samples: new Float32Array([0.5, -0.5]),
          sampleRate: 44100,
          peak: 0.5,
          clipped: false,
          durationMs: 45,
          profile: {} as never,
          bytes: 300,
          withinBudget: true,
        },
      } satisfies ChildReply);
    }, 0);
    return true;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe('the subprocess renderer', () => {
  it('carries the child’s optional-dependency verdict as its own', async () => {
    const renderer = createChildRenderer({
      spawn: () =>
        new FakeChild({
          available: false,
          reason: 'node-web-audio-api is not installed (no prebuilt binary for haiku-os)',
        }) as unknown as ChildProcess,
    });
    await expect(renderer.available()).resolves.toBe(false);
    await expect(renderer.reason()).resolves.toContain('not installed');
    /* The same sentence a model reads from tier 3, not "channel closed". */
    await expect(renderer.render(parse(TICK))).rejects.toThrow('not installed');
  });

  it('reports a missing entry point as the reason instead of throwing', async () => {
    const renderer = createChildRenderer({
      spawn: () => {
        throw new Error('the render subprocess entry point is missing next to the bridge');
      },
    });
    await expect(renderer.available()).resolves.toBe(false);
    await expect(renderer.reason()).resolves.toContain('entry point is missing');
  });

  it('sends canonical source, not an AST', async () => {
    const children: FakeChild[] = [];
    const renderer = createChildRenderer({
      spawn: () => {
        const child = new FakeChild({ available: true, reason: 'ok' });
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });
    await renderer.render(parse(TICK), 7);
    const request = children[0]?.seen[0];
    expect(request?.source).toContain('sound "tick"');
    expect(request?.seed).toBe(7);
    renderer.close();
  });

  it('recycles the child once its budget is spent', async () => {
    const children: FakeChild[] = [];
    const renderer = createChildRenderer({
      budget: 2,
      spawn: () => {
        const child = new FakeChild({ available: true, reason: 'ok' });
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });
    const ast = parse(TICK);
    for (let i = 0; i < 5; i++) await renderer.render(ast);
    /* Five renders at two apiece: the first two children are spent and killed,
       the third is still serving. Recycling is the whole point of this tier. */
    expect(children).toHaveLength(3);
    expect(children[0]?.killed).toBe(true);
    expect(children[1]?.killed).toBe(true);
    expect(children[2]?.killed).toBe(false);
    renderer.close();
    expect(children[2]?.killed).toBe(true);
  });

  it('fails the render a dying child was holding, then serves the next one', async () => {
    let dying = true;
    const renderer = createChildRenderer({
      spawn: () => {
        const child = new FakeChild({ available: true, reason: 'ok', die: dying });
        dying = false;
        return child as unknown as ChildProcess;
      },
    });
    const ast = parse(TICK);
    await expect(renderer.render(ast)).rejects.toThrow('render subprocess exited');
    /* A crash costs one render, never the renderer for the life of the daemon. */
    await expect(renderer.render(ast)).resolves.toMatchObject({ peak: 0.5 });
    renderer.close();
  });

  it('answers availability from cache instead of holding a child for it', async () => {
    let spawns = 0;
    const renderer = createChildRenderer({
      spawn: () => {
        spawns++;
        return new FakeChild({ available: true, reason: 'ok' }) as unknown as ChildProcess;
      },
    });
    await renderer.available();
    renderer.close();
    /* `GET /health` resolves the tier on every poll. If that re-spawned, a
       monitored daemon would hold a render child forever having rendered once. */
    for (let i = 0; i < 5; i++) await renderer.available();
    expect(spawns).toBe(1);
  });

  it('lets an idle child go, and starts a new one when work returns', async () => {
    const children: FakeChild[] = [];
    const renderer = createChildRenderer({
      idleMs: 20,
      spawn: () => {
        const child = new FakeChild({ available: true, reason: 'ok' });
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });
    const ast = parse(TICK);
    await renderer.render(ast);
    expect(children).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(children[0]?.killed).toBe(true);
    await renderer.render(ast);
    expect(children).toHaveLength(2);
    renderer.close();
  });

  it('renders exactly what the in-process tier renders', async () => {
    const inProcess = createNativeRenderer();
    if (!(await inProcess.available())) return;
    if (childEntryPath() === undefined) return; // a source checkout that has not built yet

    const child = createChildRenderer();
    if (!(await child.available())) return;
    const ast = parse(TICK);
    const here = await inProcess.render(ast, 4242);
    const there = await child.render(ast, 4242);
    child.close();

    /* Byte-identical, not "close enough". The process boundary is transport;
       if it could change a sample the export could not be trusted either. */
    expect(there.sampleRate).toBe(here.sampleRate);
    expect(there.peak).toBe(here.peak);
    expect(there.durationMs).toBe(here.durationMs);
    expect(there.bytes).toBe(here.bytes);
    expect(Array.from(there.samples)).toEqual(Array.from(here.samples));
  });
});
