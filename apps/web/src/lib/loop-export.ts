/**
 * What leaves NeurosLoop.
 *
 * Four things, and the order they are argued in is the order they matter:
 *
 * | offered | what it is |
 * | --- | --- |
 * | `JS · Web Audio module` | **the deliverable.** A table of `codegen` arrow functions plus a schedule. No audio file, no sample data |
 * | `TS · typed module` | the same module with the four annotations a strict codebase wants |
 * | `MIDI · multitrack` | the arrangement, for someone who wants to rewrite it in a real DAW |
 * | `WAV` / `MP3` | the mixdown, for a ticket or a chat message |
 *
 * ## Why the module is a table and a schedule
 *
 * Because a note is a recipe (`lib/loop-voice.ts`), and `codegen` turns a recipe into a
 * self-contained `(ctx, when) => void` that connects itself to `ctx.destination`. That
 * shape is the whole reason velocity is baked into the recipe upstream: with loudness
 * already in the text, the emitted module needs no gain node wrapped around generated
 * code, and scheduling is a `for` loop over `(voice, step)` pairs. The result is
 * readable, diffable, and does the one thing an audio file cannot — it costs the same
 * bytes whether the game plays it once or ten thousand times.
 *
 * It will not be small. A sixteen-bar arrangement is twenty to forty distinct voices, so
 * a few tens of kilobytes rather than the few hundred bytes a single effect costs. The
 * export card says the number rather than hiding it, the same way `codegen`'s 1 KB
 * budget is a report and not a gate.
 *
 * ## The MIDI is real MIDI
 *
 * Format 1, one track per lane, tempo and time signature in the conductor track,
 * percussion on channel 10 at General MIDI note numbers. It opens in a DAW and plays.
 * Writing a `.mid` extension over something else is the failure mode `lib/download.ts`
 * spends a section refusing, and it would be just as cheap to commit here.
 *
 * @packageDocumentation
 */

import { codegen, parseWithDiagnostics } from '@txt2sfx/core';
import { download, save, type Format } from './download.js';
import { t } from './i18n.js';
import {
  LANES,
  STEPS_PER_BEAT,
  knobsFor,
  loopSeconds,
  stepSeconds,
  type LoopTrack,
} from './loop.js';
import { voiceFor, type VoiceContext } from './loop-voice.js';

/* ------------------------------------------------------------------------- *
 * The schedule both exports are built from
 * ------------------------------------------------------------------------- */

/** One scheduled hit: which distinct voice, on which step, in which lane. */
export interface Hit {
  readonly voice: number;
  readonly step: number;
  readonly lane: string;
}

/** Every distinct voice in a track, plus where each one fires. */
export interface Schedule {
  /** Distinct soundline recipes, in first-use order. */
  readonly voices: readonly string[];
  readonly hits: readonly Hit[];
}

/** Flatten a track into distinct voices and the steps they fire on. */
export function schedule(track: LoopTrack): Schedule {
  const context: VoiceContext = {
    stepSeconds: stepSeconds(track),
    brightness: knobsFor(track.prompt).brightness,
  };
  const voices: string[] = [];
  const hits: Hit[] = [];

  for (const lane of track.lanes) {
    for (const note of lane.notes) {
      const soundline = voiceFor(lane.name, note, context);
      let index = voices.indexOf(soundline);
      if (index < 0) {
        index = voices.length;
        voices.push(soundline);
      }
      hits.push({ voice: index, step: note.step, lane: lane.name });
    }
  }
  hits.sort((a, b) => a.step - b.step || a.voice - b.voice);
  return { voices, hits };
}

/* ------------------------------------------------------------------------- *
 * The module
 * ------------------------------------------------------------------------- */

/** A JavaScript string literal for a name that came from a preset or a prompt. */
function quote(text: string): string {
  return JSON.stringify(text);
}

/**
 * Emit the module.
 *
 * @param typed - Add the annotations a strict TypeScript codebase needs. The bodies are
 *   identical; only the signature and the two table declarations differ, which is why
 *   this is a flag rather than a second emitter that could drift.
 */
