/**
 * The download menu, and the one property it must never lose.
 *
 * **No entry may hand over bytes that are not what its label says.** That sounds
 * obvious until you have watched a codebase grow an `MP3` button that ships a renamed
 * WAV because the encoder was "coming later". This project's README spends a section
 * on being honest about limits, and a lying file extension is the cheapest way to
 * throw that away — so the mapping from label to container to encoder is pinned here.
 *
 * @packageDocumentation
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIO_FORMATS,
  DEFAULT_FORMAT_ID,
  FORMATS,
  formatById,
  loadFormat,
  saveFormat,
} from '../src/lib/download.js';
import { CONTAINER, DEFAULT_BITRATE, type CompressedCodec } from '../src/lib/encode.js';

/**
 * The smallest `localStorage` the preference needs — the same in-memory stand-in
 * `library.test.ts` uses, for the same reason: a DOM implementation would be a
 * dependency, and the surface under test is two methods.
 */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => map.set(key, value),
  } as Storage;
}

Object.defineProperty(globalThis, 'window', {
  value: { localStorage: fakeStorage() },
  configurable: true,
  writable: true,
});

describe('the download menu', () => {
  it('offers the three audio formats that were asked for, plus the two text ones', () => {
    expect(FORMATS.map((format) => format.id)).toEqual(['wav16', 'wav24', 'mp3', 'm4a', 'js', 'soundline']);
  });

  it('gives every entry an extension that matches what it actually contains', () => {
    const byId = Object.fromEntries(FORMATS.map((format) => [format.id, format]));
    expect(byId['wav16']?.extension).toBe('wav');
    expect(byId['wav24']?.extension).toBe('wav');
    /* Both of these come from `encode.ts` rather than being spelled twice, so the menu
       and the encoder cannot disagree about what an AAC file is called. */
    expect(byId['mp3']?.extension).toBe(CONTAINER.mp3.extension);
    expect(byId['m4a']?.extension).toBe(CONTAINER.aac.extension);
    expect(byId['m4a']?.extension).toBe('m4a');
    expect(byId['js']?.extension).toBe('js');
    expect(byId['soundline']?.extension).toBe('soundline');
  });

  it('declares the right MIME type for each, including the MP4 container behind .m4a', () => {
    const mime = Object.fromEntries(FORMATS.map((format) => [format.id, format.mime]));
    expect(mime['wav16']).toBe('audio/wav');
    expect(mime['wav24']).toBe('audio/wav');
    expect(mime['mp3']).toBe('audio/mpeg');
    /* `.m4a` is an MP4 file with only an audio track — the extension is a convention,
       the MIME type is the truth. */
    expect(mime['m4a']).toBe('audio/mp4');
  });

  /* The regression this file exists to prevent: nothing may claim a lossy codec unless
     something actually encodes it. If a format is added whose label names a codec, it
     has to be routed through `encode.ts` and marked slow. */
  it('marks exactly the entries that need a real encoder', () => {
    const slow = FORMATS.filter((format) => format.slow === true).map((format) => format.id);
    expect(slow).toEqual(['mp3', 'm4a']);
    /* And nothing else pretends to be compressed audio. */
    for (const format of FORMATS) {
      const claimsLossy = /mp3|aac|opus|vorbis|m4a/i.test(format.label);
      expect(claimsLossy, format.label).toBe(format.slow === true);
    }
  });

  it('states the bitrate it will actually use, in the label and in the encoder', () => {
    expect(DEFAULT_BITRATE).toBe(192_000);
    for (const id of ['mp3', 'm4a']) {
      expect(formatById(id).label, id).toContain('192 kbps');
    }
  });

  it('keeps the two text formats last in the menu and free of an encoder', () => {
    const tail = FORMATS.slice(-2);
    expect(tail.map((format) => format.id)).toEqual(['js', 'soundline']);
    for (const format of tail) expect(format.slow).toBeUndefined();
  });

  it('falls back to the default for an id nobody offers', () => {
    expect(formatById('flac').id).toBe(DEFAULT_FORMAT_ID);
    expect(formatById('').id).toBe(DEFAULT_FORMAT_ID);
  });

  /* The button that is pressed to send a sound to a person is the one that has to work
     without a choice being made first, and MP3 is the only entry that plays everywhere.
     The JavaScript is not demoted by this: the Export card carries it separately. */
  it('preselects a format both menus can actually offer', () => {
    expect(DEFAULT_FORMAT_ID).toBe('mp3');
    expect(FORMATS.some((format) => format.id === DEFAULT_FORMAT_ID)).toBe(true);
    expect(AUDIO_FORMATS.some((format) => format.id === DEFAULT_FORMAT_ID)).toBe(true);
  });

  it('gives the split button a label short enough to fit it', () => {
    for (const format of FORMATS) expect(format.short.length, format.short).toBeLessThanOrEqual(9);
  });

  /* The Model tab downloads a diffusion render, which no recipe in this tab produced.
     `js` and `soundline` there would hand over the *editor's* recipe under the model's
     file name — the same class of lie as a renamed WAV, which is what this file exists
     to prevent. */
  it('offers the model tab audio only, and nothing that would export a recipe', () => {
    expect(AUDIO_FORMATS.map((format) => format.id)).toEqual(['wav16', 'wav24', 'mp3', 'm4a']);
    for (const format of AUDIO_FORMATS) expect(format.kind, format.id).toBe('audio');
    expect(FORMATS.filter((format) => format.kind === 'code').map((format) => format.id)).toEqual([
      'js',
      'soundline',
    ]);
  });

  it('names a container for every codec the encoder knows', () => {
    const codecs: CompressedCodec[] = ['mp3', 'aac'];
    for (const codec of codecs) {
      expect(CONTAINER[codec].extension).toBeTruthy();
      expect(CONTAINER[codec].mime).toMatch(/^audio\//);
    }
  });
});

describe('the remembered choice', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts at the default and round-trips a choice per scope', () => {
    expect(loadFormat('sound')).toBe(DEFAULT_FORMAT_ID);
    expect(loadFormat('model')).toBe(DEFAULT_FORMAT_ID);
    saveFormat('sound', 'js');
    saveFormat('model', 'wav24');
    expect(loadFormat('sound')).toBe('js');
    expect(loadFormat('model')).toBe('wav24');
  });

  /* The whole reason there are two keys: picking WAV for a model target must not
     silently re-aim the recipe's Download button away from the deliverable. */
  it('keeps each menu out of the other one’s memory', () => {
    saveFormat('model', 'wav16');
    expect(loadFormat('sound')).toBe(DEFAULT_FORMAT_ID);
    saveFormat('sound', 'soundline');
    expect(loadFormat('model')).toBe('wav16');
  });

  /* `localStorage` is shared with every other page on the origin and can be edited by
     hand; a preference must never be able to select a menu entry that is not there. */
  it('refuses a stored id the asking menu does not offer', () => {
    window.localStorage.setItem('txt2sfx.format.model.v1', 'js');
    expect(loadFormat('model')).toBe(DEFAULT_FORMAT_ID);
    window.localStorage.setItem('txt2sfx.format.v1', 'flac');
    expect(loadFormat('sound')).toBe(DEFAULT_FORMAT_ID);
  });
});
