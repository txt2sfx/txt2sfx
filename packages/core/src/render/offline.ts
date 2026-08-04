/**
 * Offline rendering: a soundline in, an `AudioBuffer` out.
 *
 * ## Why the context is injected
 *
 * `@txt2sfx/core` must not depend on `node-web-audio-api`. A browser has
 * `OfflineAudioContext` natively; Node does not, and pulling a native module into
 * the core package would make the parser — which is pure text handling — refuse
 * to install on any platform the module has no prebuilt binary for. So the
 * factory is a parameter: the playground passes the global constructor, the test
 * suite and the future bench pass `node-web-audio-api` as a devDependency.
 *
 * @packageDocumentation
 */

import type { SoundAST } from '@txt2sfx/shared';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { compileToIR, type CompileOptions } from '../compile/compile.js';
import { instantiate } from '../compile/graph.js';
import type { AudioIR } from '../compile/ir.js';

/** Arguments of an `OfflineAudioContext` constructor. */
export interface OfflineContextOptions {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
}

/**
 * Anything that can produce an `OfflineAudioContext`.
 *
 * In a browser: `(o) => new OfflineAudioContext(o)`.
 */
export type OfflineContextFactory = (options: OfflineContextOptions) => OfflineAudioContext;

/** Options of {@link renderSound}. */
export interface RenderOptions extends CompileOptions {
  /** How to obtain an offline context. Required — see the module note. */
  readonly context: OfflineContextFactory;
  /** Defaults to `GLOBAL_LIMITS.sampleRate` (44100). */
  readonly sampleRate?: number;
  /**
   * Silence appended after the sound, in milliseconds.
   *
   * A small pad keeps the analyzer's decay measurement from running into the end
   * of the buffer and reporting a truncated tail as a fast decay.
   */
  readonly padMs?: number;
}

/** Outcome of a render. */
export interface RenderResult {
  readonly buffer: AudioBuffer;
  /** The graph that was rendered — timings, buffers, node count. */
  readonly ir: AudioIR;
  /** Largest absolute sample value across all channels. */
  readonly peak: number;
  /** Whether {@link peak} exceeds `GLOBAL_LIMITS.maxPeak`. */
  readonly clipped: boolean;
  /** Length of the rendered buffer, in milliseconds, pad included. */
  readonly durationMs: number;
}

/** Default trailing silence. */
export const DEFAULT_PAD_MS = 50;

/** Largest absolute sample value in a buffer. */
export function peakOf(buffer: AudioBuffer): number {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      const value = Math.abs(data[i] ?? 0);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

/**
 * Render a parsed sound.
 *
 * The result is reported, never repaired: when the mix clips, `clipped` is true
 * and the samples are left as they came out. Normalizing here would hide the
 * problem in the one place it can still be fixed properly — the soundline —
 * and would make the layer gains a lie.
 */
export async function renderSound(ast: SoundAST, options: RenderOptions): Promise<RenderResult> {
  const sampleRate = options.sampleRate ?? GLOBAL_LIMITS.sampleRate;
  const padMs = options.padMs ?? DEFAULT_PAD_MS;
  const ir = compileToIR(ast, options);
  const length = Math.max(1, Math.ceil((ir.durationSec + padMs / 1000) * sampleRate));

  const ctx = options.context({ numberOfChannels: 1, length, sampleRate });
  instantiate(ctx, ir);
  const buffer = await ctx.startRendering();
  const peak = peakOf(buffer);

  return {
    buffer,
    ir,
    peak,
    clipped: peak > GLOBAL_LIMITS.maxPeak,
    durationMs: (buffer.length / buffer.sampleRate) * 1000,
  };
}
