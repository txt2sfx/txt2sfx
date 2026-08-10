/**
 * A reader for DLS Level 1/2 sound banks — the format Windows ships a General MIDI bank in.
 *
 * ## Why this exists at all, and why it is under `plugins/`
 *
 * The recurring request is "use one of the open General MIDI banks so the instruments sound
 * real". A bank cannot go into the player: a soundline compiles to a self-contained function
 * with no assets, and a sampler behind the loop screen would make "exports as code" a lie
 * (`lib/loop-voice.ts` says so in its header, and `lib/loop-export.ts` explains where a bank
 * *does* belong — the program changes in the exported MIDI). What a bank is genuinely good for
 * here is **A/B**: hearing the same eight bars played by a sample library tells you whether the
 * synthesized instruments are close enough, and that is a judgement no test can make.
 *
 * So this is a dev instrument, and it lives beside `stable-audio.ts` for the same reason and
 * under the same rule: `apply: 'serve'`, never reachable from a static build, and it
 * **provisions nothing**. It reads a bank that is already on the machine —
 * `C:/Windows/System32/drivers/gm.dls` on Windows, or whatever `TXT2SFX_GM_BANK` points at —
 * and it never copies one into the repository. That file is licensed to the machine it came
 * with; committing it or shipping it is exactly the thing not to do.
 *
 * ## Why DLS and not SoundFont
 *
 * Because DLS is the one that is already there. It is also the simpler format: SF2 keeps its
 * articulation in a "hydra" of generator and modulator lists that have to be resolved through
 * preset zones into instrument zones, while a DLS region says its key range, its sample and its
 * root note in three adjacent chunks. And every wave in the pool is a plain RIFF WAVE, so the
 * browser's own `decodeAudioData` can have it back almost verbatim.
 *
 * A `.sf2` will not load. That is a real limit and it is stated in the endpoint's health
 * response rather than left to be discovered as silence.
 *
 * ## What is deliberately not implemented
 *
 * The articulator lists (`lart` / `lar2`) — DLS's envelopes, LFOs and filter. A GM preview does
 * not need them: the loop's own note lengths supply the envelope, and a preview that got the
 * *pitch and the sample* right is already answering the question being asked. Reading them and
 * applying half of them would be worse than not reading them, because the result would look
 * like the bank's own sound and not be it.
 *
 * @packageDocumentation
 */

/** A four-character RIFF identifier and where its payload is. */
interface Chunk {
  readonly id: string;
  /** For a `LIST`, the list type that follows the size — `wave`, `ins `, `lrgn`. */
  readonly type: string | null;
  readonly start: number;
  readonly end: number;
}

/** How a sample is to be played: what note it was recorded at, and how it loops. */
export interface DlsSampler {
  /** MIDI note the sample sounds at unity playback rate. */
  readonly unityNote: number;
  /** Correction in cents, −50 … +50. */
  readonly fineTuneCents: number;
  /** Attenuation in decibels, never positive. */
  readonly attenuationDb: number;
  /** Loop points in *frames*, or null for a one-shot. */
  readonly loop: { readonly start: number; readonly length: number } | null;
}

/** One entry of the wave pool: a mono or stereo PCM sample and its default tuning. */
export interface DlsWave {
  readonly channels: number;
  readonly sampleRate: number;
  readonly bits: number;
  /** The `fmt ` chunk, verbatim, so a WAV can be rebuilt without re-deriving it. */
  readonly format: Uint8Array;
  /** The `data` chunk's payload, verbatim. */
  readonly data: Uint8Array;
  /** The wave's own sampler settings, used when a region does not override them. */
  readonly sampler: DlsSampler | null;
}

/** One key range of an instrument, pointing at a wave. */
export interface DlsRegion {
  readonly lowKey: number;
  readonly highKey: number;
  readonly lowVelocity: number;
  readonly highVelocity: number;
  /** Index into {@link DlsBank.waves}. */
  readonly wave: number;
  readonly sampler: DlsSampler | null;
}

/** One patch: a General MIDI program, or one drum kit. */
export interface DlsInstrument {
  readonly bank: number;
  readonly program: number;
  /** Percussion, from the high bit of the locale's bank field. Key *is* the instrument. */
  readonly drums: boolean;
  readonly name: string;
  readonly regions: readonly DlsRegion[];
}

/** A parsed bank. */
export interface DlsBank {
  readonly name: string;
  readonly instruments: readonly DlsInstrument[];
  readonly waves: readonly DlsWave[];
}

/** A chunk id, as four ASCII characters. */
function idAt(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)
  );
}

function i32(bytes: Uint8Array, at: number): number {
  return u32(bytes, at) | 0;
}

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function i16(bytes: Uint8Array, at: number): number {
  const value = u16(bytes, at);
  return value >= 0x8000 ? value - 0x10000 : value;
}

/**
 * The chunks directly inside a region of a RIFF file.
 *
 * Odd-sized chunks are padded to an even boundary and the pad byte is *not* counted in the
 * size — a reader that forgets that walks off by one into the next chunk's id and reports a
 * corrupt file, which is the classic way to fail at RIFF.
 */
