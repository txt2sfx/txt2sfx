/**
 * The share link, which is the only place a recipe leaves this machine as data.
 *
 * Three properties are load-bearing and each has cost somebody an afternoon somewhere:
 * it survives non-Latin-1 text (a prompt in Russian is the normal case here, not an
 * edge one); it survives being truncated by a chat client without taking the page down
 * with it; and it never round-trips into something that is not the recipe that went in.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import {
  bankLink,
  bankRefFromLocation,
  clearShareFromLocation,
  shareLink,
  sharedFromLocation,
} from '../src/lib/share.js';

const RECIPE = {
  source: 'sound "bubble pop" 55ms pop\n  body: tone tri ~700Hz[500..1400] | gain 0.8 decay 38ms\n',
  name: 'bubble-pop',
  prompt: 'soft wet bubble pop, cartoon-ish',
};

describe('share links', () => {
  it('round-trips a recipe through the fragment', () => {
    const link = shareLink(RECIPE, 'https://example.test/');
    const back = sharedFromLocation(new URL(link).hash);
    expect(back).toEqual(RECIPE);
  });

  /* `btoa` throws on anything above U+00FF, and the prompts this project was built
     against include "большой камень плюхнулся в озеро". A share button that throws on
     the developer's own test prompt is not a share button. */
  it('survives text outside Latin-1, in both the prompt and the recipe', () => {
    const recipe = {
      source: '# всплеск\nsound "камень" 900ms impact\n  body: sub 70Hz | gain 0.7 decay 800ms\n',
      name: 'камень-в-озере',
      prompt: 'большой камень плюхнулся в озеро — 大きな石',
    };
    const link = shareLink(recipe, 'https://example.test/');
    expect(sharedFromLocation(new URL(link).hash)).toEqual(recipe);
  });

  it('puts the payload in the fragment, which never reaches a server', () => {
    const link = shareLink(RECIPE, 'https://example.test/play');
    const url = new URL(link);
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/play');
    expect(url.hash.startsWith('#play=')).toBe(true);
    /* Base64url: no `+`, `/` or `=`, so nothing needs escaping and nothing is lost to a
       client that helpfully "fixes" the URL. */
    expect(/^#play=[A-Za-z0-9\-_]+$/.test(url.hash)).toBe(true);
  });

  it('reads nothing out of an ordinary URL', () => {
    expect(sharedFromLocation('')).toBeNull();
    expect(sharedFromLocation('#')).toBeNull();
    expect(sharedFromLocation('#tab=studio')).toBeNull();
  });

  /* The realistic failure: a chat client wraps a 900-character URL and the recipient
     pastes half of it. That must produce an ordinary playground, not a broken page. */
  it('returns null for a truncated payload instead of throwing', () => {
    const link = shareLink(RECIPE, 'https://example.test/');
    const hash = new URL(link).hash;
    expect(sharedFromLocation(hash.slice(0, Math.floor(hash.length * 0.6)))).toBeNull();
  });

  it('refuses a payload that decodes to something with no recipe in it', () => {
    const empty = shareLink({ source: '   ', name: 'x', prompt: '' }, 'https://example.test/');
    expect(sharedFromLocation(new URL(empty).hash)).toBeNull();
  });

  it('finds the payload when it is not the first fragment parameter', () => {
    const link = shareLink(RECIPE, 'https://example.test/');
    const payload = new URL(link).hash.slice('#play='.length);
    expect(sharedFromLocation(`#view=studio&play=${payload}`)?.name).toBe('bubble-pop');
  });

  /* The payload has to leave the address bar, or every later reload re-imports the same
     sound over whatever the recipient has since edited. */
  it('clears the payload from the address bar without touching the path', () => {
    const replaced: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      value: {
        history: { replaceState: (_a: unknown, _b: unknown, url: string) => replaced.push(url) },
        location: { pathname: '/play', search: '?debug=1', hash: '#play=abc' },
      },
      configurable: true,
      writable: true,
    });

    clearShareFromLocation();
    expect(replaced).toEqual(['/play?debug=1']);
  });
});

/**
 * The id form, whose whole reason for existing is a caller that is not a browser: a
 * chat composing a link to something it found in the bank. So the cases that matter
 * are the ones where that caller gets it wrong — an invented id, a truncated link, a
 * number that is not a number — and every one of them has to end at an ordinary
 * playground rather than a request the bank will 404 or, worse, a crash.
 */
describe('bank links', () => {
  it('round-trips an id through the fragment', () => {
    expect(bankRefFromLocation(new URL(bankLink(12, 'https://example.test')).hash)).toBe(12);
  });

  /* Short is the entire trade this form makes — it gives up self-containment for a
     link something can compose without base64-encoding a recipe in a token stream. */
  it('is short, and puts the id in the fragment', () => {
    const url = new URL(bankLink(12, 'https://example.test'));
    expect(url.hash).toBe('#recipe=12');
    expect(url.search).toBe('');
    expect(bankLink(12, 'https://example.test').length).toBeLessThan(40);
  });

  it('does not care whether the origin was given a trailing slash', () => {
    expect(bankLink(3, 'https://example.test/')).toBe(bankLink(3, 'https://example.test'));
  });

  /* An id is typed and re-typed by models and people. Anything that is not a positive
     integer must read as "no link here" — a playground asking the bank for recipe NaN
     is a request nobody can answer and an error nobody can act on. */
  it('reads nothing out of an id that is not one', () => {
    for (const hash of ['', '#', '#recipe=', '#recipe=abc', '#recipe=-1', '#recipe=0', '#recipe=1.5', '#play=abc']) {
      expect(bankRefFromLocation(hash), hash).toBeNull();
    }
  });

  it('finds the id when it is not the first fragment parameter', () => {
    expect(bankRefFromLocation('#view=studio&recipe=41')).toBe(41);
  });

  /* Both forms coexist and must not read each other's payload: a `#play=` link is a
     whole recipe and has no id in it, and an id link carries no recipe. */
  it('stays out of the payload form, and the payload form stays out of it', () => {
    const payload = new URL(shareLink(RECIPE, 'https://example.test/')).hash;
    expect(bankRefFromLocation(payload)).toBeNull();
    expect(sharedFromLocation('#recipe=12')).toBeNull();
  });
});
