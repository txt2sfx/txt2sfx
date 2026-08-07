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
import { clearShareFromLocation, shareLink, sharedFromLocation } from '../src/lib/share.js';

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