function chunksIn(bytes: Uint8Array, from: number, to: number): Chunk[] {
  const found: Chunk[] = [];
  let at = from;
  while (at + 8 <= to) {
    const id = idAt(bytes, at);
    const size = u32(bytes, at + 4);
    const start = at + 8;
    const end = Math.min(to, start + size);
    const isList = id === 'LIST' || id === 'RIFF';
    found.push({ id, type: isList ? idAt(bytes, start) : null, start: isList ? start + 4 : start, end });
    at = start + size + (size % 2);
  }
  return found;
}

/** The first child with this id, or nothing. */
function child(chunks: readonly Chunk[], id: string, type?: string): Chunk | undefined {
  return chunks.find((chunk) => chunk.id === id && (type === undefined || chunk.type === type));
}

/** A `wsmp` chunk: root note, tuning, level and one loop at most. */
function readSampler(bytes: Uint8Array, chunk: Chunk): DlsSampler {
  const size = u32(bytes, chunk.start);
  const unityNote = u16(bytes, chunk.start + 4);
  /* sFineTune is in relative pitch units of 1/65536 semitone in DLS2 and in cents in some
     writers; gm.dls stays inside ±50, so it is read as cents and clamped rather than scaled by
     a constant that would be wrong for one of the two. */
  const fineTuneCents = Math.max(-1200, Math.min(1200, i16(bytes, chunk.start + 6)));
  /* lAttenuation is 1/655360 dB, and positive values exist in banks that expect a mixer to
     have headroom. This preview does not, so gain above unity is dropped. */
  const attenuationDb = Math.max(-96, Math.min(0, i32(bytes, chunk.start + 8) / 655360));
  const loops = u32(bytes, chunk.start + 16);
  let loop: DlsSampler['loop'] = null;
  if (loops > 0) {
    /* The loop records begin after the header, whose length the chunk declares — not at a
       fixed offset, because DLS1 and DLS2 headers differ in size. */
    const at = chunk.start + size;
    if (at + 16 <= chunk.end) loop = { start: u32(bytes, at + 8), length: u32(bytes, at + 12) };
  }
  return { unityNote, fineTuneCents, attenuationDb, loop };
}

/** One `wave` list of the pool. */
function readWave(bytes: Uint8Array, chunk: Chunk): DlsWave | null {
  const inner = chunksIn(bytes, chunk.start, chunk.end);
  const fmt = child(inner, 'fmt ');
  const data = child(inner, 'data');
  if (fmt === undefined || data === undefined) return null;
  const wsmp = child(inner, 'wsmp');
  return {
    channels: u16(bytes, fmt.start + 2),
    sampleRate: u32(bytes, fmt.start + 4),
    bits: u16(bytes, fmt.start + 14),
    format: bytes.subarray(fmt.start, fmt.end),
    data: bytes.subarray(data.start, data.end),
    sampler: wsmp === undefined ? null : readSampler(bytes, wsmp),
  };
}

/** One `rgn ` / `rgn2` list. */
function readRegion(bytes: Uint8Array, chunk: Chunk, waveOf: (index: number) => number): DlsRegion | null {
  const inner = chunksIn(bytes, chunk.start, chunk.end);
  const header = child(inner, 'rgnh');
  const link = child(inner, 'wlnk');
  if (header === undefined || link === undefined) return null;
  const wsmp = child(inner, 'wsmp');
  return {
    lowKey: u16(bytes, header.start),
    highKey: u16(bytes, header.start + 2),
    lowVelocity: u16(bytes, header.start + 4),
    highVelocity: u16(bytes, header.start + 6),
    wave: waveOf(u32(bytes, link.start + 8)),
    sampler: wsmp === undefined ? null : readSampler(bytes, wsmp),
  };
}

/** The `INAM` of an `INFO` list, or an empty string. */
function nameOf(bytes: Uint8Array, chunks: readonly Chunk[]): string {
  const info = child(chunks, 'LIST', 'INFO');
  if (info === undefined) return '';
  const inam = child(chunksIn(bytes, info.start, info.end), 'INAM');
  if (inam === undefined) return '';
  return String.fromCharCode(...bytes.subarray(inam.start, inam.end)).replace(/\0+$/, '').trim();
}

/**
 * Parse a DLS bank.
 *
 * Throws with what was actually found rather than "invalid file": the two readers of this
 * message are a developer who pointed the env var at the wrong path and a health endpoint
 * repeating it to a browser, and both need to know whether they handed it a SoundFont.
 */
