/**
 * Test signals and the audio plumbing the analyzer tests need.
 *
 * `node-web-audio-api` is reached only from here, and only to render the
 * reference recipes through `@txt2sfx/core` — the analyzer itself never touches
 * an audio stack. The dependency direction stays one-way: analyzer tests may use
 * core's public API, core knows nothing about the analyzer.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OfflineAudioContext as NodeOfflineAudioContext } from 'node-web-audio-api';
import { GLOBAL_LIMITS } from '@txt2sfx/shared';
import { parse, renderSound } from '@txt2sfx/core';
import type { Signal } from '../../src/index.js';

const EXAMPLES_DIR = fileURLToPath(new URL('../../../../examples', import.meta.url));

/**
 * Sample rate every test signal uses: the project's own.
 *
 * Widened to `number` on purpose — `GLOBAL_LIMITS` is `as const`, and inheriting
 * the literal type `44100` would make it impossible to build a test signal at any
 * other rate, which is exactly what the rate-mismatch tests need to do.
 */
export const RATE: number = GLOBAL_LIMITS.sampleRate;

/**
 * Render one `examples/*.soundline` recipe and return it as a {@link Signal}.
 *
 * The samples are **copied** out of the `AudioBuffer`. `getChannelData` returns a
 * view into memory the native context owns, and a test that holds two or three
 * signals while more renders happen can outlive the contexts that produced them —
 * at which point the samples turn to NaN under the view and, given enough
 * renders, the process dies without a JavaScript stack.
 */
export async function renderExample(name: string): Promise<Signal> {
  const source = readFileSync(`${EXAMPLES_DIR}/${name}.soundline`, 'utf8').replace(/\r\n/g, '\n');
  const result = await renderSound(parse(source), {
    context: (options) => new NodeOfflineAudioContext(options) as unknown as OfflineAudioContext,
  });
  return {
    samples: Float32Array.from(result.buffer.getChannelData(0)),
    sampleRate: result.buffer.sampleRate,
  };
}

/** MINSTD, the same generator the synthesis engine uses. Deterministic noise. */
export function noise(durationMs: number, seed = 1, sampleRate = RATE): Signal {
  const count = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float64Array(count);
  let state = seed;
  for (let i = 0; i < count; i++) {
    state = (state * 16807) % 2147483647;
    samples[i] = (state / 2147483647) * 2 - 1;
  }
  return { samples, sampleRate };
}

/** A steady sine. */
export function sine(freqHz: number, durationMs: number, amplitude = 0.8, sampleRate = RATE): Signal {
  const count = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return { samples, sampleRate };
}

/** A sine under an exponential decay — the shape of most one-shot SFX. */
export function pluckedSine(
  freqHz: number,
  durationMs: number,
  decayMs = durationMs / 3,
  sampleRate = RATE,
): Signal {
  const count = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float64Array(count);
  const tau = (decayMs / 1000) * sampleRate;
  for (let i = 0; i < count; i++) {
    samples[i] = 0.9 * Math.exp(-i / tau) * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return { samples, sampleRate };
}

/** Prepend silence, the way a recording carries pre-roll before the sound. */
export function withPreRoll(signal: Signal, silenceMs: number): Signal {
  const pad = Math.round((silenceMs / 1000) * signal.sampleRate);
  const samples = new Float64Array(pad + signal.samples.length);
  for (let i = 0; i < signal.samples.length; i++) samples[pad + i] = signal.samples[i] ?? 0;
  return { samples, sampleRate: signal.sampleRate };
}

/** Append silence, the way the renderer pads a buffer after the sound. */
export function withTail(signal: Signal, silenceMs: number): Signal {
  const pad = Math.round((silenceMs / 1000) * signal.sampleRate);
  const samples = new Float64Array(signal.samples.length + pad);
  for (let i = 0; i < signal.samples.length; i++) samples[i] = signal.samples[i] ?? 0;
  return { samples, sampleRate: signal.sampleRate };
}
