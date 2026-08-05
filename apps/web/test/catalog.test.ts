/**
 * What the gallery shows and in which order.
 *
 * Small rules, but each one is a way to lose work if it goes wrong: a stored recipe
 * shadowing an unsaved one, or one name appearing twice and selecting the same
 * buffer from two rows.
 */

import { describe, expect, it } from 'vitest';
import type { Recipe } from '@txt2sfx/shared';
import { bankEntries, exampleEntries, mergeCatalog, type Entry } from '../src/lib/catalog.js';

const recipe = (id: number, name: string, rating = 0): Recipe =>
  ({
    id,
    name,
    prompt: `${name} sound`,
    soundline: `sound "${name}" 40ms pop\n`,
    category: 'pop',
    tags: [],
    durationMs: 40,
    rating,
    profile: {},
    createdAt: '2026-08-05T00:00:00.000Z',
  }) as unknown as Recipe;

const session = (name: string): Entry => ({
  name,
  source: `sound "${name}" 50ms ui\n`,
  origin: 'session',
  prompt: 'generated',
});

describe('catalog', () => {
  it('carries the bank fields the sidebar shows', () => {
    const entries = bankEntries([recipe(2, 'laser', 3)]);
    expect(entries[0]).toMatchObject({ name: 'laser', origin: 'bank', rating: 3, id: 2, prompt: 'laser sound' });
  });

  it('sorts both stores alphabetically', () => {
    expect(bankEntries([recipe(1, 'zap'), recipe(2, 'coin')]).map((entry) => entry.name)).toEqual(['coin', 'zap']);
    expect(
      exampleEntries([
        { name: 'zap', source: '' },
        { name: 'coin', source: '' },
      ]).map((entry) => entry.name),
    ).toEqual(['coin', 'zap']);
  });

  it('puts this session first, then the store', () => {
    const merged = mergeCatalog([session('my-door')], bankEntries([recipe(1, 'coin')]));
    expect(merged.map((entry) => `${entry.origin}:${entry.name}`)).toEqual(['session:my-door', 'bank:coin']);
  });

  /* Two rows with one name would select the same editor buffer and differ only in
     a badge — and the session copy is the one being edited. */
  it('lets a session recipe hide a stored one of the same name', () => {
    const merged = mergeCatalog([session('coin')], bankEntries([recipe(1, 'coin'), recipe(2, 'laser')]));
    expect(merged.map((entry) => entry.name)).toEqual(['coin', 'laser']);
    expect(merged[0]?.origin).toBe('session');
  });

  it('is just the store when nothing was generated', () => {
    const merged = mergeCatalog([], exampleEntries([{ name: 'coin', source: 'x' }]));
    expect(merged).toHaveLength(1);
    expect(merged[0]?.origin).toBe('examples');
  });
});
