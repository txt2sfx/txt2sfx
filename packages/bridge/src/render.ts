/**
 * Renderer resolution: `playground` | `native` | `none`.
 *
 * `@txt2sfx/core` deliberately owns no audio stack — the offline context is a
 * parameter — so the bridge is where "can this process make samples?" is
 * actually decided. Three tiers, tried in order and re-evaluated on every call,
 * because a tab can connect at any moment and the answer the agent got a minute
 * ago is not the answer now:
 *
 * 1. a connected playground tab (preferred: the number the agent is told and
 *    the number on the human's screen come from the same render);
 * 2. `node-web-audio-api`, an **optional** dependency imported behind a guard —
 *    it is a native module, and an `npx` that fails to install on a platform
 *    with no prebuilt binary would be worse than one that renders a little
 *    less;
 * 3. none — validation, the contract and the bank still work, and anything
 *    that needs samples fails with one sentence naming which of the two to fix.
 *
 * The import failure is cached but the tier decision is not: availability of a
 * native module cannot change within a process, presence of a tab can.
 *
 * Tier 2 has two implementations of the same interface. {@link createNativeRenderer}
 * renders in this process, which is what `doctor` and the tests want — one
 * process, no channel, nothing to tear down. {@link createChildRenderer} renders
 * in a recycled subprocess, which is what the *daemon* wants, because
 * `node-web-audio-api` never frees an `OfflineAudioContext` and a long-lived
 * bridge that fits recipes would otherwise grow by roughly 100 MB per search.
 * `render-child.ts` documents the measurements and why a worker thread cannot
 * substitute for a process here.
 *
 * @packageDocumentation
 */

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { SoundAST } from '@txt2sfx/shared';
import {
  codegen,
  peakOf,
  renderSound,
  serialize,
  type OfflineContextFactory,
} from '@txt2sfx/core';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { extractProfile } from '@txt2sfx/analyzer';
import type { SoundProfile } from '@txt2sfx/shared';
import type { Log } from './log.js';
import type { Renderer } from './protocol.js';
import { RENDER_CHILD_ARG, type ChildReply, type ChildRequest } from './render-protocol.js';

/** The tier plus the reason, because `doctor` and error messages both need the why. */
export interface RendererResolution {
  readonly renderer: Renderer;
  readonly why: string;
}

/** What a native render measures. Samples are copied — see {@link createNativeRenderer}. */
export interface NativeRenderResult {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly peak: number;
  readonly clipped: boolean;
  readonly durationMs: number;
  readonly profile: SoundProfile;
  readonly bytes: number;
  readonly withinBudget: boolean;
}

/** Tier 2, behind its guard. */
export interface NativeRenderer {
  available(): Promise<boolean>;
  /** Why it is or is not available — one sentence, for `doctor`. */
  reason(): Promise<string>;
  render(ast: SoundAST, seed?: number): Promise<NativeRenderResult>;
}

/** How the module is obtained. A parameter so tests can make it fail on purpose. */
export type NativeImporter = () => Promise<{ OfflineAudioContext: new (options: {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
}) => unknown }>;

const defaultImporter: NativeImporter = () =>
  import('node-web-audio-api') as ReturnType<NativeImporter>;

/**
 * Build the guarded native renderer.
 *
 * The absence of the module must never throw at startup — a user on a platform
 * with no prebuilt binary still gets `sfx_validate`, `sfx_contract` and the
 * bank. So the import happens lazily, once, inside a catch, and the failure is
 * kept as prose instead of being rethrown.
 */
