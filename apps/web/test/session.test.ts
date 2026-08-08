/**
 * The tab's unsaved recipes, and the two properties that matter about storing them:
 * **a corrupt entry must never stop the playground from starting**, and a generated
 * recipe must survive a reload.
 *
 * This is the one key in the playground that holds content rather than a preference, so
 * it is also the one likeliest to be edited by hand, truncated by a quota or left behind
 * by an older version of the app. Every read here is defensive, and this file is where
 * that is held to.
 *
 * @packageDocumentation
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SESSION_LIMIT, loadSession, saveSession, type SessionRecipe } from '../src/lib/session.js';

const KEY = 'txt2sfx.session.v1';

/** The smallest `localStorage` this module needs — the same stand-in `library.test.ts` uses. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => map.set(key, value),
  } as Storage;
}

Object.defineProperty(globalThis, 'window', {
  value: { localStorage: fakeStorage() },
  configurable: true,
  writable: true,
});

const coin: SessionRecipe = {
  name: 'coin',
  source: 'sound "coin" 260ms pickup\n  blip: tone square 988Hz | gain 0.5 decay 70ms\n',
  prompt: 'coin pickup',
};

describe('the recipes this tab has not saved yet', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts empty and round-trips what it is given', () => {
    expect(loadSession()).toEqual([]);
    saveSession([coin]);
    expect(loadSession()).toEqual([coin]);
  });

  it('starts fresh rather than throwing on anything unreadable', () => {
    for (const junk of ['', 'not json', '{}', 'null', '42', '[[]]']) {
      window.localStorage.setItem(KEY, junk);
      expect(loadSession()).toEqual([]);
    }
  });

  /* A recipe with no body would open as a blank editor claiming to be a generated sound —
     worse than the entry simply not being there. */
  it('drops an entry with no usable name or body instead of repairing it', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        coin,
        { name: '', source: 'sound "x" 40ms pop\n', prompt: '' },
        { name: 'blank', source: '   ', prompt: '' },
        { name: 'nameless', prompt: 'x' },
        { source: 'sound "y" 40ms pop\n' },
        null,
        'coin',
      ]),
    );
    expect(loadSession()).toEqual([coin]);
  });

  /* The prompt is the only field that is allowed to be missing: a recipe that arrived over
     a share link never had one, and it is still worth keeping. */
  it('accepts a recipe with no prompt and reports it as empty', () => {
    window.localStorage.setItem(KEY, JSON.stringify([{ name: 'coin', source: coin.source }]));
    expect(loadSession()).toEqual([{ ...coin, prompt: '' }]);
  });

  it('keeps the newest recipes when there are more than the cap', () => {
    const many: SessionRecipe[] = Array.from({ length: SESSION_LIMIT + 10 }, (_unused, index) => ({
      ...coin,
      name: `coin-${String(index)}`,
    }));
    saveSession(many);
    const stored = loadSession();
    expect(stored).toHaveLength(SESSION_LIMIT);
    expect(stored[0]?.name).toBe(`coin-${String(10)}`);
    expect(stored.at(-1)?.name).toBe(`coin-${String(SESSION_LIMIT + 9)}`);
  });

  /* A full quota is the normal way this fails, and it happens mid-keystroke. There is
     nothing the user can do with an error about it, and throwing here would take down the
     page that is holding the work. */
  it('says nothing when the storage refuses the write', () => {
    const full = {
      ...fakeStorage(),
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    } as Storage;
    Object.defineProperty(globalThis, 'window', { value: { localStorage: full }, configurable: true });
    expect(() => saveSession([coin])).not.toThrow();
    Object.defineProperty(globalThis, 'window', { value: { localStorage: fakeStorage() }, configurable: true });
  });
});
