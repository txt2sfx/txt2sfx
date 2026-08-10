/**
 * The download menu.
 *
 * Six entries, in two groups that are ordered against each other on purpose.
 *
 * | offered | what it is |
 * | --- | --- |
 * | `WAV · 16-bit` | the interchange default; every tool reads it |
 * | `WAV · 24-bit` | what a game audio pipeline wants for an intermediate — 48 dB more room under the noise floor than 16-bit, at three quarters the size of float |
 * | `MP3 · 192 kbps` | the one that goes in a chat message or a ticket and just plays |
 * | `M4A · AAC 192 kbps` | what an engine import and an iOS device expect by name |
 * | `JavaScript · Web Audio` | **the actual deliverable.** A few hundred bytes, no assets |
 * | `soundline · text` | the source, which is what a diff and a code review want |
 *
 * The two text entries are last in the *menu* and first in importance, which is the
 * opposite of how the Export card above is ordered — that card leads with the JavaScript,
 * because a playground whose most prominent button downloads audio teaches the wrong
 * mental model of the tool. The audio formats are for handing a sound to a person; the
 * code is for shipping it.
 *
 * ## Why the preselected entry is MP3 anyway
 *
 * Ordering says what matters; the *default* has to answer what the button is pressed for
 * before anyone has chosen. That is sending the sound to someone — a chat message, a
 * ticket, a colleague's phone — and MP3 is the only entry that plays everywhere with no
 * explanation attached. The JavaScript loses nothing by not being preselected: the Export
 * card above the menu carries it with a copy button and a download of its own, so it is
 * never more than one click away either way.
 *
 * The choice is then remembered per browser ({@link loadFormat}), because the second
 * download of a session is nearly always the same format as the first.
 *
 * ## Two menus, two memories
 *
 * The Model tab downloads a diffusion model's render — audio with no recipe behind it.
 * `js` and `soundline` there would hand over the *editor's* current recipe under the
 * model's file name, which is the same class of lie as a renamed WAV, so that menu is
 * built from {@link AUDIO_FORMATS} and remembers its choice under its own key. One shared
 * preference would also mean choosing WAV for a model target silently re-aims the recipe's
 * Download button away from the deliverable.
 *
 * ## Nothing here is a renamed WAV
 *
 * MP3 and M4A are genuinely encoded — see `lib/encode.ts` for which libraries, and why
 * taking a dependency was the right call for exactly these two. If an encoder cannot be
 * resolved, the entry says so in a sentence; it never hands over the wrong bytes under
 * the right extension.
 *
 * @packageDocumentation
 */

import { codegen, encodeWav, parse, type CodegenResult } from '@txt2sfx/core';
import { CONTAINER, DEFAULT_BITRATE, encodeCompressed, type CompressedCodec } from './encode.js';
import { render } from './engine.js';
import { t } from './i18n.js';

/** A format the menu can offer. */
export interface Format {
  readonly id: string;
  /** As it appears in the menu. */
  readonly label: string;
  /** As it appears on the split button, which is narrow. */
  readonly short: string;
  readonly extension: string;
  readonly mime: string;
  /**
   * `audio` for the rendered buffer, `code` for the recipe behind it.
   *
   * The distinction is what lets a menu offered next to something that *has* no recipe
   * — a model render — drop the entries that would otherwise export somebody else's.
   */
  readonly kind: 'audio' | 'code';
  /** True for anything that has to be encoded, so the button can say it is working. */
  readonly slow?: boolean;
}

/** Everything on offer, in menu order. */
export const FORMATS: readonly Format[] = [
  { id: 'wav16', label: 'WAV · 16-bit', short: 'WAV 16', extension: 'wav', mime: 'audio/wav', kind: 'audio' },
  { id: 'wav24', label: 'WAV · 24-bit', short: 'WAV 24', extension: 'wav', mime: 'audio/wav', kind: 'audio' },
  {
    id: 'mp3',
    label: 'MP3 · 192 kbps',
    short: 'MP3',
    extension: CONTAINER.mp3.extension,
    mime: CONTAINER.mp3.mime,
    kind: 'audio',
    slow: true,
  },
  {
    id: 'm4a',
    label: 'M4A · AAC 192 kbps',
    short: 'M4A',
    extension: CONTAINER.aac.extension,
    mime: CONTAINER.aac.mime,
    kind: 'audio',
    slow: true,
  },
  { id: 'js', label: 'JavaScript · Web Audio', short: 'JS', extension: 'js', mime: 'text/javascript', kind: 'code' },
  {
    id: 'soundline',
    label: 'soundline · text',
    short: 'soundline',
    extension: 'soundline',
    mime: 'text/plain',
    kind: 'code',
  },
];

