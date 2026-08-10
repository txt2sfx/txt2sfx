/**
 * The dev-only General MIDI preview: the same arrangement, played by a sample bank.
 *
 * ## Why this exists, and why it can never be the player
 *
 * "Use one of the open GM banks so the instruments sound real" is a request about *judgement*,
 * not about the product. No test can say whether the synthesized guitar in `lib/loop-voice.ts`
 * is close enough to a guitar; an ear can, in one A/B, and this is the other half of that A/B.
 *
 * What it must never become is the thing that plays or exports. A soundline compiles to a
 * self-contained function with no assets — that is the claim the whole screen rests on — and a
 * sampler behind Play would make it false. So: the bank comes from a dev-only endpoint
 * (`plugins/gm-bank.ts`, `apply: 'serve'`), every entry point here is behind
 * {@link bankPossible}, and the loop screen shows which of the two is sounding. Where a bank
 * *does* belong is the export's program changes — see `programFor` in `lib/loop-export.ts`,
 * which this module deliberately shares rather than copies.
 *
 * ## Why the sampler is arithmetic and not an audio graph
 *
 * It could have been an `OfflineAudioContext` with a `AudioBufferSourceNode` per note. It is a
 * loop over a `Float32Array` instead, for the reason the rest of this repository gives: no audio
 * stack below the app means the wrap, the pitch and the loop points are testable in Node. And it
 * lets the result go through {@link mixLoop} unchanged — the same summation, the same fold of a
 * tail back to the head, the same headroom report — so a bank mix and a synthesized mix differ
 * in exactly one thing, which is the point of comparing them.
 *
 * ## What the preview does not reproduce
 *
 * A DLS region carries envelopes, a filter and an LFO in its articulator lists, and none of that
 * is read (`plugins/dls.ts` says why). So a looped sample sustains flat for as long as the note
 * lasts where the bank's own envelope would have decayed it, and the resampling is linear
 * interpolation rather than a windowed kernel. Both are audible on a held piano note. Neither
 * changes what the comparison is for: whether the *instrument* is recognisable.
 *
 * @packageDocumentation
 */

import { LANES, loopSeconds, stepSeconds, type LoopNote, type LoopTrack } from './loop.js';
import { programFor } from './loop-export.js';
import { CEILING, SAMPLE_RATE, mixLoop, type LoopRender, type Part } from './loop-render.js';

/**
 * Whether the endpoint can exist at all.
 *
 * The same shape `lib/stable-audio.ts` uses: `import.meta.env.DEV` is a compile-time constant,
 * so a production bundle drops every branch below it and the routes cannot be probed from a
 * static build.
 */
export const bankPossible: boolean = import.meta.env.DEV;

/** What the dev server says about the bank. */
export interface BankStatus {
  readonly ok: boolean;
  readonly path: string;
  readonly name: string;
  readonly instruments: number;
  readonly waves: number;
  readonly reason?: string;
}

/** One sample from the bank, with everything needed to play it at another pitch. */
export interface BankSample {
  /** Mono, −1 … 1, at {@link rate}. */
  readonly frames: Float32Array;
  readonly rate: number;
  /** MIDI note the sample sounds at unity speed. */
  readonly root: number;
  readonly fineCents: number;
  /** Linear, from the region's attenuation. */
  readonly gain: number;
  readonly loop: { readonly start: number; readonly length: number } | null;
}

/** Seconds of release after a note ends, so stopping a looped sample does not click. */
const RELEASE_SEC = 0.04;

/** Seconds of fade-in. Long enough to swallow a sample that does not start at zero. */
const ATTACK_SEC = 0.002;

/**
 * Longest tail a one-shot may add past its note.
 *
 * A cymbal in a GM bank rings for seconds and the note that triggered it is a sixteenth; cutting
 * it at the note would make every kit sound gated. Two seconds is the whole tail of everything in
 * the Windows bank and it is bounded so one crash cannot cost a minute of samples.
 */
const MAX_TAIL_SEC = 2;

/** Asked once per dev session. */
let status: Promise<BankStatus | null> | null = null;

/**
 * Ask the dev server whether a bank is loaded.
 *
 * Returns null rather than throwing when there is no dev endpoint at all — that is the normal
 * state of a built page, and the caller's job is to not show the toggle, not to handle an error.
 */
export async function bankStatus(): Promise<BankStatus | null> {
  if (!bankPossible) return null;
  status ??= fetch('/__gm')
    .then(async (response) => (response.ok ? ((await response.json()) as BankStatus) : null))
    .catch(() => null);
  return status;
}

/** Samples already fetched, keyed by the instrument and note that asked for them. */
const samples = new Map<string, Promise<BankSample | null>>();

/** Fetch one note's sample, or null when the bank has none for it. */
async function sampleFor(program: number, midi: number, drums: boolean): Promise<BankSample | null> {
  const key = `${String(program)}:${String(midi)}:${drums ? 'd' : 'm'}`;
  const hit = samples.get(key);
  if (hit !== undefined) return hit;

  const pending = (async (): Promise<BankSample | null> => {
    const query = `program=${String(program)}&midi=${String(midi)}&drums=${drums ? '1' : '0'}`;
    const response = await fetch(`/__gm/note?${query}`);
    if (!response.ok) return null;
    const header = (name: string, fallback: number): number => {
      const value = Number(response.headers.get(name));
      return Number.isFinite(value) ? value : fallback;
    };
    const pcm = new Int16Array(await response.arrayBuffer());
    const frames = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) frames[i] = (pcm[i] ?? 0) / 32768;
    const start = header('x-gm-loop-start', -1);
    const length = header('x-gm-loop-length', 0);
    return {
      frames,
      rate: header('x-gm-rate', SAMPLE_RATE),
      root: header('x-gm-root', midi),
      fineCents: header('x-gm-fine', 0),
      gain: Math.pow(10, header('x-gm-gain-db', 0) / 20),
      loop: start >= 0 && length > 1 ? { start, length } : null,
    };
  })().catch(() => null);

  samples.set(key, pending);
  return pending;
}

