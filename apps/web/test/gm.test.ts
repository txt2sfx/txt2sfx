/**
 * The dev-only General MIDI preview, and the three ways a sampler lies quietly.
 *
 * 1. **A RIFF reader that walks off by one.** Odd-sized chunks are padded and the pad is not
 *    counted in the size; a reader that forgets it lands in the middle of the next chunk's id
 *    and reports a corrupt bank. Every field below is asserted against a bank built here byte
 *    by byte, so a regression names the field rather than the file.
 * 2. **A unit guessed wrong.** `lAttenuation` is 1/655360 dB and `sFineTune` is cents, and
 *    either read at the wrong scale gives a preview that is quietly 40 dB down or a semitone
 *    off — which an ear blames on the bank.
 * 3. **A resampler that ignores the source rate.** A bank sample at 22050 Hz played into a
 *    44100 Hz mix without that ratio is an octave low, and "the bank sounds wrong" is the last
 *    place anybody looks for an arithmetic bug.
 *
 * The bank is synthesized here rather than read from the machine, because `gm.dls` exists only
 * on Windows and a test that skips itself on CI is a test that does not run. The one assertion
 * that *does* use the machine's bank is guarded and says so.
 *
 * @packageDocumentation
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OfflineAudioContext as NodeOfflineAudioContext } from 'node-web-audio-api';
import { monoPcm16, parseDls, regionFor } from '../plugins/dls.js';
import { playSample, renderLoopFromBank, type BankSample } from '../src/lib/gm.js';
import { CEILING, SAMPLE_RATE } from '../src/lib/loop-render.js';
import { composeTrack, loopSeconds, paletteFor } from '../src/lib/loop.js';

/* ------------------------------------------------------------------------- *
 * A bank, built by hand
 * ------------------------------------------------------------------------- */

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function u16(value: number): Uint8Array {
  return bytes(value & 0xff, (value >>> 8) & 0xff);
}

