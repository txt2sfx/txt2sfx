/**
 * The playground's half of the reference model.
 *
 * Only the browser side is here: everything that builds an argv or reads the child's
 * output moved to `packages/bridge/test/stable-audio.test.ts` along with the code, so
 * that the daemon and the dev server cannot be tested against two different rules.
 * What is left is the one thing this side owns — reading a line off the stream.
 */

import { describe, expect, it } from 'vitest';
import { parseEvent } from '../src/lib/stable-audio.js';

describe('parseEvent', () => {
  it('reads the events the endpoint emits', () => {
    expect(parseEvent('{"type":"done","name":"a-1.mp3","mime":"audio/mpeg","bytes":9,"ms":12000,"audio":"AAA="}')).toEqual({
      type: 'done',
      name: 'a-1.mp3',
      mime: 'audio/mpeg',
      bytes: 9,
      ms: 12000,
      audio: 'AAA=',
    });
    expect(parseEvent('  ')).toBeNull();
  });

  /* The far end is a Python process. The one time it writes something unexpected
     is exactly the time you want to see it, so it becomes a log line. */
  it('shows unparseable output instead of dropping it', () => {
    expect(parseEvent('Traceback (most recent call last):')).toEqual({
      type: 'log',
      line: 'Traceback (most recent call last):',
    });
  });
});
