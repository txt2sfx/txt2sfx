/**
 * Audio plumbing for the playground.
 *
 * Two playback paths, on purpose:
 *
 * - **Play** builds the live `AudioNode` graph with `buildGraph` — the same path
 *   the exported code takes, so what you audition is the product, not a preview
 *   of it.
 * - **Loop** plays an offline render through a looping `AudioBufferSourceNode`.
 *   A `cycle` sound (rotor, engine, hum) can only be judged looped, and looping a
 *   live graph would mean re-instantiating oscillators on every lap with an
 *   audible seam at the join.
 *
 * The visualizer always draws the offline render, never a live `AnalyserNode`:
 * the picture then matches the recipe rather than the moment the mouse happened
 * to be over the canvas, and it is there before you press anything.
 *
 * @packageDocumentation
 */

import type { SoundAST } from '@txt2sfx/shared';
import { buildGraph, renderSound, type AudioIR, type RenderResult } from '@txt2sfx/core';

/** A sound that is currently audible. */
export interface Playback {
  /** Fade out and release the nodes. Idempotent. */
  stop(): void;
}

/** Compile-side knobs the playground exposes. */
export interface PlayOptions {
  readonly seed?: number;
}

const SILENT: Playback = { stop: () => {} };

let shared: AudioContext | null = null;

/**
 * The one shared `AudioContext`.
 *
 * Created lazily and resumed on every play: browsers start it suspended until a
 * user gesture, and a playground that needs a page reload after the first click
 * would be worse than useless.
 */
export function audioContext(): AudioContext {
  shared ??= new AudioContext({ sampleRate: 44100 });
  return shared;
}

/** Fade a master gain to zero and drop it. Short enough to feel instant. */
function release(ctx: AudioContext, master: GainNode): void {
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setTargetAtTime(0, now, 0.008);
  window.setTimeout(() => master.disconnect(), 120);
}

/** Play a sound once through the live graph. */
export function playLive(ast: SoundAST, options: PlayOptions = {}): { readonly playback: Playback; readonly ir: AudioIR } {
  const ctx = audioContext();
  void ctx.resume();

  const master = ctx.createGain();
  master.connect(ctx.destination);

  // A hair of lead time: scheduling at exactly `currentTime` loses the first
  // milliseconds of a click, which is the part that makes it a click.
  const when = ctx.currentTime + 0.03;
  const ir = buildGraph(ctx, ast, { destination: master, when, ...(options.seed === undefined ? {} : { seed: options.seed }) });

  let stopped = false;
  const timer = window.setTimeout(() => release(ctx, master), (when - ctx.currentTime + ir.durationSec + 0.2) * 1000);

  return {
    ir,
    playback: {
      stop: () => {
        if (stopped) return;
        stopped = true;
        window.clearTimeout(timer);
        release(ctx, master);
      },
    },
  };
}

/**
 * A playing buffer that can say where it is.
 *
 * `position` exists for one caller and one reason: NeurosLoop mutes a lane by **re-mixing**
 * (`lib/loop-render.ts` argues why — what plays and what exports must be the same bytes),
 * and a re-mix produces a different `AudioBuffer` while the old one is still sounding.
 * Without a way to ask how far into the lap we are, taking over means restarting the loop
 * from bar 1, and a mute button that restarts the music is not a mute button.
 */
export interface BufferPlayback extends Playback {
  /** Seconds into the buffer right now, wrapped into it when looping. */
  position(): number;
}

/**
 * How long a buffer swapped in mid-lap fades up.
 *
 * Paired with `release`'s 8 ms fade-out on the outgoing one, so the handover is a short
 * crossfade rather than two edits: both buffers carry the same music from the same phase,
 * but one of them is missing a lane, and a hard cut at that difference is an audible click.
 */
const HANDOVER = 0.01;

/** Play a rendered buffer, optionally looping it, optionally starting partway in. */
export function playBuffer(
  buffer: AudioBuffer,
  options: { readonly loop: boolean; readonly offset?: number },
): BufferPlayback {
  const ctx = audioContext();
  void ctx.resume();

  const master = ctx.createGain();
  master.connect(ctx.destination);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = options.loop;
  source.connect(master);

  const offset = Math.max(0, Math.min(options.offset ?? 0, buffer.duration));
  const startedAt = ctx.currentTime;
  if (offset > 0) {
    master.gain.setValueAtTime(0, startedAt);
    master.gain.linearRampToValueAtTime(1, startedAt + HANDOVER);
  }
  source.start(0, offset);

  let stopped = false;
  return {
    position: () => {
      const elapsed = ctx.currentTime - startedAt + offset;
      return options.loop ? elapsed % buffer.duration : Math.min(elapsed, buffer.duration);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      release(ctx, master);
      try {
        source.stop();
      } catch {
        // Already finished on its own; nothing to stop.
      }
    },
  };
}

/** A playback that is already over — handy as an initial state. */
export const silence = SILENT;

/**
 * Render offline, in the browser.
 *
 * `OfflineAudioContext` is native here, so the factory the core package insists
 * on injecting is a one-liner.
 */
export async function render(ast: SoundAST, options: PlayOptions = {}): Promise<RenderResult> {
  return renderSound(ast, {
    context: (o) => new OfflineAudioContext(o),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
}
