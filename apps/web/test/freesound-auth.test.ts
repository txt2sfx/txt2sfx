/**
 * The two pure halves of the connection: reading the hand-off, and knowing when a
 * token is spent.
 *
 * The fragment functions are the security-relevant ones. The bank sends the browser
 * back with a one-time code in `#freesound=…`, and the page has to be able to take it
 * out again — leaving it there puts a credential-shaped thing in history, in the back
 * button and in the next screenshot. A regex that fails to match is a code that is
 * never spent; a scrub that fails to remove is a code that stays on screen.
 */

import { describe, expect, it } from 'vitest';
import { handoffFrom, isFresh, withoutHandoff } from '../src/lib/freesound-auth.js';

describe('handoffFrom', () => {
  it('reads the code and the error', () => {
    expect(handoffFrom('#freesound=abc123')).toEqual({ code: 'abc123' });
    expect(handoffFrom('#freesound_error=cancelled')).toEqual({ error: 'cancelled' });
  });

  /* `freesound_error` starts with `freesound`; a lazy pattern reads the error as a
     code and posts the word "cancelled" to the exchange. */
  it('does not read an error as a code', () => {
    expect(handoffFrom('#freesound_error=bad-code').code).toBeUndefined();
  });

  it('finds it beside another fragment parameter', () => {
    expect(handoffFrom('#s=eNq&freesound=abc').code).toBe('abc');
  });

  it('decodes what the redirect encoded', () => {
    expect(handoffFrom('#freesound=a%2Fb%2Bc').code).toBe('a/b+c');
  });

  it('finds nothing in an ordinary fragment', () => {
    expect(handoffFrom('')).toEqual({});
    expect(handoffFrom('#s=eNqrVkrLz1eyUlAqLknMK1ayqlaqBQBQmwZs')).toEqual({});
  });
});

describe('withoutHandoff', () => {
  it('removes both parameters and leaves nothing behind', () => {
    expect(withoutHandoff('#freesound=abc')).toBe('');
    expect(withoutHandoff('#freesound_error=cancelled')).toBe('');
  });

  /* A shared recipe lives in the same fragment. Scrubbing the code must not throw
     away the sound somebody sent you. */
  it('keeps everything else', () => {
    expect(withoutHandoff('#s=eNq&freesound=abc')).toBe('#s=eNq');
    expect(withoutHandoff('#freesound=abc&s=eNq')).toBe('#s=eNq');
  });
});

describe('isFresh', () => {
  const now = 1_800_000_000_000;
  const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: now + 86_400_000 };

  it('is true well before expiry and false after it', () => {
    expect(isFresh(tokens, now)).toBe(true);
    expect(isFresh(tokens, now + 86_400_000 + 1)).toBe(false);
  });

  /* Refreshing a minute early costs one request; refreshing a second late costs a
     search that fails in front of somebody. */
  it('spends a token that is inside the early-refresh margin', () => {
    expect(isFresh({ ...tokens, expiresAt: now + 30_000 }, now)).toBe(false);
  });

  it('never calls an empty token fresh', () => {
    expect(isFresh({ ...tokens, accessToken: '' }, now)).toBe(false);
  });
});
