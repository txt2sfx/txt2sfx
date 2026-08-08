/**
 * The server renders what it is asked to store.
 *
 * ## Why this exists, and why it is the anti-spam mechanism
 *
 * The bank used to take the acoustic profile on trust — the header of
 * `routes/recipes.ts` said as much, because there was no audio stack here. There is
 * one now, and turning it on changes three things at once:
 *
 * 1. **The profile cannot be forged.** It was the one field arriving on trust, and a
 *    recipe stored with an invented profile poisons every distance computed against
 *    it later, with nothing downstream able to tell why.
 * 2. **Nothing that is not a sound can be posted.** A recipe has to parse, validate
 *    *and* produce audible samples. There is no field in this system a spammer can
 *    put a message into: the name and prompt are short and searchable, and the body
 *    is a DSL that either compiles or is refused.
 * 3. **A write costs real work.** Not a captcha and not proof-of-work — the cost is
 *    the thing the service is for. An honest author pays it once per sound; a flood
 *    pays it per attempt, in front of a rate limiter that already said no.
 *
 * ## Why the DoS surface is small
 *
 * The compiler caps a render at `DEFAULT_MAX_DURATION_MS` (5 s) and the validator
 * caps layers at `GLOBAL_LIMITS.maxLayers`, so the work per request is bounded
 * before it starts — there is no soundline that renders for a minute. What is left
 * is pile-up: many bounded renders at once still exhaust the CPU of a small box. So
 * renders queue through {@link renderQueue} with a small width, and the rate limiter
 * runs *before* the queue, not behind it.
 *
 * A timeout is deliberately absent. `startRendering` is native and cannot be
 * cancelled from JavaScript, so a timeout would free the request and leave the work
 * running — the appearance of a limit and none of the effect. The bound is the
 * compiler's duration ceiling, which is real.
 *
 * @packageDocumentation
 */

import { OfflineAudioContext as NodeOfflineAudioContext } from 'node-web-audio-api';
import type { SoundAST, SoundProfile } from '@txt2sfx/shared';
import { renderSound } from '@txt2sfx/core';
import { extractProfile } from '@txt2sfx/analyzer';

/**
 * Render one AST and measure it.
 *
 * Note the copy out of the `AudioBuffer`: `getChannelData` returns a view into
 * memory the native context owns, and holding it while the next render happens is
 * how you get a profile full of NaN — and, a few hundred renders later, a process
 * that dies with no JavaScript stack.
 */
export async function measure(ast: SoundAST): Promise<RenderReport> {
  const result = await renderSound(ast, {
    context: (options) => new NodeOfflineAudioContext(options) as unknown as OfflineAudioContext,
  });
  const samples = Float32Array.from(result.buffer.getChannelData(0));
  return {
    profile: extractProfile({ samples, sampleRate: result.buffer.sampleRate }),
    peak: result.peak,
    clipped: result.clipped,
    durationMs: result.durationMs,
  };
}

/** What one render tells the caller. */
export interface RenderReport {
  readonly profile: SoundProfile;
  /**
   * Peak sample amplitude, as measured — never normalized.
   *
   * The renderer's own rule, kept here: normalizing would hide the problem where it
   * can still be fixed in the spec.
   */
  readonly peak: number;
  /** Whether the peak exceeds `GLOBAL_LIMITS.maxPeak`. A warning, not a refusal. */
  readonly clipped: boolean;
  readonly durationMs: number;
}

/**
 * Below this peak a render is silence, and storing it would be storing nothing.
 *
 * -60 dBFS. The same figure the grammar uses for the floor of an exponential ramp
 * (`GLOBAL_LIMITS.minExpTarget`), for the same reason: it is the point where a
 * signal stops being audible rather than a round number.
 */
export const SILENCE_PEAK = 0.001;

/**
 * A gate that lets `width` renders run at once and queues the rest.
 *
 * Twenty lines instead of a dependency, and the shape is worth being explicit about:
 * a promise per waiter, resolved in arrival order. Fastify will happily accept a
 * thousand concurrent requests, and without this every one of them would be inside
 * a native audio render at the same time on a box with two cores.
 */
export interface RenderQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** How many callers are waiting. Reported by `GET /api/health`. */
  readonly depth: number;
}

/**
 * @param width - Concurrent renders. Two, by default: one core rendering while
 *   another serves the reads that make up almost all the traffic.
 */
export function renderQueue(width = 2): RenderQueue {
  const waiting: (() => void)[] = [];
  let active = 0;

  const acquire = async (): Promise<void> => {
    if (active < width) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
  };

  const release = (): void => {
    active--;
    const next = waiting.shift();
    if (next !== undefined) next();
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    get depth(): number {
      return waiting.length;
    },
  };
}
