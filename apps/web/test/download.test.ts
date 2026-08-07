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

import { describe, expect, it } from 'vitest';
import { FORMATS, formatById } from '../src/lib/download.js';
import { CONTAINER, DEFAULT_BITRATE, type CompressedCodec } from '../src/lib/encode.js';

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

  it('falls back to a real format for an id nobody offers', () => {
    expect(formatById('flac').id).toBe('wav16');
    expect(formatById('').id).toBe('wav16');
  });

  it('gives the split button a label short enough to fit it', () => {
    for (const format of FORMATS) expect(format.short.length, format.short).toBeLessThanOrEqual(9);
  });

  it('names a container for every codec the encoder knows', () => {
    const codecs: CompressedCodec[] = ['mp3', 'aac'];
    for (const codec of codecs) {
      expect(CONTAINER[codec].extension).toBeTruthy();
      expect(CONTAINER[codec].mime).toMatch(/^audio\//);
    }
  });
});