/**
 * Play one sample at a pitch, for a length, into a fresh array.
 *
 * Pure: the same arguments always produce the same samples, and no part of it knows what an
 * `AudioContext` is. Linear interpolation between source frames — a cheap resampler, and stated
 * as such in the module note, because the alternative is a windowed sinc kernel for a preview
 * whose whole job is to answer a question about timbre rather than about fidelity.
 */
export function playSample(sample: BankSample, midi: number, seconds: number, level: number): Float32Array {
  /* Two ratios in one: the pitch shift the note asks for, and the difference between the bank's
     rate and the mix's. A sample recorded at 22050 already plays an octave too low if the second
     one is forgotten, which is the kind of bug that sounds like a bad bank. */
  const semitones = midi - sample.root + sample.fineCents / 100;
  const ratio = Math.pow(2, semitones / 12) * (sample.rate / SAMPLE_RATE);
  const loopEnd = sample.loop === null ? 0 : sample.loop.start + sample.loop.length;
  /* A one-shot lasts as long as it lasts; a looped sample lasts as long as the note, plus the
     release either way. */
  const natural = sample.frames.length / Math.max(1e-6, ratio) / SAMPLE_RATE;
  const held = sample.loop === null ? Math.min(natural, seconds + MAX_TAIL_SEC) : seconds;
  const total = Math.max(1, Math.round((held + RELEASE_SEC) * SAMPLE_RATE));
  const out = new Float32Array(total);

  const attack = Math.max(1, Math.round(ATTACK_SEC * SAMPLE_RATE));
  const release = Math.max(1, Math.round(RELEASE_SEC * SAMPLE_RATE));
  const gain = level * sample.gain;
  let position = 0;

  for (let i = 0; i < total; i++) {
    if (sample.loop !== null && position >= loopEnd) {
      position -= sample.loop.length;
      /* A loop whose length the region lied about would spin here forever otherwise. */
      if (position >= loopEnd) break;
    }
    const index = Math.floor(position);
    if (index + 1 >= sample.frames.length) break;
    const fraction = position - index;
    const value = (sample.frames[index] ?? 0) * (1 - fraction) + (sample.frames[index + 1] ?? 0) * fraction;
    /* Both ends of the envelope are linear ramps, which is all a click needs. The bank's own
       envelope is not read, so this is the only shaping there is. */
    const fade = Math.min(1, (i + 1) / attack, (total - i) / release);
    out[i] = value * gain * fade;
    position += ratio;
  }
  return out;
}

/**
 * Mix a whole loop from the bank instead of from soundline voices.
 *
 * Deliberately the same signature and the same return type as `renderLoop`, so `useLoop` picks
 * one or the other and nothing downstream — Play, the timeline, the waveform, the mute — can
 * tell which it got. The export is the exception, and it is the one that matters: it takes the
 * *track*, not the buffer, so it always emits code and MIDI for the synthesized instruments
 * however the preview is being auditioned.
 */
export async function renderLoopFromBank(
  track: LoopTrack,
  options: { readonly muted?: ReadonlySet<string> },
): Promise<LoopRender> {
  const muted = options.muted ?? new Set<string>();
  const length = Math.max(1, Math.round(loopSeconds(track) * SAMPLE_RATE));
  const step = stepSeconds(track);

  const parts: Part[] = [];
  let notes = 0;
  const used = new Set<string>();
  for (const lane of track.lanes) {
    if (muted.has(lane.name)) continue;
    const spec = LANES[lane.name];
    if (spec === undefined) continue;
    const drums = spec.drum === true;
    const program = programFor(lane.name);
    for (const note of lane.notes) {
      notes++;
      const sample = await sampleFor(program, note.midi, drums);
      if (sample === null) continue;
      used.add(`${String(program)}:${String(note.midi)}`);
      parts.push({
        samples: playSample(sample, note.midi, noteSeconds(note, step), note.gain * spec.level),
        offset: Math.round(note.step * step * SAMPLE_RATE),
      });
    }
  }

  const { samples: mixed, peak } = mixLoop(parts, length);
  const headroom = peak > CEILING ? CEILING / peak : 1;
  if (headroom !== 1) for (let i = 0; i < mixed.length; i++) mixed[i] = (mixed[i] ?? 0) * headroom;

  const buffer = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: SAMPLE_RATE }).createBuffer(
    1,
    length,
    SAMPLE_RATE,
  );
  buffer.copyToChannel(mixed, 0);
  /* `voices` counts distinct samples rather than distinct recipes. It is the same number in
     spirit — how many things had to be fetched or rendered — and the interface prints it under
     the same label. */
  return { buffer, peak, headroom, voices: used.size, notes };
}

/**
 * How long a note is held, in seconds — a floor of one step, and nothing else.
 *
 * It does not need to special-case percussion, and that is worth stating because it looks like
 * it should: a kick written `length 2` is not two sixteenths of kick. But a bank's drum sample
 * has no loop points, and {@link playSample} lets a one-shot run for as long as it naturally
 * lasts whatever it was asked for, so the whole hit arrives either way.
 */
function noteSeconds(note: LoopNote, step: number): number {
  return Math.max(step, note.length * step);
}