/** What a menu offers next to audio that no recipe in this tab produced. */
export const AUDIO_FORMATS: readonly Format[] = FORMATS.filter((format) => format.kind === 'audio');

/**
 * What NeurosLoop offers, and why it is a third list rather than a filter of the first.
 *
 * A soundtrack is not one recipe, so three of the six entries above would be wrong here:
 * `soundline` would hand over one note of it, `js` would compile that same one note, and
 * neither refusal is something a filter on `kind` could express. What replaces them is a
 * module that carries *every* voice plus the schedule (`lib/loop-export.ts`), the same
 * module with types, and the arrangement as MIDI — which is the export somebody who
 * wants to rewrite the melody in a DAW actually needs.
 *
 * The two mixdown entries are last and MP3 is the default, for the reason argued in the
 * header: the first press of an export button is nearly always "send this to someone".
 */
export const LOOP_FORMATS: readonly Format[] = [
  {
    id: 'loop-js',
    label: 'JS · Web Audio module',
    short: 'JS',
    extension: 'js',
    mime: 'text/javascript',
    kind: 'code',
  },
  {
    id: 'loop-ts',
    label: 'TS · typed Web Audio module',
    short: 'TS',
    extension: 'ts',
    mime: 'text/plain',
    kind: 'code',
  },
  { id: 'midi', label: 'MIDI · .mid multitrack', short: 'MIDI', extension: 'mid', mime: 'audio/midi', kind: 'code' },
  { id: 'wav16', label: 'WAV · 16-bit mixdown', short: 'WAV', extension: 'wav', mime: 'audio/wav', kind: 'audio' },
  {
    id: 'mp3',
    label: 'MP3 · 192 kbps mixdown',
    short: 'MP3',
    extension: CONTAINER.mp3.extension,
    mime: CONTAINER.mp3.mime,
    kind: 'audio',
    slow: true,
  },
];

/**
 * What the Search tab offers next to somebody else's recording.
 *
 * A fourth list rather than a filter, for the same reason the loop has one: the entry
 * that matters most here does not exist anywhere else. **Original** hands over the file
 * as the uploader made it — their WAV, their FLAC, at their sample rate — and it is
 * first because it is the honest default for a reference: every other entry is this
 * project decoding somebody's work and re-encoding it, which is a loss taken for
 * convenience and should read as a choice rather than as the only option.
 *
 * `js` and `soundline` are absent for the reason they are absent from the model's menu:
 * there is no recipe behind a recording, and offering them would export the *editor's*
 * under a stranger's file name.
 *
 * The extension is empty because only the caller knows it — it comes from the library's
 * own `type` field, per sound. Nothing in {@link download} handles this id; the Search
 * panel saves the bytes it fetched, untouched.
 */
export const LIBRARY_FORMATS: readonly Format[] = [
  { id: 'original', label: 'Original · as uploaded', short: 'original', extension: '', mime: '', kind: 'audio' },
  ...AUDIO_FORMATS,
];

/**
 * What is preselected before anyone has chosen, and the fallback for anything unreadable.
 *
 * Present in both lists on purpose — a default that only one of the two menus can offer
 * would have to be two constants, and the second one would drift.
 */
export const DEFAULT_FORMAT_ID = 'mp3';

/** Which codec an id needs, or `null` for the formats that need no encoder. */
const CODEC: Readonly<Record<string, CompressedCodec>> = { mp3: 'mp3', m4a: 'aac' };

/**
 * The format with this id, or the default.
 *
 * @param from - The list to resolve against, so a remembered `js` cannot come back as a
 *   selection in a menu that does not offer it.
 */
