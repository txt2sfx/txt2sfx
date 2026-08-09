/**
 * The microphone as a B side.
 *
 * ## Why this exists next to the file picker
 *
 * The fastest way to say what a sound should be is to make it: knock on the desk, hiss,
 * click a pen. That target costs a second and never existed as a file, so the road that
 * starts at a file picker cannot reach it. What comes out of here is a `File` all the
 * same — decoded by `decodeAudioFile` like any other B, so there stays exactly one place
 * in the app that knows what a reference is.
 *
 * ## Why the browser's voice processing is turned off
 *
 * `getUserMedia` defaults to echo cancellation, noise suppression and automatic gain —
 * three filters tuned for speech on a call. Every one of them destroys precisely what a
 * fit is trying to match: noise suppression eats the broadband part of a knock, AGC
 * flattens the attack that the distance weights most, and echo cancellation reacts to
 * whatever the tab is playing, which here is the candidate. A recording made through
 * them is a recording of the processing.
 *
 * ## Why the container is chosen by a pure function
 *
 * `MediaRecorder` takes a MIME type it may refuse, and which one it accepts is a browser
 * fact: Chrome and Firefox record WebM, Safari only ever MP4. That choice is the one part
 * of this module worth a test, and the tests run in node where `MediaRecorder` does not
 * exist — so the decision is a function of `isTypeSupported` and nothing else.
 *
 * Samples are not copied here: nothing in this module holds any. Decoding happens in
 * `lib/analysis.ts` and the extraction that must copy — `targetFromBuffer` — already does.
 *
 * @packageDocumentation
 */

/**
 * Containers to offer `MediaRecorder`, best first.
 *
 * Opus in WebM is what Chrome and Firefox produce natively and what `decodeAudioData`
 * reads back without a detour; Ogg is Firefox's older answer to the same request; MP4
 * (AAC) is the only thing Safari will record at all. The list is ordered by what decodes
 * back most faithfully, not by market share.
 */
export const RECORDING_MIME_TYPES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

/**
 * The first container this browser will record, or `''` when it will admit to none.
 *
 * The empty string is not a failure: `new MediaRecorder(stream)` without a `mimeType`
 * lets the platform pick, which is the right move on a browser whose `isTypeSupported`
 * is missing or lying. Passing a type it rejected would throw instead.
 *
 * @param isSupported - Usually `MediaRecorder.isTypeSupported`; injected so this is
 *   testable where `MediaRecorder` does not exist.
 */
export function pickMimeType(isSupported: (type: string) => boolean): string {
  for (const type of RECORDING_MIME_TYPES) {
    if (isSupported(type)) return type;
  }
  return '';
}

/**
 * The file extension a container is normally written with.
 *
 * Only cosmetic — the decoder reads the bytes, not the name — but the name is what the
 * Compare panel prints as B, and `mic-recording.bin` would look like a bug.
 */
function extensionFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4') || mimeType.includes('mpeg')) return 'm4a';
  return 'audio';
}

/** A recording in progress. Exactly one of {@link Recorder.stop} or {@link Recorder.cancel} ends it. */
export interface Recorder {
  /**
   * Stop, release the microphone, and hand back what was captured.
   *
   * The tracks are stopped here rather than by the caller: the browser's recording
   * indicator stays lit for as long as one live track exists, and a tab that keeps
   * claiming to listen after the user pressed stop is the worst possible lie for this
   * particular feature to tell.
   */
  stop(): Promise<File>;
  /** Give up on the recording and release the microphone the same way. */
  cancel(): void;
}

/**
 * Ask for the microphone and start recording.
 *
 * Rejects when permission is refused, when no input device exists, or when the browser
 * has no `mediaDevices` at all — an insecure origin, typically. The caller reports that
 * through the same channel a failed decode uses; a silent no-op would be indistinguishable
 * from a broken button.
 */
export async function startRecording(): Promise<Recorder> {
  const devices = navigator.mediaDevices as MediaDevices | undefined;
  if (devices === undefined) {
    throw new Error('this browser exposes no microphone — a page served over https can ask for one');
  }

  const stream = await devices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

  /* Every exit path goes through here, including the failure paths: a stream left running
     is a microphone left open. */
  const release = (): void => {
    for (const track of stream.getTracks()) track.stop();
  };

  let recorder: MediaRecorder;
  try {
    const mimeType = pickMimeType((type) => MediaRecorder.isTypeSupported(type));
    recorder = mimeType === '' ? new MediaRecorder(stream) : new MediaRecorder(stream, { mimeType });
  } catch (error) {
    release();
    throw error;
  }

  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (event: BlobEvent) => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  let ended = false;
  recorder.start();

  return {
    stop: () =>
      new Promise<File>((resolve, reject) => {
        if (ended) {
          reject(new Error('this recording has already ended'));
          return;
        }
        ended = true;
        recorder.addEventListener(
          'error',
          () => {
            release();
            reject(new Error('the recorder failed before it could hand over the audio'));
          },
          { once: true },
        );
        /* The last chunk arrives with the `stop` event, not before it, so the file cannot
           be assembled until then. */
        recorder.addEventListener(
          'stop',
          () => {
            release();
            const type = recorder.mimeType === '' ? 'audio/webm' : recorder.mimeType;
            const blob = new Blob(chunks, { type });
            if (blob.size === 0) {
              reject(new Error('the recording came out empty — no audio reached the microphone'));
              return;
            }
            resolve(new File([blob], `mic-recording.${extensionFor(type)}`, { type }));
          },
          { once: true },
        );
        recorder.stop();
      }),
    cancel: () => {
      ended = true;
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}
