/**
 * Trash, recency and the onboarding flag — and the property that matters most about
 * all three: **a corrupt entry must never stop the playground from starting**.
 *
 * These live in `localStorage`, which is shared with every other page on the origin,
 * survives across versions of the app, and can be edited by hand. A JSON parse that
 * throws on load would take the whole page down over a preference, so every read is
 * defensive and this file is where that is held to.
 *
 * @packageDocumentation
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { loadLibrary, saveLibrary } from '../src/lib/library.js';
import { ago, bytes, delta, hz, ms } from '../src/lib/format.js';
import { setLang } from '../src/lib/i18n.js';

const KEY = 'txt2sfx.library.v1';

/**
 * The smallest `localStorage` that satisfies this module.
 *
 * A DOM implementation would be a dependency, and the surface under test is three
 * methods — the same trade `keystore.test.ts` makes with its in-memory key-value store.
 */
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

describe('the per-browser library', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts empty and round-trips what it is given', () => {
    expect(loadLibrary()).toEqual({ trashed: [], touched: {}, onboarded: false });
    const library = { trashed: ['coin'], touched: { coin: 1_700_000_000_000 }, onboarded: true };
    saveLibrary(library);
    expect(loadLibrary()).toEqual(library);
  });

  it('starts fresh rather than throwing on anything unreadable', () => {
    for (const junk of ['', 'not json', '[]', 'null', '{"trashed":"coin"}', '{"touched":42}']) {
      window.localStorage.setItem(KEY, junk);
      const library = loadLibrary();
      expect(Array.isArray(library.trashed)).toBe(true);
      expect(typeof library.touched).toBe('object');
      expect(typeof library.onboarded).toBe('boolean');
    }
  });

  it('drops non-string names rather than letting one into the trash list', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ trashed: ['coin', 7, null, 'laser'] }));
    expect(loadLibrary().trashed).toEqual(['coin', 'laser']);
  });

  /* Trash is a view decision. `examples/` is a git-tracked directory and the bank is a
     shared store; a button in a playground has no business unlinking either, and the
     Trash filter would have nothing to restore from if it did. */
  it('records a trashed name without recording anything about the file', () => {
    saveLibrary({ trashed: ['coin'], touched: {}, onboarded: false });
    const raw = window.localStorage.getItem(KEY) ?? '';
    expect(raw).toContain('coin');
    expect(raw).not.toContain('soundline');
    expect(raw).not.toContain('sound "');
  });
});

describe('how numbers are spelled', () => {
  it('switches units at one second and keeps no false precision', () => {
    expect(ms(45)).toBe('45 ms');
    expect(ms(45.4)).toBe('45 ms');
    expect(ms(999)).toBe('999 ms');
    expect(ms(1000)).toBe('1.0 s');
    expect(ms(1800)).toBe('1.8 s');
    expect(ms(12_000)).toBe('12 s');
  });

  it('says so plainly when there is no number', () => {
    expect(ms(Number.NaN)).toBe('—');
    expect(hz(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('spells frequency the way an ear reads it', () => {
    expect(hz(861)).toBe('861 Hz');
    expect(hz(1100)).toBe('1.1 kHz');
    expect(hz(12_000)).toBe('12 kHz');
  });

  it('signs a delta with a real minus rather than a hyphen', () => {
    expect(delta(0.5, '', 3)).toBe('+0.500');
    expect(delta(-0.5, '', 3)).toBe('−0.500');
    expect(delta(-3, 'dB', 1)).toBe('−3.0 dB');
  });

  it('gives the export budget its thousands separator', () => {
    expect(bytes(876)).toBe('876 B');
    expect(bytes(1024)).toBe('1,024 B');
  });

  it('answers "did I touch this recently" rather than printing a timestamp', () => {
    const now = 1_700_000_000_000;
    expect(ago(now, now)).toBe('just now');
    expect(ago(now - 3 * 60_000, now)).toBe('3 min. ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 hr. ago');
    /* `numeric: 'auto'` is the reason this is a word and not "1 day ago". */
    expect(ago(now - 26 * 3_600_000, now)).toBe('yesterday');
    expect(ago(now - 5 * 86_400_000, now)).toBe('5 days ago');
  });

  /**
   * Relative time is the one format that follows the interface language.
   *
   * It is delegated to `Intl` rather than to the dictionary because plural rules are not
   * a translator's job to get right nine times: Russian alone needs three forms for
   * "days". Asserting one non-English language here is what keeps that delegation honest
   * — a regression to a hand-written English template would pass every other test in
   * this file.
   */
  it('follows the interface language, plural rules included', () => {
    const now = 1_700_000_000_000;
    setLang('ru');
    try {
      expect(ago(now, now)).toBe('только что');
      expect(ago(now - 3 * 60_000, now)).toBe('3 мин. назад');
      expect(ago(now - 26 * 3_600_000, now)).toBe('вчера');
      expect(ago(now - 5 * 86_400_000, now)).toBe('5 дн. назад');
    } finally {
      setLang('en');
    }
  });
});