export function formatById(id: string, from: readonly Format[] = FORMATS): Format {
  return (
    from.find((format) => format.id === id) ??
    from.find((format) => format.id === DEFAULT_FORMAT_ID) ??
    (from[0] as Format)
  );
}

/* ------------------------------------------------------------------------- *
 * Remembering the choice
 * ------------------------------------------------------------------------- */

/** Which menu is asking. No two share a preference — see the header. */
export type FormatScope = 'sound' | 'model' | 'loop' | 'library';

/** Versioned, so a change to the list of ids is a fresh start rather than a stuck menu. */
const STORAGE_KEY: Readonly<Record<FormatScope, string>> = {
  sound: 'txt2sfx.format.v1',
  model: 'txt2sfx.format.model.v1',
  loop: 'txt2sfx.format.loop.v1',
  library: 'txt2sfx.format.library.v1',
};

/** The list each scope's menu offers, which is also what its stored id is checked against. */
export function formatsFor(scope: FormatScope): readonly Format[] {
  if (scope === 'model') return AUDIO_FORMATS;
  if (scope === 'loop') return LOOP_FORMATS;
  if (scope === 'library') return LIBRARY_FORMATS;
  return FORMATS;
}

/**
 * The remembered choice for this menu, or {@link DEFAULT_FORMAT_ID}.
 *
 * Never throws: storage is disabled outright in some configurations, and a download
 * preference is not worth a blank page — the same trade `lib/library.ts` makes.
 */
export function loadFormat(scope: FormatScope): string {
  if (typeof window === 'undefined') return DEFAULT_FORMAT_ID;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY[scope]);
    if (stored !== null) return formatById(stored, formatsFor(scope)).id;
  } catch {
    /* Nothing to do and nothing worth saying. */
  }
  return DEFAULT_BY_SCOPE[scope];
}

/**
 * What each menu starts on.
 *
 * MP3 everywhere the bytes are ours to make — the first press of a download button is
 * nearly always "send this to someone". The library is the exception: those bytes are
 * somebody else's, and re-encoding a stranger's recording before anyone asked is a
 * quality loss taken on their behalf. So it starts on the file they uploaded.
 */
const DEFAULT_BY_SCOPE: Readonly<Record<FormatScope, string>> = {
  sound: DEFAULT_FORMAT_ID,
  model: DEFAULT_FORMAT_ID,
  loop: DEFAULT_FORMAT_ID,
  library: 'original',
};

/** Remember this choice for next time. Silent on failure, for the same reason. */
export function saveFormat(scope: FormatScope, id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY[scope], id);
  } catch {
    /* A choice that does not survive a reload still works for this session. */
  }
}

/**
 * Hand a blob to the browser as a download.
 *
 * Exported because the Search tab downloads bytes that were never rendered here — a
 * library's preview, fetched over the network — and a second copy of the object-URL
 * dance would be a second place to learn the Firefox revoke timing the hard way.
 */
