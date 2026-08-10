/**
 * Dev-only door to a General MIDI bank already on the machine, for an A/B listen.
 *
 * ## What this is for, and what it is emphatically not
 *
 * It answers one question the tests cannot: *are the synthesized instruments close enough?*
 * `lib/gm.ts` mixes the current loop with samples from this bank instead of with soundline
 * voices, so the same eight bars can be heard both ways a click apart. That is a judgement
 * about sound, and the only instrument that can make it is an ear.
 *
 * It is **not** a second player. `apply: 'serve'` keeps it out of every static build, the client
 * is behind `import.meta.env.DEV`, nothing it produces can be exported, and the loop screen
 * says which of the two is sounding. A sample bank behind the export would make "a soundtrack
 * ships as a table of arrow functions, no sample data" a lie, and that claim is the reason this
 * screen exists — `lib/loop-export.ts` explains where a bank legitimately belongs instead, in
 * the program changes of the exported MIDI.
 *
 * ## It provisions nothing
 *
 * Same rule as `stable-audio.ts`. The bank is a file that is already there: Windows ships the
 * Roland GS set as `C:/Windows/System32/drivers/gm.dls`, and `TXT2SFX_GM_BANK` points at any
 * other DLS bank. Nothing is downloaded, and no bank is ever copied into this repository —
 * `gm.dls` is licensed to the machine it came with, and a 3 MB sample set in git would be both
 * a licence problem and the exact dependency this project does not have.
 *
 * The health route says plainly when there is no bank, and says so *with the path it looked at*,
 * because the alternative is a toggle that silently produces silence.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { platform } from 'node:process';
import type { Plugin } from 'vite';
import { monoPcm16, parseDls, regionFor, type DlsBank } from './dls.js';

/** Where Windows keeps the bank it ships. The one path worth trying without being told. */
const WINDOWS_BANK = 'C:/Windows/System32/drivers/gm.dls';

/** What the browser is told about the bank, before it asks for a single note. */
export interface GmHealth {
  readonly ok: boolean;
  /** The file that was read, or the one that was looked for. */
  readonly path: string;
  /** The bank's own name — "GS sound set (16 bit)" for the Windows one. */
  readonly name: string;
  readonly instruments: number;
  readonly waves: number;
  /** Present when `ok` is false: what went wrong, in a sentence a user can act on. */
  readonly reason?: string;
}

/** Serve `/__gm` — one health route and one note route. */
export function gmBank(): Plugin {
  /* Parsed once for the life of the dev server. The Windows bank is 3.4 MB and parses in about
     ten milliseconds, but it is also 495 wave entries held as subarray views over one buffer,
     and re-reading it per note would copy that buffer per note. */
  let bank: DlsBank | null = null;
  let failure: string | null = null;
  let path = '';

  const load = (): DlsBank | null => {
    if (bank !== null || failure !== null) return bank;
    path = process.env['TXT2SFX_GM_BANK'] ?? (platform === 'win32' ? WINDOWS_BANK : '');
    if (path === '') {
      failure =
        'No General MIDI bank configured. Set TXT2SFX_GM_BANK to a .dls bank; a .sf2 SoundFont is not read.';
      return null;
    }
    try {
      bank = parseDls(new Uint8Array(readFileSync(path)));
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error);
    }
    return bank;
  };

  return {
    name: 'txt2sfx:gm-bank',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__gm', (req, res, next) => {
        /* `use('/prefix')` strips the prefix, so this is '/' or '/note'. */
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');

        if (req.method === 'GET' && url.pathname === '/') {
          const loaded = load();
          const health: GmHealth =
            loaded === null
              ? { ok: false, path, name: '', instruments: 0, waves: 0, reason: failure ?? 'unknown' }
              : { ok: true, path, name: loaded.name, instruments: loaded.instruments.length, waves: loaded.waves.length };
          res.statusCode = loaded === null ? 200 : 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify(health));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/note') {
          const loaded = load();
          const program = Number(url.searchParams.get('program') ?? '0');
          const midi = Number(url.searchParams.get('midi') ?? '60');
          const drums = url.searchParams.get('drums') === '1';
          if (loaded === null) {
            res.statusCode = 503;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: failure ?? 'no bank' }));
            return;
          }
          const region = regionFor(loaded, program, midi, drums);
          const wave = region === undefined ? undefined : loaded.waves[region.wave];
          if (region === undefined || wave === undefined) {
            /* A miss is normal and not an error: a drum kit has no sample for every one of the
               128 keys, and a lane asking for one should fall silent for that note rather than
               fail the whole mixdown. */
            res.statusCode = 404;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: `no region for program ${String(program)} note ${String(midi)}` }));
            return;
          }
          /* The region's own sampler wins over the wave's, which is what an override is for; a
             region with neither is tuned to itself, so the note it was recorded at is the note
             being asked for. */
          const sampler = region.sampler ?? wave.sampler;
          const pcm = monoPcm16(wave);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/octet-stream');
          res.setHeader('cache-control', 'no-cache');
          res.setHeader('x-gm-rate', String(wave.sampleRate));
          res.setHeader('x-gm-root', String(sampler?.unityNote ?? midi));
          res.setHeader('x-gm-fine', String(sampler?.fineTuneCents ?? 0));
          res.setHeader('x-gm-gain-db', String(sampler?.attenuationDb ?? 0));
          res.setHeader('x-gm-loop-start', String(sampler?.loop?.start ?? -1));
          res.setHeader('x-gm-loop-length', String(sampler?.loop?.length ?? 0));
          res.end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
          return;
        }

        next();
      });
    },
  };
}
