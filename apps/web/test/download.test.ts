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
  downloadRecipe,
  estimateBytes,
  formatById,
  loadFormat,
  saveFormat,
  sizeLabel,
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

/* A gallery card compiles and renders at the moment a format is picked, which means the
   failure a studio download cannot have — a recipe that does not parse — is one this path
   reaches on every press. It has to come back as a sentence for the toast: a Download
   button that throws into the console is indistinguishable from one that does nothing.

   Only the refusals are exercised here. Everything past them saves a file, and a test that
   wanted to watch that happen would need a DOM and an audio stack for behaviour
   `download()` already owns. */
/**
 * What the menu promises before the click.
 *
 * The number is shown so the choice between entries can be made on the thing that
 * actually differs between them, so it has to be right for the reason the extension has
 * to be right: a WAV advertised at 48 kB and delivered at 288 is the same class of lie.
 */
describe('what a format will weigh', () => {
  /* One second, mono, 48 kHz — enough to check the arithmetic without a real decoder. */
  const buffer = { length: 48_000, duration: 1, numberOfChannels: 1, sampleRate: 48_000 } as AudioBuffer;

  it('counts a WAV exactly, header included', () => {
    expect(estimateBytes(formatById('wav16'), buffer)).toBe(44 + 48_000 * 2);
    expect(estimateBytes(formatById('wav24'), buffer)).toBe(44 + 48_000 * 3);
  });

  it('counts a stereo buffer per channel', () => {
    const stereo = { ...buffer, numberOfChannels: 2 } as AudioBuffer;
    expect(estimateBytes(formatById('wav16'), stereo)).toBe(44 + 48_000 * 2 * 2);
  });

  it('takes the compressed pair from the bitrate the encoder is actually given', () => {
    expect(estimateBytes(formatById('mp3'), buffer)).toBe((DEFAULT_BITRATE * 1000) / 8);
    expect(estimateBytes(formatById('m4a'), buffer)).toBe((DEFAULT_BITRATE * 1000) / 8);
  });

  /* The JavaScript's size is known exactly by the compiler and printed on the Export
     card; guessing at it here would put a second, worse number on the same screen. */
  it('says nothing about the two text formats, or about a sound not rendered yet', () => {
    expect(estimateBytes(formatById('js'), buffer)).toBeNull();
    expect(estimateBytes(formatById('soundline'), buffer)).toBeNull();
    expect(estimateBytes(formatById('mp3'), null)).toBeNull();
  });

  it('rounds the way every surface showing it rounds', () => {
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(48_000)).toBe('47 kB');
    expect(sizeLabel(3_500_000)).toBe('3.3 MB');
  });
});

describe('downloading a card, which has nothing compiled behind it', () => {
  it('reports a recipe that does not parse instead of throwing', async () => {
    const said = await downloadRecipe('broken', 'this is not a soundline', 1, formatById('mp3'));
    expect(said).toBe('the recipe does not compile — nothing to export');
  });

  it('says the same thing for the JavaScript, which needs the same parse', async () => {
    const said = await downloadRecipe('broken', 'this is not a soundline', 1, formatById('js'));
    expect(said).toBe('the recipe does not compile — nothing to export');
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
