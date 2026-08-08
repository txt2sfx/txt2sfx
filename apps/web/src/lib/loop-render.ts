/**
 * A loop, mixed down to one seamless buffer.
 *
 * ## Why the mix is a buffer and not a live graph
 *
 * The same argument `lib/engine.ts` makes for `loop()` on a single recipe, only more so.
 * A sixteen-bar arrangement is a few hundred note events; scheduling them live means
 * re-instantiating a few hundred oscillators every lap, on the audio thread, with an
 * audible seam wherever a lap boundary lands mid-attack. Rendered once and looped
 * through an `AudioBufferSourceNode`, the join is sample-exact and the cost is paid
 * before anyone presses Play.
 *
 * ## The wrap is what makes it a loop
 *
 * A note near the end of the last bar has a tail that runs past the loop boundary, and
 * the only place that tail belongs is **at the head of the same buffer**. So the mix
 * wraps: samples past the end fold back to the start. That is the difference between a
 * loop and a clip that happens to be played twice, and it is why a pad with a two-second
 * release does not click every eight bars.
 *
 * ## Headroom, and the one place normalizing is right
 *
 * `renderSound` reports clipping and never normalizes, because a clipping *recipe* has
 * an author who can fix it. A mix has no author: it is the sum of twelve independently
 * correct recipes, and nobody wrote the number that makes them add up to 1.4. So the
 * mixdown scales to {@link CEILING} when it has to, and reports the factor it applied so
 * the interface can say so. A soundtrack that clips because it has five lanes instead of
 * three would otherwise be a bug the user cannot act on.
 *
 * @packageDocumentation
 */

import { parseWithDiagnostics } from '@txt2sfx/core';
import { render } from './engine.js';
import { knobsFor, loopSeconds, stepSeconds, type LoopTrack } from './loop.js';
import { voiceFor, type VoiceContext } from './loop-voice.js';

/** Peak the mix is scaled down to when the lanes sum past it. */
export const CEILING = 0.95;

/** Sample rate for every mixdown. The rate `lib/engine.ts` plays at. */
export const SAMPLE_RATE = 44100;

/** What came out of a mixdown, and what it cost. */
export interface LoopRender {
  readonly buffer: AudioBuffer;
  /** Peak of the mix *before* headroom scaling — the honest number. */
  readonly peak: number;
  /** What the mix was multiplied by. 1 when nothing was needed. */
  readonly headroom: number;
  /** Distinct recipes rendered, which is what the export will contain. */
  readonly voices: number;
  readonly notes: number;
}

/** One rendered voice, placed on the timeline. */
export interface Part {
  readonly samples: Float32Array;
  /** Sample index of the note's onset within the loop. */
  readonly offset: number;
}

/**
 * Sum parts into a loop of `length` samples, folding overhang back to the head.
 *
 * Pure and free of any audio stack, so the wrap — the one piece of arithmetic here that
 * can be silently wrong — is testable in Node.
 */