export function createNativeRenderer(importer: NativeImporter = defaultImporter): NativeRenderer {
  let probe: Promise<{ factory: OfflineContextFactory | undefined; reason: string }> | undefined;

  const load = (): NonNullable<typeof probe> => {
    probe ??= importer().then(
      (module) => ({
        factory: ((options) =>
          new module.OfflineAudioContext(options) as OfflineAudioContext) as OfflineContextFactory,
        reason: 'node-web-audio-api is installed; renders happen in-process at 44.1 kHz',
      }),
      (error: unknown) => ({
        factory: undefined,
        reason: `node-web-audio-api is not installed (${error instanceof Error ? error.message.split('\n')[0] ?? 'import failed' : 'import failed'})`,
      }),
    );
    return probe;
  };

  return {
    async available(): Promise<boolean> {
      return (await load()).factory !== undefined;
    },

    async reason(): Promise<string> {
      return (await load()).reason;
    },

    async render(ast: SoundAST, seed?: number): Promise<NativeRenderResult> {
      const { factory, reason } = await load();
      if (factory === undefined) throw new Error(reason);

      const result = await renderSound(ast, {
        context: factory,
        ...(seed === undefined ? {} : { seed }),
      });
      /* Copy out of the native buffer before anything else touches the context.
         `getChannelData` returns a view into memory the native context owns, and
         the repo learned the hard way that holding it across the next render is
         a profile full of NaN and then a process death with no JS stack. */
      const samples = Float32Array.from(result.buffer.getChannelData(0));
      const sampleRate = result.buffer.sampleRate;
      const generated = codegen(ast);

      return {
        samples,
        sampleRate,
        peak: peakOf(result.buffer),
        clipped: result.clipped,
        durationMs: result.durationMs,
        profile: extractProfile({ samples, sampleRate }),
        bytes: generated.bytes,
        withinBudget: generated.withinBudget,
      };
    },
  };
}

/* --- tier 2, in a subprocess ------------------------------------------------ */

/**
 * Renders one child is allowed before it is replaced.
 *
 * Both numbers in this trade are measured (see `render-child.ts`): a render
 * leaks ~68 KB that never comes back, and a cold child costs ~155 ms to reach
 * its first completed render. At 400 the child tops out around 27 MB before it
 * is recycled, and the respawn adds 0.39 ms to the average render — against the
 * ~10 ms the render itself takes, which is under 4%. Lower would buy a smaller
 * ceiling for a cost that starts to show; higher saves a respawn nobody notices
 * and gives the ceiling away.
 */
export const RENDER_BUDGET = 400;

/**
 * How long an idle child is kept before it is let go.
 *
 * A held child costs ~46 MB — mostly the native module — for a daemon that may
 * spend a day serving `sfx_validate` and the bank without rendering once. The
 * only thing letting it go costs is the ~155 ms cold start on the next render,
 * which is a fifth of the time that render was going to take anyway. A minute
 * is long enough that no fit ever pays it: a search renders continuously.
 */
export const IDLE_TIMEOUT_MS = 60_000;

/** Options of {@link createChildRenderer}. */
export interface ChildRendererOptions {
  /** Where to say that a child died or could not be found. */
  readonly log?: Log;
  /** Renders before a child is recycled. Defaults to {@link RENDER_BUDGET}. */
  readonly budget?: number;
  /** Idle milliseconds before the child is released. Defaults to {@link IDLE_TIMEOUT_MS}. */
  readonly idleMs?: number;
  /**
   * How a child is started. Injected for the same reason {@link NativeImporter}
   * is: a test must be able to make this fail, and to drive a child that is not
   * a real process.
   */
  readonly spawn?: () => ChildProcess;
}

/** A child-backed renderer owns a process, so it can be asked to let go of it. */
export interface ChildRenderer extends NativeRenderer {
  /** Kill the current child, if any. Idempotent; the next render starts a new one. */
  close(): void;
}

/**
 * Locate the module a child runs.
 *
 * Three shapes, in the order they are plausible, and the same approach
 * `stable-audio.ts` uses to find its Python: ask where *this* module is and
 * look beside it. The published bridge is one bundle with a second bundle next
 * to it; a `tsc` build has plain siblings; and a checkout running off
 * TypeScript sources — which is how the tests and the playground run, by
 * design — has to reach across into `dist/`, because a forked plain `node`
 * cannot execute a `.ts` file.
 */
