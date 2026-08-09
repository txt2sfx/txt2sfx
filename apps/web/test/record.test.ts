/**
 * Container choice for a microphone recording.
 *
 * The only part of `lib/record.ts` a node process can hold: everything else is
 * `getUserMedia` and `MediaRecorder`, neither of which exists here, and both of which
 * are the platform's code rather than ours. What *is* ours is the decision — offer the
 * containers in a fixed order, take the first the browser admits to, and never hand
 * `MediaRecorder` a type it just rejected, because that throws instead of degrading.
 *
 * The rest is covered by the typecheck and by a pass with a real microphone.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { RECORDING_MIME_TYPES, pickMimeType } from '../src/lib/record.js';

/** `isTypeSupported` for a browser that admits to exactly this set. */
function supporting(...types: readonly string[]): (type: string) => boolean {
  return (type) => types.includes(type);
}

describe('pickMimeType', () => {
  it('prefers Opus in WebM when the browser takes everything', () => {
    expect(pickMimeType(() => true)).toBe('audio/webm;codecs=opus');
  });

  it('takes whichever single container the browser admits to', () => {
    for (const type of RECORDING_MIME_TYPES) {
      expect(pickMimeType(supporting(type))).toBe(type);
    }
  });

  /* Safari records MP4 and nothing else; picking WebM there throws in the constructor
     rather than falling back, which is why the probe exists at all. */
  it('lands on MP4 on a browser that only records MP4', () => {
    expect(pickMimeType(supporting('audio/mp4'))).toBe('audio/mp4');
  });

  it('asks in the declared order and stops at the first yes', () => {
    const asked: string[] = [];
    const chosen = pickMimeType((type) => {
      asked.push(type);
      return type === 'audio/ogg;codecs=opus';
    });
    expect(chosen).toBe('audio/ogg;codecs=opus');
    expect(asked).toEqual(['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']);
  });

  /* Not a failure: an empty type means "let the platform choose", which is the only
     safe move on a browser whose probe says no to everything it can in fact record. */
  it('returns the empty string rather than a type the browser refused', () => {
    expect(pickMimeType(() => false)).toBe('');
  });
});