export function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  /* Revoking on the next tick rather than immediately: Firefox has been observed to
     cancel a download whose object URL disappeared inside the same task. */
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Round a byte count for a status line. */
function size(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${String(Math.round(bytes / 1024))} kB`;
}

/**
 * What this format will weigh, before anything is encoded.
 *
 * The reason to show it *before* the click rather than in the toast after: the two
 * numbers people are choosing between here differ by an order of magnitude — a
 * two-second WAV at 24-bit is 288 kB and the same sound as MP3 is 48 — and that
 * difference is the whole argument for one entry over another. Discovering it in the
 * download folder is discovering it too late.
 *
 * WAV is exact arithmetic: header plus samples times bytes per sample, the same numbers
 * `encodeWav` writes. The compressed pair is bitrate times duration, which is what a CBR
 * encoder produces to within its own frame padding — a few hundred bytes on a sound this
 * short, well inside the rounding the label does anyway. `code` formats return null: the
 * JavaScript's size is known exactly by the compiler and is already printed on the Export
 * card, and a soundline is the text on screen.
 *
 * @returns Bytes, or null when this format's size cannot be known without doing the work.
 */
export function estimateBytes(format: Format, buffer: AudioBuffer | null): number | null {
  if (buffer === null || format.kind !== 'audio') return null;
  if (format.id === 'wav16' || format.id === 'wav24') {
    const bytesPerSample = format.id === 'wav24' ? 3 : 2;
    /* 44 bytes of RIFF header, and the channel count `encodeWav` actually writes. */
    return 44 + buffer.length * buffer.numberOfChannels * bytesPerSample;
  }
  if (CODEC[format.id] !== undefined) return Math.round((DEFAULT_BITRATE * 1000 * buffer.duration) / 8);
  return null;
}

/** A byte count as a menu shows it. Exported so every surface rounds the same way. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a download needs to know about the thing being downloaded. */
export interface Downloadable {
  readonly name: string;
  readonly source: string;
  readonly code: CodegenResult | null;
  readonly buffer: AudioBuffer | null;
}

/**
 * Download `subject` in `format`.
 *
 * @returns A sentence naming what happened, for the status line — including the refusals,
 *   because a Download button that does nothing is the worst outcome available and "there
 *   is nothing rendered to export" is an actionable one.
 */
export async function download(subject: Downloadable, format: Format): Promise<string> {
  const filename = `${subject.name}.${format.extension}`;

  if (format.id === 'soundline') {
    save(new Blob([subject.source], { type: format.mime }), filename);
    return t('dl.saved', { file: filename });
  }

  if (format.id === 'js') {
    if (subject.code === null) return t('dl.noCompile');
    save(new Blob([`export default ${subject.code.code};\n`], { type: format.mime }), filename);
    return t('dl.savedSize', { file: filename, size: `${String(subject.code.bytes)} B` });
  }

  if (subject.buffer === null) return t('dl.nothingRendered');

  const codec = CODEC[format.id];
  if (codec !== undefined) {
    try {
      const bytes = await encodeCompressed(subject.buffer, codec, DEFAULT_BITRATE);
      save(new Blob([bytes.slice().buffer as ArrayBuffer], { type: format.mime }), filename);
      return t('dl.savedSize', { file: filename, size: size(bytes.length) });
    } catch (error: unknown) {
      /* A capability problem, not a bug in the recipe. Name the format and leave the WAV
         entries — which need no encoder at all — as the obvious way forward. */
      return t('dl.encodeFail', {
        format: format.short,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const bytes = encodeWav(subject.buffer, { bitDepth: format.id === 'wav24' ? 24 : 16 });
  /* `slice()` for a fresh ArrayBuffer: the view may look into a larger allocation. */
  save(new Blob([bytes.slice().buffer as ArrayBuffer], { type: format.mime }), filename);
  return t('dl.savedSize', { file: filename, size: size(bytes.length) });
}

/**
 * Download a recipe that nothing on screen has compiled or rendered.
 *
 * The studio hands {@link download} an `AudioBuffer` and a `CodegenResult` it is already
 * holding; a gallery card holds neither — forty cards do not get forty compiles on the
 * way to first paint, and `useBars` renders one only to draw it. So this does the work
 * the chosen format actually needs and no more: `soundline` hands over the text it was
 * given, `js` compiles without rendering, and only the audio entries pay for a render.
 *
 * Failures come back as the same kind of sentence {@link download} returns, because they
 * land in the same toast: a recipe in the catalog that no longer parses is a real thing
 * to be told about, not a button that does nothing.
 */
export async function downloadRecipe(
  name: string,
  source: string,
  seed: number,
  format: Format,
): Promise<string> {
  const empty = { name, source, code: null, buffer: null };
  if (format.id === 'soundline') return download(empty, format);

  let ast;
  try {
    ast = parse(source);
  } catch {
    return t('dl.noCompile');
  }

  if (format.kind === 'code') {
    try {
      return await download({ ...empty, code: codegen(ast, { seed }) }, format);
    } catch {
      return t('dl.noCompile');
    }
  }

  try {
    const rendered = await render(ast, { seed });
    return await download({ ...empty, buffer: rendered.buffer }, format);
  } catch (error: unknown) {
    return t('dl.renderFail', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Copy text and report it, for the panels full of Copy buttons. */
export async function copy(text: string, what: string): Promise<string> {
  try {
    await navigator.clipboard.writeText(text);
    return t('dl.copied', { what });
  } catch {
    return t('dl.clipboardRefused');
  }
}
