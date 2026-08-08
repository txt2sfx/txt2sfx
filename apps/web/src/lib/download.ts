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
 * ## Nothing here is a renamed WAV
 *
 * MP3 and M4A are genuinely encoded — see `lib/encode.ts` for which libraries, and why
 * taking a dependency was the right call for exactly these two. If an encoder cannot be
 * resolved, the entry says so in a sentence; it never hands over the wrong bytes under
 * the right extension.
 *
 * @packageDocumentation
 */

import { encodeWav, type CodegenResult } from '@txt2sfx/core';
import { CONTAINER, DEFAULT_BITRATE, encodeCompressed, type CompressedCodec } from './encode.js';
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
  /** True for anything that has to be encoded, so the button can say it is working. */
  readonly slow?: boolean;
}

/** Everything on offer, in menu order. */
export const FORMATS: readonly Format[] = [
  { id: 'wav16', label: 'WAV · 16-bit', short: 'WAV 16', extension: 'wav', mime: 'audio/wav' },
  { id: 'wav24', label: 'WAV · 24-bit', short: 'WAV 24', extension: 'wav', mime: 'audio/wav' },
  {
    id: 'mp3',
    label: 'MP3 · 192 kbps',
    short: 'MP3',
    extension: CONTAINER.mp3.extension,
    mime: CONTAINER.mp3.mime,
    slow: true,
  },
  {
    id: 'm4a',
    label: 'M4A · AAC 192 kbps',
    short: 'M4A',
    extension: CONTAINER.aac.extension,
    mime: CONTAINER.aac.mime,
    slow: true,
  },
  { id: 'js', label: 'JavaScript · Web Audio', short: 'JS', extension: 'js', mime: 'text/javascript' },
  { id: 'soundline', label: 'soundline · text', short: 'soundline', extension: 'soundline', mime: 'text/plain' },
];

/** Which codec an id needs, or `null` for the formats that need no encoder. */
const CODEC: Readonly<Record<string, CompressedCodec>> = { mp3: 'mp3', m4a: 'aac' };

/** The format with this id, or the default. */
export function formatById(id: string): Format {
  return FORMATS.find((format) => format.id === id) ?? (FORMATS[0] as Format);
}

/** Hand a blob to the browser as a download. */
function save(blob: Blob, filename: string): void {
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

/** Copy text and report it, for the panels full of Copy buttons. */
export async function copy(text: string, what: string): Promise<string> {
  try {
    await navigator.clipboard.writeText(text);
    return t('dl.copied', { what });
  } catch {
    return t('dl.clipboardRefused');
  }
}