export function toModule(track: LoopTrack, seed: number, typed: boolean): string {
  const { voices, hits } = schedule(track);
  const compiled = voices.map((soundline) => {
    const parsed = parseWithDiagnostics(soundline);
    if (parsed.ast === null) return '()=>{}';
    try {
      return codegen(parsed.ast, { seed }).code;
    } catch {
      return '()=>{}';
    }
  });

  const step = stepSeconds(track);
  const seconds = loopSeconds(track);
  const ctx = typed ? 'ctx: AudioContext' : 'ctx';
  const when = typed ? 'when: number = ctx.currentTime' : 'when = ctx.currentTime';
  const repeats = typed ? 'repeats: number = 1' : 'repeats = 1';
  const voiceType = typed ? ': ((c: AudioContext, w?: number) => void)[]' : '';
  const hitType = typed ? ': [number, number][]' : '';

  return `/**
 * ${track.name} — ${String(track.bpm)} bpm, ${String(track.bars)} bars, ${track.key}.
 * ${track.prompt === '' ? 'No prompt recorded.' : `“${track.prompt}”`}
 *
 * Generated by txt2sfx (NeurosLoop). Every voice below is a compiled soundline recipe:
 * plain Web Audio, no imports, no assets. Play it with an AudioContext.
 */

/** One compiled voice per distinct note; loudness is already baked into each. */
const voices${voiceType} = [
${compiled.map((code) => `  ${code},`).join('\n')}
];

/** [voice, step] — the arrangement on a sixteenth-note grid. */
const hits${hitType} = [
${hits.map((hit) => `  [${String(hit.voice)}, ${String(hit.step)}],`).join('\n')}
];

export const meta = {
  name: ${quote(track.name)},
  bpm: ${String(track.bpm)},
  bars: ${String(track.bars)},
  key: ${quote(track.key)},
  stepSeconds: ${String(Number(step.toFixed(9)))},
  loopSeconds: ${String(Number(seconds.toFixed(9)))},
};

/**
 * Schedule the loop.
 *
 * Everything is scheduled ahead of time against the context clock, so playback does not
 * depend on a timer firing on time. For a soundtrack that outlives one pass, call again
 * with \`when + repeats * meta.loopSeconds\`.
 */
export default function playLoop(${ctx}, ${when}, ${repeats}) {
  for (let lap = 0; lap < repeats; lap++) {
    const base = when + lap * meta.loopSeconds;
    for (const [voice, step] of hits) voices[voice](ctx, base + step * meta.stepSeconds);
  }
  return when + repeats * meta.loopSeconds;
}
`;
}

/* ------------------------------------------------------------------------- *
 * MIDI
 * ------------------------------------------------------------------------- */

/** Ticks per quarter note. 480 is what every DAW rounds to happily. */
const TPQ = 480;

/** General MIDI programs, so an exported file opens making roughly the right noise. */
const PROGRAM: Readonly<Record<string, number>> = {
  bass: 38,
  pluck: 4,
  bell: 14,
  lead: 81,
  pad: 89,
  air: 122,
  kit: 0,
};

/** MIDI's variable-length quantity: seven bits per byte, high bit means "more". */
function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  return bytes;
}

/** A chunk with its four-byte big-endian length prefix. */
function chunk(type: string, body: readonly number[]): number[] {
  const length = body.length;
  return [
    ...[...type].map((character) => character.charCodeAt(0)),
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...body,
  ];
}

/** Text-bearing meta events, which every track wants for its name. */
function meta(type: number, text: string): number[] {
  const bytes = [...text].map((character) => character.charCodeAt(0) & 0x7f);
  return [0xff, type, ...vlq(bytes.length), ...bytes];
}

/** One absolute-time event, before deltas are computed. */
interface Timed {
  readonly tick: number;
  /** Note-offs sort before note-ons at the same tick, so a repeat retriggers. */
  readonly order: number;
  readonly bytes: readonly number[];
}

function track(events: readonly Timed[], head: readonly number[]): number[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body = [...head];
  let previous = 0;
  for (const event of sorted) {
    body.push(...vlq(event.tick - previous), ...event.bytes);
    previous = event.tick;
  }
  body.push(...vlq(0), 0xff, 0x2f, 0x00);
  return body;
}

