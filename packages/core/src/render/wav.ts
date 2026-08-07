/**
 * `AudioBuffer` -> WAV bytes.
 *
 * A WAV writer is thirty lines and no dependency, which is the whole reason this
 * exists rather than a package: the playground's download button, the recipe
 * bank's seed script and the future bench all want bytes they can hand to a
 * `Blob` or `writeFileSync`, and none of them should force an install.
 *
 * Note what this is *not* for: the product of txt2sfx is code, not audio. A WAV
 * is an inspection aid and a comparison target — something to open in an editor,
 * or to feed to a perceptual judge — never the deliverable.
 *
 * @packageDocumentation
 */

/** Sample formats the writer supports. */
export type WavBitDepth = 16 | 24 | 32;

/** Options of {@link encodeWav}. */
export interface WavOptions {
  /**
   * 16 or 24 for signed integer PCM, 32 for IEEE float.
   *
   * 16-bit is the safe default: every tool reads it. 24-bit is what a game audio
   * pipeline usually wants for an intermediate — 48 dB more headroom below the
   * noise floor than 16, at three quarters the size of float. 32-bit float is
   * lossless and keeps samples that overshoot full scale, which is what you want
   * when the point of exporting is to *see* that the mix clipped.
   */
  readonly bitDepth?: WavBitDepth;
}

/** Clamp and convert one float sample to signed 16-bit. */
function toInt16(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return Math.round(clamped * 32767);
}

/**
 * Clamp and convert one float sample to signed 24-bit.
 *
 * `DataView` has no `setInt24`, so the three bytes are written by hand, little-endian
 * and two's complement — which is why the value is masked into 24 bits first rather
 * than shifted out of a negative number.
 */
function writeInt24(bytes: Uint8Array, offset: number, sample: number): void {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  const value = Math.round(clamped * 8388607) & 0xffffff;
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}

/**
 * Encode a buffer as a RIFF/WAVE file.
 *
 * Channels are interleaved, as the format requires.
 */
export function encodeWav(buffer: AudioBuffer, options: WavOptions = {}): Uint8Array {
  const bitDepth = options.bitDepth ?? 16;
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;

  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  // 1 = integer PCM, 3 = IEEE float.
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const data: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel++) data.push(buffer.getChannelData(channel));

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = data[channel]?.[frame] ?? 0;
      if (bitDepth === 32) view.setFloat32(offset, sample, true);
      else if (bitDepth === 24) writeInt24(bytes, offset, sample);
      else view.setInt16(offset, toInt16(sample), true);
      offset += bytesPerSample;
    }
  }
  return bytes;
}