function u32(value: number): Uint8Array {
  return bytes(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function join(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  return new Uint8Array([...text].map((character) => character.charCodeAt(0)));
}

/** A chunk, padded to an even length exactly as RIFF requires. */
function chunk(id: string, payload: Uint8Array): Uint8Array {
  const pad = payload.length % 2 === 1 ? bytes(0) : bytes();
  return join(ascii(id), u32(payload.length), payload, pad);
}

function list(type: string, ...children: readonly Uint8Array[]): Uint8Array {
  return chunk('LIST', join(ascii(type), ...children));
}

/** `wsmp`: root note, cents, attenuation in 1/655360 dB, and one loop. */
function wsmp(root: number, cents: number, attenuation: number, loop: [number, number] | null): Uint8Array {
  return chunk(
    'wsmp',
    join(
      u32(20),
      u16(root),
      u16(cents < 0 ? cents + 0x10000 : cents),
      u32(attenuation < 0 ? attenuation + 0x100000000 : attenuation),
      u32(0),
      u32(loop === null ? 0 : 1),
      ...(loop === null ? [] : [u32(16), u32(0), u32(loop[0]), u32(loop[1])]),
    ),
  );
}

/** One wave of the pool: mono 16-bit at `rate`, with `frames` as its samples. */
function wave(rate: number, frames: readonly number[]): Uint8Array {
  return list(
    'wave',
    chunk('fmt ', join(u16(1), u16(1), u32(rate), u32(rate * 2), u16(2), u16(16))),
    chunk('data', join(...frames.map((value) => u16(value < 0 ? value + 0x10000 : value)))),
  );
}

/** A whole bank: one melodic instrument, one drum kit, two waves. */
function bank(): Uint8Array {
  const guitar = list(
    'ins ',
    chunk('insh', join(u32(1), u32(0), u32(30))),
    list(
      'lrgn',
      list(
        'rgn ',
        chunk('rgnh', join(u16(0), u16(127), u16(0), u16(127), u16(0), u16(0))),
        /* Root 60, −25 cents, −1 dB, looping four frames from frame 2. */
        wsmp(60, -25, -655360, [2, 4]),
        chunk('wlnk', join(u16(0), u16(0), u32(0), u32(0))),
      ),
    ),
    list('INFO', chunk('INAM', ascii('DistortionGt\0'))),
  );
  /* A kit: the drum flag in the high bit of the locale's bank field, and a region that covers
     one key only — which is what makes a lookup for another key a legitimate miss. */
  const kit = list(
    'ins ',
    chunk('insh', join(u32(1), u32(0x80000000), u32(0))),
    list(
      'lrgn',
      list(
        'rgn ',
        chunk('rgnh', join(u16(36), u16(36), u16(0), u16(127), u16(0), u16(0))),
        wsmp(36, 0, 0, null),
        chunk('wlnk', join(u16(0), u16(0), u32(0), u32(1))),
      ),
    ),
    list('INFO', chunk('INAM', ascii('Standard Kit\0'))),
  );

  const first = wave(22050, [0, 8192, 16384, 8192, 0, -8192, -16384, -8192]);
  const second = wave(44100, [0, 32767, 0, -32767]);
  /* The cue table holds byte offsets from the first wave list, which is why the second entry is
     the length of the first one — an off-by-twelve here resolves every region to wave 0. */
  const cues = chunk('ptbl', join(u32(8), u32(2), u32(0), u32(first.length)));

  return chunk(
    'RIFF',
    join(
      ascii('DLS '),
      chunk('colh', u32(2)),
      list('lins', guitar, kit),
      cues,
      list('wvpl', first, second),
      list('INFO', chunk('INAM', ascii('Test bank\0'))),
    ),
  );
}

/* ------------------------------------------------------------------------- *
 * The reader
 * ------------------------------------------------------------------------- */

describe('the DLS reader', () => {
  const parsed = parseDls(bank());

  it('reads the bank, its instruments and its wave pool', () => {
    expect(parsed.name).toBe('Test bank');
    expect(parsed.waves.length).toBe(2);
    expect(parsed.instruments.length).toBe(2);
    const guitar = parsed.instruments[0];
    expect(guitar?.name).toBe('DistortionGt');
    expect(guitar?.program).toBe(30);
    expect(guitar?.bank).toBe(0);
    expect(guitar?.drums).toBe(false);
  });

  it('keeps the drum flag out of the bank number', () => {
    /* The flag is the high bit of the same field. Left in, every kit sits at bank 2147483648
       and no lookup that asks for bank 0 ever finds one. */
    const kit = parsed.instruments[1];
    expect(kit?.drums).toBe(true);
    expect(kit?.bank).toBe(0);
    expect(kit?.program).toBe(0);
  });

  it('reads a sampler at the scale the format uses, not at a guessed one', () => {
    const sampler = parsed.instruments[0]?.regions[0]?.sampler;
    expect(sampler?.unityNote).toBe(60);
    /* Cents, signed. Read as 1/65536 semitones this would be 0. */
    expect(sampler?.fineTuneCents).toBe(-25);
    /* 1/655360 dB. Read as 1/65536 it would be −10 dB, a tenfold error in level. */
    expect(sampler?.attenuationDb).toBeCloseTo(-1, 6);
    expect(sampler?.loop).toEqual({ start: 2, length: 4 });
  });

  it('resolves a region through the cue table rather than by ordinal', () => {
    /* The kit's `wlnk` names cue 1, whose offset is the *second* wave. A reader that treated
       the index as an ordinal into the pool would agree here by accident and disagree on any
       bank whose cues are not in order — so the offsets are what is asserted. */
    expect(parsed.instruments[0]?.regions[0]?.wave).toBe(0);
    expect(parsed.instruments[1]?.regions[0]?.wave).toBe(1);
    expect(parsed.waves[0]?.sampleRate).toBe(22050);
    expect(parsed.waves[1]?.sampleRate).toBe(44100);
  });

  it('finds the region a note falls in, and misses honestly when there is none', () => {
    expect(regionFor(parsed, 30, 45, false)?.wave).toBe(0);
    /* A drum kit is one instrument whose key is the sound, so the program argument does not
       apply to it — and a key it has no sample for is a miss, not an error: the mixdown drops
       that note instead of failing. */
    expect(regionFor(parsed, 0, 36, true)?.wave).toBe(1);
    expect(regionFor(parsed, 0, 38, true)).toBeUndefined();
    expect(regionFor(parsed, 99, 60, false)).toBeUndefined();
  });

  it('says what it was handed when it is not a DLS bank', () => {
    /* Both readers of this message need to know *which* format they pointed it at — a
       SoundFont is the likely mistake, and "invalid file" would send someone looking at the
       path instead of at the extension. */
    expect(() => parseDls(join(ascii('RIFF'), u32(4), ascii('sfbk')))).toThrow(/SoundFont/);
    expect(() => parseDls(ascii('not riff at all'))).toThrow(/not a DLS bank/);
  });

  it('hands over mono 16-bit samples whatever the pool stored', () => {
    const pcm = monoPcm16(parsed.waves[0] as never);
    expect(pcm.length).toBe(8);
    expect([...pcm.slice(0, 3)]).toEqual([0, 8192, 16384]);
  });
});

/* ------------------------------------------------------------------------- *
 * The sampler
 * ------------------------------------------------------------------------- */

describe('the bank sampler', () => {
  /** A ramp at the mix's own rate, so a pitch ratio is legible in the output. */
  const ramp = (frames: number, rate = SAMPLE_RATE): BankSample => ({
    frames: Float32Array.from({ length: frames }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5)),
    rate,
    root: 60,
    fineCents: 0,
    gain: 1,
    loop: null,
  });

  it('plays a one-shot for as long as it lasts, not for as long as the note', () => {
    /* A cymbal rings for seconds under a sixteenth note. Cutting the sample at the note is how
       every kit in a GM preview would come out gated. */
    const played = playSample(ramp(SAMPLE_RATE), 60, 0.05, 1);
    expect(played.length).toBeGreaterThan(0.5 * SAMPLE_RATE);
  });

  it('consumes the source twice as fast an octave up, and accounts for the source rate', () => {
    const long = ramp(SAMPLE_RATE);
    /* The release is *added* to the sounding part rather than scaled with it, so it comes off
       before the ratio is checked — a comparison that forgets that is off by 4% and passes for
       the wrong reason with a loose tolerance. */
    const sounding = (midi: number, rate = SAMPLE_RATE): number =>
      playSample({ ...long, rate }, midi, 10, 1).length - 0.04 * SAMPLE_RATE;
    const unity = sounding(60);
    /* One second of source at 44100 into a 44100 mix. */
    expect(unity).toBeCloseTo(SAMPLE_RATE, -2);
    expect(sounding(72)).toBeCloseTo(unity / 2, -2);
    expect(sounding(48)).toBeCloseTo(unity * 2, -2);
    /* And the same sample declared at half the mix's rate lasts twice as long — the ratio a
       reader forgets, which sounds exactly like a bank tuned an octave low. */
    expect(sounding(60, SAMPLE_RATE / 2)).toBeCloseTo(unity * 2, -2);
  });

  it('holds a looped sample for the note and then releases it', () => {
    const held: BankSample = { ...ramp(64), loop: { start: 8, length: 16 } };
    const short = playSample(held, 60, 0.1, 1);
    const long = playSample(held, 60, 0.4, 1);
    /* Sixty-four frames is a millisecond and a half of sample; without the loop neither of
       these could reach a tenth of a second, let alone differ. */
    expect(short.length).toBeCloseTo(0.14 * SAMPLE_RATE, -2);
    expect(long.length).toBeCloseTo(0.44 * SAMPLE_RATE, -2);
    /* Both ends taper, or every note in the preview starts and stops with a click. */
    expect(Math.abs(long[0] ?? 1)).toBeLessThan(0.05);
    expect(Math.abs(long[long.length - 1] ?? 1)).toBeLessThan(0.05);
    /* And the middle is at level: a fade that never finished would be a quiet preview blamed
       on the bank. */
    const middle = Math.max(...[...long.slice(long.length >> 1, (long.length >> 1) + 200)].map(Math.abs));
    expect(middle).toBeGreaterThan(0.4);
  });

  it('scales by the velocity of the note and by the attenuation of the region', () => {
    const loud = playSample({ ...ramp(64), loop: { start: 8, length: 16 } }, 60, 0.2, 1);
    const quiet = playSample({ ...ramp(64), loop: { start: 8, length: 16 } }, 60, 0.2, 0.25);
    const peak = (samples: Float32Array): number => Math.max(...[...samples].map(Math.abs));
    expect(peak(quiet)).toBeCloseTo(peak(loud) * 0.25, 2);
    /* The bank's own level is a second, independent factor — a region cut by 6 dB has to stay
       cut when the note is played at full velocity. */
    const attenuated = playSample(
      { ...ramp(64), loop: { start: 8, length: 16 }, gain: 0.5 },
      60,
      0.2,
      1,
    );
    expect(peak(attenuated)).toBeCloseTo(peak(loud) * 0.5, 2);
  });

  it('survives a region that lies about its loop', () => {
    /* A loop longer than the sample, or one that does not advance, would spin forever inside
       the mixdown — a hung tab rather than a wrong sound. */
    const broken: BankSample = { ...ramp(32), loop: { start: 0, length: 0 } };
    expect(playSample(broken, 60, 0.2, 1).length).toBeGreaterThan(0);
    const past: BankSample = { ...ramp(32), loop: { start: 100, length: 200 } };
    expect(playSample(past, 60, 0.2, 1).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------- *
 * The machine's own bank
 * ------------------------------------------------------------------------- */

/**
 * The bank Windows ships, when this is running on Windows.
 *
 * Guarded rather than skipped silently: a hand-built bank proves the reader reads what this
 * file wrote, and only a real one proves it reads what a real writer wrote. 235 instruments and
 * 495 waves is what `gm.dls` contains, and getting a plausible-looking wrong answer out of a
 * 3 MB file is entirely possible.
 */
const WINDOWS_BANK = 'C:/Windows/System32/drivers/gm.dls';

describe.runIf(existsSync(WINDOWS_BANK))('the bank Windows ships', () => {
  it('reads all 128 General MIDI programs and at least one kit out of gm.dls', () => {
    const real = parseDls(new Uint8Array(readFileSync(WINDOWS_BANK)));
    const melodic = real.instruments.filter((entry) => !entry.drums && entry.bank === 0);
    expect(new Set(melodic.map((entry) => entry.program)).size).toBe(128);
    expect(real.instruments.some((entry) => entry.drums)).toBe(true);
    expect(real.waves.length).toBeGreaterThan(100);

    /* The instruments this repository's own lanes ask for, by program number. A region that
       resolves to a wave with a root note and frames is the whole contract the preview needs. */
    for (const program of [30, 16, 61, 52, 4, 24, 38, 48]) {
      const region = regionFor(real, program, 45, false);
      expect(region, `program ${String(program)}`).toBeDefined();
      const found = region === undefined ? undefined : real.waves[region.wave];
      expect(found?.data.length ?? 0, `program ${String(program)}`).toBeGreaterThan(0);
      expect(found?.sampleRate ?? 0).toBeGreaterThan(8000);
    }
    /* Every region resolves to a wave that exists — the cue table is the one place a 3 MB file
       can disagree with a reader and still look parsed. */
    for (const instrument of real.instruments) {
      for (const region of instrument.regions) {
        expect(real.waves[region.wave], `${instrument.name} wave ${String(region.wave)}`).toBeDefined();
      }
    }
  });

  /**
   * The whole client path, without a browser.
   *
   * `renderLoopFromBank` is the only part of this feature a unit test can otherwise not reach:
   * it reads the wire headers, resamples every note, sums through `mixLoop` and reports headroom.
   * Standing the endpoint up as a `fetch` stub over the *same* plugin code the dev server runs
   * makes that whole chain testable — and it is the chain where a wrong header name or a missing
   * source-rate ratio produces a mix that is silent, or an octave out, in a browser only.
   */
  it('mixes a whole arrangement from the bank, through the same summation the synth mix uses', async () => {
    const real = parseDls(new Uint8Array(readFileSync(WINDOWS_BANK)));
    const previousFetch = globalThis.fetch;
    const previousContext = globalThis.OfflineAudioContext;
    let served = 0;
    let missed = 0;

    globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost');
      const program = Number(url.searchParams.get('program') ?? '0');
      const midi = Number(url.searchParams.get('midi') ?? '60');
      const drums = url.searchParams.get('drums') === '1';
      const region = regionFor(real, program, midi, drums);
      const wave = region === undefined ? undefined : real.waves[region.wave];
      if (region === undefined || wave === undefined) {
        missed++;
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      served++;
      const sampler = region.sampler ?? wave.sampler;
      const pcm = monoPcm16(wave);
      return Promise.resolve(
        new Response(pcm.buffer as ArrayBuffer, {
          status: 200,
          headers: {
            'x-gm-rate': String(wave.sampleRate),
            'x-gm-root': String(sampler?.unityNote ?? midi),
            'x-gm-fine': String(sampler?.fineTuneCents ?? 0),
            'x-gm-gain-db': String(sampler?.attenuationDb ?? 0),
            'x-gm-loop-start': String(sampler?.loop?.start ?? -1),
            'x-gm-loop-length': String(sampler?.loop?.length ?? 0),
          },
        }),
      );
    }) as typeof fetch;
    globalThis.OfflineAudioContext = NodeOfflineAudioContext as unknown as typeof OfflineAudioContext;

    try {
      const palette = paletteFor('', ['aggressive', 'guitar', 'riff', 'march']);
      const track = composeTrack('gm', palette, palette.prompt, 'gm', 'test');
      const mixed = await renderLoopFromBank(track, {});

      expect(served).toBeGreaterThan(0);
      expect(missed).toBe(0);
      expect(mixed.notes).toBe(track.lanes.reduce((total, lane) => total + lane.notes.length, 0));
      expect(mixed.voices).toBeGreaterThan(3);
      /* Audible, and inside the ceiling after the same headroom scaling the synth mix gets —
         a sampler that ignored the source rate would still make a sound here, so the peak is
         asserted as a range rather than as "not zero". */
      const data = mixed.buffer.getChannelData(0);
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value));
      expect(peak).toBeGreaterThan(0.2);
      expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
      expect(mixed.buffer.length).toBe(Math.round(loopSeconds(track) * SAMPLE_RATE));

      /* Muting is the same contract as the synth path: it re-mixes rather than gating, so a
         muted lane costs notes rather than silencing a monitor. */
      const fewer = await renderLoopFromBank(track, { muted: new Set(['drums']) });
      expect(fewer.notes).toBeLessThan(mixed.notes);
    } finally {
      globalThis.fetch = previousFetch;
      globalThis.OfflineAudioContext = previousContext;
    }
  }, 120000);
});
