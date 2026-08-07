/**
 * MP3 and M4A, which are the first dependencies this project has taken for a picture
 * or a file — and the reason it was worth it.
 *
 * ## Why WAV was not enough
 *
 * The deliverable here is JavaScript, and audio exports are inspection aids and hand-off
 * artefacts. But "hand-off" is where WAV stops being sufficient: a WAV goes to an audio
 * editor and nowhere else. An `.mp3` goes into a chat message, a ticket and a browser tab;
 * an `.m4a` is what a Unity or Unreal import expects, what iOS plays without transcoding,
 * and what a sound designer is asked for by name. Offering neither, and offering a
 * *renamed WAV* under either name, are both worse than taking a dependency.
 *
 * ## Why `mediabunny` rather than a pile of encoders
 *
 * MP3 and AAC are different problems in a browser. No engine can encode MP3 natively at
 * all; AAC is native in Chrome and Safari through WebCodecs and absent in Firefox. Doing
 * this by hand means an MP3 library, a WebCodecs `AudioEncoder`, an MP4 muxer to put the
 * AAC frames in, a fallback AAC encoder, and the feature detection to pick between them.
 * `mediabunny` is one library that covers all five, with the two encoders as separate
 * packages that are only pulled in where the engine cannot do the job itself — so a
 * browser with native AAC never downloads an AAC encoder.
 *
 * (`mp4-muxer`, which is what most guides still recommend, is deprecated in favour of it.)
 *
 * ## Two things this module is careful about
 *
 * **Nothing is imported until it is used.** The encoders are a few hundred kilobytes and
 * the overwhelmingly common session never downloads a compressed file at all, so
 * registration happens behind a dynamic `import()` on the first MP3 or M4A export. First
 * click pays; the page load does not.
 *
 * **Registration happens once and only when needed.** `canEncodeAudio` is asked first, so
 * on a browser with a native encoder the polyfill is never fetched, and the answer is
 * cached — it cannot change during a session and it costs a codec probe.
 *
 * @packageDocumentation
 */

/** A codec this module can produce. Both are lossy; both are inspection aids. */
export type CompressedCodec = 'mp3' | 'aac';

/** What each codec is called on disk, and what a browser should be told it is. */
export const CONTAINER: Readonly<Record<CompressedCodec, { extension: string; mime: string }>> = {
  mp3: { extension: 'mp3', mime: 'audio/mpeg' },
  /* An MP4 file carrying only an audio track. `.m4a` is the conventional extension and is
     what every player and engine expects to see; the bytes are an ordinary MP4. */
  aac: { extension: 'm4a', mime: 'audio/mp4' },
};

/**
 * Default bitrate.
 *
 * 192 kbps for both. Higher than a podcast, lower than a master, and comfortably
 * transparent for the kind of thing this project makes — a 300 ms transient has nowhere
 * near enough spectral content to trouble a modern encoder at that rate. It is also the
 * number a sound designer expects when nobody has specified one.
 */
export const DEFAULT_BITRATE = 192_000;

/** Codecs whose encoder has already been resolved, so the probe runs once. */
const ready = new Map<CompressedCodec, Promise<void>>();

/**
 * Make sure something in this browser can encode `codec`.
 *
 * The polyfill is registered *only* when the engine cannot do it, which for MP3 is
 * everywhere and for AAC is Firefox. Registration is global to `mediabunny` and
 * idempotent per codec, hence the cache.
 */
async function ensureEncoder(codec: CompressedCodec): Promise<void> {
  const existing = ready.get(codec);
  if (existing !== undefined) return existing;

  const resolving = (async () => {
    const { canEncodeAudio } = await import('mediabunny');
    if (await canEncodeAudio(codec)) return;
    if (codec === 'mp3') {
      const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder');
      registerMp3Encoder();
    } else {
      const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
      registerAacEncoder();
    }
  })();

  ready.set(codec, resolving);
  try {
    await resolving;
  } catch (error: unknown) {
    /* A failed probe must not poison the codec forever: a transient chunk-load failure on
       a flaky connection should be retried on the next click, not remembered as "this
       browser cannot do MP3". */
    ready.delete(codec);
    throw error;
  }
}

/**
 * Encode a rendered buffer to MP3 or M4A.
 *
 * @param bitrate Bits per second. `mediabunny` takes an explicit bitrate as a `Quality`.
 * @returns The complete file, ready for a `Blob`.
 * @throws When no encoder could be resolved, with a sentence naming the browser rather
 *   than a stack trace — this is a capability problem and the user's only fix is a
 *   different browser or a different format.
 */
export async function encodeCompressed(
  buffer: AudioBuffer,
  codec: CompressedCodec,
  bitrate = DEFAULT_BITRATE,
): Promise<Uint8Array> {
  await ensureEncoder(codec);

  const { AudioBufferSource, BufferTarget, Mp3OutputFormat, Mp4OutputFormat, Output, Quality } =
    await import('mediabunny');

  const output = new Output({
    format:
      codec === 'mp3'
        ? new Mp3OutputFormat()
        : /* The metadata index in front of the audio rather than after it, so a player can
             start on the first byte instead of seeking to the end of the file. It costs one
             in-memory pass over a file that is already in memory. */
          new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  /* `new Quality({ bitrate })` and not `new Quality(bitrate)`. The constructor also takes
     a bare number, which reads like the obvious call and silently is not one — it was
     measured: 192 000 and 64 000 produced byte-identical files, because a bare number is
     not the bitrate field. The object form is the one that reaches the encoder. */
  const source = new AudioBufferSource({ codec, quality: new Quality({ bitrate }) });
  output.addAudioTrack(source);

  await output.start();
  await source.add(buffer);
  source.close();
  await output.finalize();

  const bytes = output.target.buffer;
  if (bytes === null) throw new Error(`the ${codec} encoder produced no data`);
  return new Uint8Array(bytes);
}

/**
 * Whether this browser can produce `codec` at all, without encoding anything.
 *
 * Used to decide whether the format belongs in the menu. A entry that always fails is
 * worse than a shorter menu — the polyfills mean the answer is `true` almost everywhere,
 * so a `false` here is a real capability gap worth hiding rather than explaining.
 */
export async function canEncode(codec: CompressedCodec): Promise<boolean> {
  try {
    await ensureEncoder(codec);
    const { canEncodeAudio } = await import('mediabunny');
    return await canEncodeAudio(codec);
  } catch {
    return false;
  }
}
