/**
 * `@txt2sfx/analyzer` — measuring sounds and comparing them.
 *
 * Three layers, each usable on its own:
 *
 * 1. {@link extractProfile} measures one signal, candidate or reference alike.
 * 2. {@link profileDistance} and {@link stftDistance} say how far apart two of
 *    them are; {@link soundDistance} combines them into the number the
 *    optimizer minimizes.
 * 3. {@link humanReadableDiff} turns that distance into instructions a language
 *    model can act on without inferring anything.
 *
 * Zero runtime dependencies, including no Web Audio: the input is samples and a
 * sample rate, which a browser, Node, and a decoded reference file can all
 * supply. Decoding belongs to the caller — the playground uses the platform's
 * `decodeAudioData`, and Node has `node-web-audio-api` for the same job.
 *
 * @example
 * ```ts
 * import { extractProfile, humanReadableDiff } from '@txt2sfx/analyzer';
 *
 * const candidate = extractProfile({ samples: buffer.getChannelData(0), sampleRate: 44100 });
 * for (const line of humanReadableDiff(candidate, target, ast)) console.log(line);
 * ```
 *
 * @packageDocumentation
 */

export { dominantBin, fft, hann, isPow2, magnitudes, nextPow2, prevPow2, refinePeakBin } from './fft.js';

export {
  CENTROID_POINTS,
  ENVELOPE_POINTS,
  extractProfile,
  onsetIndex,
  peakOf,
  profileMarkdown,
  rmsFrames,
  rmsOf,
  spanOf,
} from './profile.js';
export type { Signal, Span } from './profile.js';

export {
  DEFAULT_PROFILE_WEIGHTS,
  DEFAULT_SOUND_WEIGHTS,
  STFT_SIZES,
  alignAndNormalize,
  profileDistance,
  profileDistanceParts,
  soundDistance,
  stftDistance,
} from './distance.js';
export type {
  AlignedPair,
  ProfileDistanceParts,
  ProfileWeights,
  SoundDistanceWeights,
} from './distance.js';

export { diffMarkdown, humanReadableDiff } from './diff.js';