/**
 * The arrangement as a Standard MIDI File.
 *
 * Format 1 — a conductor track carrying tempo and metre, then one track per lane, which
 * is what makes the file useful: a producer opens it and each instrument is already on
 * its own track with its own name.
 */
export function toMidi(loop: LoopTrack): Uint8Array {
  const ticksPerStep = TPQ / STEPS_PER_BEAT;
  const microsPerQuarter = Math.round(60000000 / loop.bpm);

  const conductor = track(
    [],
    [
      ...vlq(0),
      ...meta(0x03, loop.name),
      ...vlq(0),
      0xff,
      0x51,
      0x03,
      (microsPerQuarter >>> 16) & 0xff,
      (microsPerQuarter >>> 8) & 0xff,
      microsPerQuarter & 0xff,
      /* 4/4, with the two clock fields at their conventional values — a DAW reads the
         bar lines from this, and a missing time signature makes it guess. */
      ...vlq(0),
      0xff,
      0x58,
      0x04,
      0x04,
      0x02,
      0x18,
      0x08,
    ],
  );

  const chunks: number[][] = [chunk('MTrk', conductor)];

  loop.lanes.forEach((lane, index) => {
    const spec = LANES[lane.name];
    /* Channel 10 (index 9) is percussion by definition in General MIDI; melodic lanes
       take the remaining channels and skip it. */
    const channel = spec?.drum === true ? 9 : [0, 1, 2, 3, 4, 5, 6, 7][index % 8] ?? 0;
    const events: Timed[] = [];
    for (const note of lane.notes) {
      const start = note.step * ticksPerStep;
      const end = start + Math.max(1, note.length) * ticksPerStep;
      const velocity = Math.max(1, Math.min(127, Math.round(note.gain * 127)));
      events.push({ tick: start, order: 1, bytes: [0x90 | channel, note.midi & 0x7f, velocity] });
      events.push({ tick: end, order: 0, bytes: [0x80 | channel, note.midi & 0x7f, 0x40] });
    }
    const program = PROGRAM[spec?.family ?? 'pluck'] ?? 0;
    chunks.push(
      chunk(
        'MTrk',
        track(events, [...vlq(0), ...meta(0x03, lane.name), ...vlq(0), 0xc0 | channel, program & 0x7f]),
      ),
    );
  });

  const header = chunk('MThd', [
    0x00,
    0x01,
    (chunks.length >>> 8) & 0xff,
    chunks.length & 0xff,
    (TPQ >>> 8) & 0xff,
    TPQ & 0xff,
  ]);

  return Uint8Array.from([...header, ...chunks.flat()]);
}

/* ------------------------------------------------------------------------- *
 * Handing it over
 * ------------------------------------------------------------------------- */

/** Round a byte count for the status line — the same two rules `download.ts` uses. */
function size(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${String(Math.round(bytes / 1024))} kB`;
}

/**
 * Export a soundtrack.
 *
 * @returns The sentence for the status line, including the refusals — a menu entry that
 *   silently does nothing is the worst outcome available.
 */
export async function downloadLoop(
  loop: LoopTrack,
  format: Format,
  options: { readonly buffer: AudioBuffer | null; readonly seed: number },
): Promise<string> {
  const filename = `${loop.name}.${format.extension}`;

  if (format.id === 'loop-js' || format.id === 'loop-ts') {
    const text = toModule(loop, options.seed, format.id === 'loop-ts');
    save(new Blob([text], { type: format.mime }), filename);
    return t('dl.savedSize', { file: filename, size: size(new TextEncoder().encode(text).length) });
  }

  if (format.id === 'midi') {
    const bytes = toMidi(loop);
    save(new Blob([bytes.slice().buffer as ArrayBuffer], { type: format.mime }), filename);
    return t('dl.savedSize', { file: filename, size: size(bytes.length) });
  }

  /* Everything else is the mixdown, which the existing encoder path already handles —
     including the honest failure when an encoder cannot be resolved. */
  return download({ name: loop.name, source: '', code: null, buffer: options.buffer }, format);
}