export function mixLoop(
  parts: readonly Part[],
  length: number,
): { samples: Float32Array<ArrayBuffer>; peak: number } {
  /* The buffer type is pinned rather than left generic: `copyToChannel` will not take a
     `Float32Array<ArrayBufferLike>`, because a `SharedArrayBuffer` cannot back one. */
  const samples = new Float32Array(length);
  if (length <= 0) return { samples, peak: 0 };

  for (const part of parts) {
    for (let i = 0; i < part.samples.length; i++) {
      /* `%` after the add rather than an if: a tail longer than the whole loop wraps
         more than once, which is exactly what a two-bar pad on a one-bar loop does. */
      const at = (part.offset + i) % length;
      samples[at] = (samples[at] ?? 0) + (part.samples[i] ?? 0);
    }
  }

  let peak = 0;
  for (const value of samples) {
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  return { samples, peak };
}

/**
 * Renders of distinct voices, keyed by their soundline text and seed.
 *
 * Keyed by the text itself, which is correct by construction — the same note of the same
 * lane produces the same characters, so two lanes playing the same hat share an entry
 * and an edit to one lane invalidates nothing else. Bounded for the reason
 * `lib/layers.ts` bounds its cache: a long session with a dozen takes would otherwise
 * hold every note of every one of them.
 */
const cache = new Map<string, Promise<Float32Array>>();

/** Distinct notes across a handful of takes. */
const CACHE_LIMIT = 512;

function remember(key: string, value: Promise<Float32Array>): Promise<Float32Array> {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
  return value;
}

/**
 * Render one voice's soundline to samples.
 *
 * `Float32Array.from` on the way out is not defensive style, it is the rule this
 * repository learned the hard way: `getChannelData` is a view into memory the
 * `OfflineAudioContext` owns, and holding it across a few hundred renders turns the
 * samples into NaN and then kills the process with no JavaScript stack.
 */
export async function voiceSamples(soundline: string, seed: number): Promise<Float32Array> {
  const key = `${String(seed)}|${soundline}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const parsed = parseWithDiagnostics(soundline);
  if (parsed.ast === null) {
    /* Cached as an empty part rather than thrown: a voice template that will not parse
       fails identically for every note in the lane, and turning that into one silent
       instrument beats turning it into four hundred rejected promises. */
    return remember(key, Promise.resolve(new Float32Array(0)));
  }
  return remember(
    key,
    render(parsed.ast, { seed }).then((result) => Float32Array.from(result.buffer.getChannelData(0))),
  );
}

/**
 * Render every distinct voice one lane needs, and nothing else.
 *
 * What the composing indicator is actually waiting on. Deliberately not "mix the track
 * with only this lane in it": that would allocate a full loop's worth of samples per
 * lane for a result nobody looks at. The renders land in the cache, so the mixdown that
 * follows the last lane finds all of them there.
 */
export async function primeLane(track: LoopTrack, laneName: string, seed: number): Promise<void> {
  const lane = track.lanes.find((entry) => entry.name === laneName);
  if (lane === undefined) return;
  const context: VoiceContext = {
    stepSeconds: stepSeconds(track),
    brightness: knobsFor(track.prompt).brightness,
  };
  const distinct = new Set(lane.notes.map((note) => voiceFor(lane.name, note, context)));
  for (const soundline of distinct) await voiceSamples(soundline, seed);
}

/**
 * Render a whole soundtrack.
 *
 * @param muted - Lane names to leave out. Muting re-mixes rather than gating playback,
 *   because the buffer is what is playing and what is exported: a mute that only
 *   silenced the monitor would export a file that disagrees with what was auditioned.
 */
export async function renderLoop(
  track: LoopTrack,
  options: { readonly seed: number; readonly muted?: ReadonlySet<string> },
): Promise<LoopRender> {
  const muted = options.muted ?? new Set<string>();
  const context: VoiceContext = {
    stepSeconds: stepSeconds(track),
    brightness: knobsFor(track.prompt).brightness,
  };
  const length = Math.max(1, Math.round(loopSeconds(track) * SAMPLE_RATE));
  const step = context.stepSeconds * SAMPLE_RATE;

  const wanted: { readonly soundline: string; readonly offset: number }[] = [];
  for (const lane of track.lanes) {
    if (muted.has(lane.name)) continue;
    for (const note of lane.notes) {
      wanted.push({ soundline: voiceFor(lane.name, note, context), offset: Math.round(note.step * step) });
    }
  }

  const distinct = [...new Set(wanted.map((entry) => entry.soundline))];
  const rendered = new Map<string, Float32Array>();
  /* Sequential rather than `Promise.all`: each render is its own `OfflineAudioContext`,
     and starting three hundred of them at once is how a tab runs out of them. The cache
     means a second take of the same track costs nothing here at all. */
  for (const soundline of distinct) rendered.set(soundline, await voiceSamples(soundline, options.seed));

  const { samples, peak } = mixLoop(
    wanted.map((entry) => ({ samples: rendered.get(entry.soundline) ?? new Float32Array(0), offset: entry.offset })),
    length,
  );

  const headroom = peak > CEILING ? CEILING / peak : 1;
  if (headroom !== 1) for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] ?? 0) * headroom;

  /* An `OfflineAudioContext` purely as a buffer allocator: it is the one way to get an
     `AudioBuffer` without an `AudioContext`, which browsers keep suspended until a
     gesture and which a mixdown has no business creating. */
  const buffer = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: SAMPLE_RATE }).createBuffer(
    1,
    length,
    SAMPLE_RATE,
  );
  buffer.copyToChannel(samples, 0);

  return { buffer, peak, headroom, voices: distinct.length, notes: wanted.length };
}

/**
 * Each lane on its own, for a stem export.
 *
 * Mixed through the same path rather than by slicing the master, because the master had
 * headroom applied to it — stems taken off it would each carry the *sum's* gain
 * reduction, which is silently wrong and only shows up when someone sums them back
 * together in a DAW and finds the mix quieter than the one they auditioned.
 */
export async function renderStems(
  track: LoopTrack,
  seed: number,
): Promise<readonly { readonly lane: string; readonly render: LoopRender }[]> {
  const out: { lane: string; render: LoopRender }[] = [];
  for (const lane of track.lanes) {
    const others = new Set(track.lanes.map((entry) => entry.name).filter((name) => name !== lane.name));
    out.push({ lane: lane.name, render: await renderLoop(track, { seed, muted: others }) });
  }
  return out;
}