export function childEntryPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'render-child.mjs'),
    join(here, 'render-child.js'),
    join(here, '..', 'dist', 'render-child.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

interface Pending {
  resolve(result: NativeRenderResult): void;
  reject(error: Error): void;
}

/**
 * Build the subprocess-backed renderer.
 *
 * Requests are served one at a time. Not because the child could not keep an id
 * map — it does — but because every caller already awaits its render, two
 * concurrent renders on one machine each take about twice as long, and a queue
 * of one makes recycling a decision with nothing in flight to strand.
 */
export function createChildRenderer(options: ChildRendererOptions = {}): ChildRenderer {
  const budget = options.budget ?? RENDER_BUDGET;
  const idleMs = options.idleMs ?? IDLE_TIMEOUT_MS;
  const log = options.log;

  let idle: NodeJS.Timeout | undefined;
  let child: ChildProcess | undefined;
  let ready: Promise<{ available: boolean; reason: string }> | undefined;
  let served = 0;
  let sequence = 0;
  let pending: Pending | undefined;
  /* Whatever the last child said, kept so `available()` and `reason()` can
     answer across a recycle without waiting for the replacement to boot. */
  let verdict: { available: boolean; reason: string } | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  /** Let go of the current child without forgetting what it told us. */
  const release = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = undefined;
    const dying = child;
    child = undefined;
    ready = undefined;
    served = 0;
    dying?.kill();
  };

  const touchIdle = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(release, idleMs);
    /* A pending release must never be the reason a process stays alive. */
    idle.unref();
  };

  const drop = (why: string): void => {
    const waiting = pending;
    pending = undefined;
    const dying = child;
    child = undefined;
    ready = undefined;
    served = 0;
    dying?.kill();
    waiting?.reject(new Error(why));
  };

  const start = (): Promise<{ available: boolean; reason: string }> => {
    if (ready !== undefined) return ready;

    let spawned: ChildProcess;
    try {
      if (options.spawn !== undefined) {
        spawned = options.spawn();
      } else {
        const entry = childEntryPath();
        if (entry === undefined) {
          throw new Error(
            'the render subprocess entry point is missing next to the bridge — run `pnpm --filter txt2sfx-bridge build`, or reinstall txt2sfx-bridge',
          );
        }
        spawned = fork(entry, [RENDER_CHILD_ARG], {
          /* `advanced` is structured clone: it moves a Float32Array as bytes
             instead of a JSON array of ten thousand numbers, measured at 0.30 ms
             per round trip against 3.16 ms. Getting this wrong does not throw —
             JSON turns the samples into `{"0":0.1,…}` and the profile downstream
             is quietly garbage — so it is not a default worth relying on. */
          serialization: 'advanced',
          /* Not inherited: a bridge started under `--inspect` would hand the
             child the same fixed debug port and the child would die unable to
             bind it. Nothing here is worth debugging through the parent's flags. */
          execArgv: [],
          /* stdout is deliberately not inherited. In `--stdio` mode the parent's
             stdout carries JSON-RPC, and one stray line from a child would be
             indistinguishable from a malformed frame. stderr is inherited so a
             native-module crash still says something. */
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      verdict = { available: false, reason: message };
      return Promise.resolve(verdict);
    }

    child = spawned;
    served = 0;

    spawned.on('message', (reply: ChildReply) => {
      if (reply.t === 'ready') {
        verdict = { available: reply.available, reason: reply.reason };
        return;
      }
      const waiting = pending;
      if (waiting === undefined) return; // a late answer names no one to blame
      pending = undefined;
      if (reply.t === 'rendered') waiting.resolve(reply.result);
      else waiting.reject(new Error(reply.message));
    });

    /* A child that dies mid-render must fail *that* render rather than leave the
       caller waiting on a process that is gone. The next call starts a new one:
       a crash is not a reason to lose the renderer for the life of the daemon. */
    spawned.on('exit', (code, signal) => {
      if (child !== spawned) return; // a recycle we asked for
      log?.(`render subprocess exited (${signal ?? `code ${String(code)}`}); the next render starts a new one`);
      drop('the render subprocess exited before answering');
    });
    spawned.on('error', (error: Error) => {
      if (child !== spawned) return;
      log?.(`render subprocess failed: ${error.message}`);
      drop(error.message);
    });

    ready = new Promise((resolve) => {
      const onReady = (reply: ChildReply): void => {
        if (reply.t !== 'ready') return;
        spawned.off('message', onReady);
        resolve({ available: reply.available, reason: reply.reason });
      };
      spawned.on('message', onReady);
      spawned.once('exit', () => {
        resolve(verdict ?? { available: false, reason: 'the render subprocess exited before it was ready' });
      });
      spawned.once('error', (error: Error) => {
        resolve({ available: false, reason: error.message });
      });
    });
    return ready;
  };

  const renderOnce = async (ast: SoundAST, seed?: number): Promise<NativeRenderResult> => {
    if (child !== undefined && served >= budget) {
      /* Recycling is the whole point of this renderer, so it is not conditional
         on anything the caller did. Nothing is in flight — the queue is one. */
      release();
    }
    touchIdle();

    const state = await start();
    if (!state.available || child === undefined) throw new Error(state.reason);

    const request: ChildRequest = {
      id: ++sequence,
      source: serialize(ast),
      ...(seed === undefined ? {} : { seed }),
    };
    served++;
    const target = child;
    return new Promise<NativeRenderResult>((resolve, reject) => {
      pending = { resolve, reject };
      target.send(request, (error) => {
        if (error === null) return;
        pending = undefined;
        reject(new Error(`could not reach the render subprocess: ${error.message}`));
      });
    });
  };

  /**
   * What the tier is, spawning only if nobody has ever asked.
   *
   * The cached answer survives a recycle and an idle release deliberately:
   * whether a native module imports cannot change within a process — the
   * module note above says so, and the in-process renderer caches on the same
   * ground. Without this, `GET /health` resolves the tier on every poll and a
   * monitored daemon would hold a child forever for renders nobody asked for.
   */
  const verdictOf = async (): Promise<{ available: boolean; reason: string }> =>
    verdict ?? (await start());

  const renderer: ChildRenderer = {
    async available(): Promise<boolean> {
      return (await verdictOf()).available;
    },

    async reason(): Promise<string> {
      return (await verdictOf()).reason;
    },

    render(ast: SoundAST, seed?: number): Promise<NativeRenderResult> {
      /* Serialize through a chain rather than a lock flag: a rejected render
         must not wedge the queue, so every link settles either way. */
      const next = queue.then(
        () => renderOnce(ast, seed),
        () => renderOnce(ast, seed),
      );
      queue = next.catch(() => undefined);
      return next;
    },

    close(): void {
      release();
    },
  };

  /* A forked child is not collected when its parent goes away, and a bridge is
     usually stopped with a signal rather than a clean shutdown path. */
  process.once('exit', () => {
    child?.kill();
  });

  return renderer;
}

/** Sanity export for callers that report against the budget. */
export const MAX_PEAK = GLOBAL_LIMITS.maxPeak;

/** Pick the tier. Called per tool call, never cached — see the module note. */
export async function resolveRenderer(
  playgroundConnected: boolean,
  native: NativeRenderer,
): Promise<RendererResolution> {
  if (playgroundConnected) {
    return {
      renderer: 'playground',
      why: 'a playground tab is connected; renders happen in its OfflineAudioContext',
    };
  }
  if (await native.available()) {
    return { renderer: 'native', why: await native.reason() };
  }
  return {
    renderer: 'none',
    why: `no playground tab is connected and ${await native.reason()}`,
  };
}