export function parseDls(bytes: Uint8Array): DlsBank {
  const top = chunksIn(bytes, 0, bytes.length);
  const riff = top[0];
  if (riff === undefined || riff.id !== 'RIFF' || riff.type !== 'DLS ') {
    const saw = riff === undefined ? 'nothing' : `${riff.id} ${riff.type ?? ''}`.trim();
    const hint = idAt(bytes, 8) === 'sfbk' ? ' This is a SoundFont; only DLS banks are read.' : '';
    throw new Error(`not a DLS bank: expected a RIFF 'DLS ' header, found ${saw}.${hint}`);
  }

  const sections = chunksIn(bytes, riff.start, riff.end);

  /* The wave pool, and the cue table that indexes it. `wlnk.ulTableIndex` is an index into
     `ptbl`'s offsets, not into the waves in order — the two agree in every bank I have opened,
     and relying on that agreement is how a reader breaks on the one that reorders. */
  const pool = child(sections, 'LIST', 'wvpl');
  const waves: DlsWave[] = [];
  const waveAtOffset = new Map<number, number>();
  if (pool !== undefined) {
    for (const chunk of chunksIn(bytes, pool.start, pool.end)) {
      if (chunk.id !== 'LIST' || chunk.type !== 'wave') continue;
      const wave = readWave(bytes, chunk);
      if (wave === null) continue;
      /* The offset a cue holds is measured from the first byte of the first wave list, which
         is eight bytes before this list's payload plus its four-byte type. */
      waveAtOffset.set(chunk.start - 12 - pool.start, waves.length);
      waves.push(wave);
    }
  }

  const table = child(sections, 'ptbl');
  const cues: number[] = [];
  if (table !== undefined) {
    const size = u32(bytes, table.start);
    const count = u32(bytes, table.start + 4);
    for (let i = 0; i < count; i++) cues.push(u32(bytes, table.start + size + i * 4));
  }
  const waveOf = (index: number): number => {
    if (cues.length === 0) return index;
    const offset = cues[index];
    if (offset === undefined) return -1;
    return waveAtOffset.get(offset) ?? -1;
  };

  const instruments: DlsInstrument[] = [];
  const list = child(sections, 'LIST', 'lins');
  for (const chunk of list === undefined ? [] : chunksIn(bytes, list.start, list.end)) {
    if (chunk.id !== 'LIST' || chunk.type !== 'ins ') continue;
    const inner = chunksIn(bytes, chunk.start, chunk.end);
    const header = child(inner, 'insh');
    if (header === undefined) continue;
    const bank = u32(bytes, header.start + 4);
    const regions: DlsRegion[] = [];
    const lrgn = child(inner, 'LIST', 'lrgn');
    for (const entry of lrgn === undefined ? [] : chunksIn(bytes, lrgn.start, lrgn.end)) {
      if (entry.id !== 'LIST' || (entry.type !== 'rgn ' && entry.type !== 'rgn2')) continue;
      const region = readRegion(bytes, entry, waveOf);
      if (region !== null && region.wave >= 0) regions.push(region);
    }
    instruments.push({
      /* Bits 0–14 are the bank select pair; the top bit is the drum-kit flag, and leaving it in
         would put every kit at bank 32768 where no lookup finds it. */
      bank: bank & 0x3fff,
      program: u32(bytes, header.start + 8),
      drums: (bank & 0x80000000) !== 0,
      name: nameOf(bytes, inner),
      regions,
    });
  }

  return { name: nameOf(bytes, sections), instruments, waves };
}

/**
 * The region of a program that covers a note, or nothing.
 *
 * Velocity is ignored on purpose. A GM preview plays one layer per note, and choosing between
 * velocity splits would make the preview louder or duller than the arrangement it is standing
 * in for — a difference the ear would credit to the *bank* rather than to the layer switch.
 */
export function regionFor(bank: DlsBank, program: number, midi: number, drums: boolean): DlsRegion | undefined {
  /* A drum kit is one instrument whose *key* is the sound, so the standard kit is program 0
     with the drum flag set and the program argument does not apply to it. */
  const wanted = drums ? 0 : program;
  const instrument = bank.instruments.find(
    (entry) => entry.drums === drums && entry.bank === 0 && entry.program === wanted,
  );
  if (instrument === undefined) return undefined;
  return instrument.regions.find((region) => midi >= region.lowKey && midi <= region.highKey);
}

/**
 * A pool entry as mono 16-bit PCM, whatever it was stored as.
 *
 * The conversion happens here rather than in the browser so the wire contract is one thing —
 * *mono Int16, little-endian, at the rate in the header* — and the client needs no decoder and
 * no audio stack to read it. That is what lets the sampler in `lib/gm.ts` be plain arithmetic
 * over a `Float32Array`, testable in Node like the rest of the mixdown.
 */
export function monoPcm16(wave: DlsWave): Int16Array {
  const step = wave.channels < 1 ? 1 : wave.channels;
  if (wave.bits === 8) {
    /* 8-bit WAV data is *unsigned*, centred on 128 — reading it as signed is the classic way
       to get a sample that plays as loud noise. */
    const frames = Math.floor(wave.data.length / step);
    const out = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < step; c++) sum += ((wave.data[i * step + c] ?? 128) - 128) * 256;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(sum / step)));
    }
    return out;
  }
  const source = new Int16Array(wave.data.buffer, wave.data.byteOffset, Math.floor(wave.data.length / 2));
  if (step === 1) return Int16Array.from(source);
  const frames = Math.floor(source.length / step);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < step; c++) sum += source[i * step + c] ?? 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sum / step)));
  }
  return out;
}
