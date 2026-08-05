/**
 * Bank tests: the schema, the queries and the search.
 *
 * Every one of these runs against a real in-memory SQLite with the real FTS5
 * index. Mocking the store would test the mock's idea of how bm25 ranks, which is
 * precisely the thing nobody can predict without running it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecipeInput, SoundProfile } from '@txt2sfx/shared';
import { MAX_LIMIT, ftsQuery, openBank, type RecipeBank } from '../src/db.js';

/** FTS5 is a Node build flag, not a given — `openBank` probes for it on open. */
describe('opening a bank', () => {
  it('works on this Node, which is the only way any of these tests run', () => {
    const probe = openBank(':memory:');
    expect(probe.count()).toBe(0);
    probe.close();
  });
});

const profile: SoundProfile = {
  durationMs: 42,
  attackMs: 1,
  rmsEnvelope: [1, 0.5, 0.1],
  centroidHz: [1000, 900],
  flatness: 0.01,
  noiseRatio: 0.02,
  peakHz: 836,
  loudnessLufsApprox: -15,
};

const recipe = (over: Partial<RecipeInput> = {}): RecipeInput => ({
  name: 'coin',
  prompt: 'coin pickup sound for a platformer',
  soundline: 'sound "coin" 260ms pickup\n  blip: tone square 988Hz | gain 0.5 decay 70ms\n',
  profile,
  category: 'pickup',
  tags: ['coin', 'pickup', 'arcade'],
  durationMs: 260,
  ...over,
});

let bank: RecipeBank;

beforeEach(() => {
  bank = openBank(':memory:');
});

afterEach(() => {
  bank.close();
});

describe('ftsQuery', () => {
  it('joins terms with OR, because no recipe contains all of them', () => {
    expect(ftsQuery('coin pickup sound')).toBe('"coin" OR "pickup" OR "sound"');
  });

  it('drops function words and single characters', () => {
    expect(ftsQuery('a pop for the menu')).toBe('"pop" OR "menu"');
  });

  /**
   * A prompt is user text, and `NEAR`, `OR` and `*` are FTS5 operators. Unquoted,
   * "near miss" is a syntax error and the endpoint answers 500.
   */
  it('quotes terms so operator words cannot become operators', () => {
    expect(ftsQuery('near miss')).toBe('"near" OR "miss"');
    expect(ftsQuery('laser*')).toBe('"laser"');
    expect(ftsQuery('say "hello"')).toBe('"say" OR "hello"');
  });

  it('returns null when nothing usable is left', () => {
    expect(ftsQuery('')).toBeNull();
    expect(ftsQuery('  the a of  ')).toBeNull();
    expect(ftsQuery('!!! ???')).toBeNull();
  });

  it('keeps non-ascii words whole', () => {
    expect(ftsQuery('щелчок меню')).toBe('"щелчок" OR "меню"');
  });
});

describe('insert and get', () => {
  it('stores and returns a recipe with its own id', () => {
    const stored = bank.insert(recipe());
    expect(stored.id).toBeGreaterThan(0);
    expect(stored.name).toBe('coin');
    expect(stored.rating).toBe(0);
    expect(stored.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(bank.get(stored.id)).toEqual(stored);
  });

  it('round-trips the profile and the tags through JSON', () => {
    const stored = bank.insert(recipe());
    expect(stored.profile).toEqual(profile);
    expect(stored.tags).toEqual(['coin', 'pickup', 'arcade']);
  });

  it('returns undefined for an id that is not there', () => {
    expect(bank.get(9999)).toBeUndefined();
  });

  it('counts what it holds', () => {
    expect(bank.count()).toBe(0);
    bank.insert(recipe());
    bank.insert(recipe({ name: 'laser' }));
    expect(bank.count()).toBe(2);
  });
});

describe('search', () => {
  beforeEach(() => {
    bank.insert(recipe());
    bank.insert(
      recipe({
        name: 'explosion',
        prompt: 'big explosion with deep body and a long rumble tail',
        category: 'explosion',
        tags: ['explosion', 'blast'],
        durationMs: 1200,
      }),
    );
    bank.insert(
      recipe({
        name: 'ui-click',
        prompt: 'crisp ui click for a menu button',
        category: 'ui',
        tags: ['ui', 'click', 'menu'],
        durationMs: 45,
      }),
    );
  });

  it('finds by name', () => {
    expect(bank.list({ q: 'explosion' }).map((r) => r.name)).toEqual(['explosion']);
  });

  it('finds by tag', () => {
    expect(bank.list({ q: 'menu' }).map((r) => r.name)).toEqual(['ui-click']);
  });

  it('finds by words in the prompt', () => {
    expect(bank.list({ q: 'rumble' }).map((r) => r.name)).toEqual(['explosion']);
  });

  it('filters by category', () => {
    expect(bank.list({ category: 'ui' }).map((r) => r.name)).toEqual(['ui-click']);
    expect(bank.list({ q: 'click', category: 'explosion' })).toEqual([]);
  });

  it('returns the newest first with no query', () => {
    expect(bank.list().map((r) => r.name)).toEqual(['ui-click', 'explosion', 'coin']);
  });

  it('honours a limit and refuses an absurd one', () => {
    expect(bank.list({ limit: 2 })).toHaveLength(2);
    expect(bank.list({ limit: 10_000 })).toHaveLength(3);
    expect(bank.list({ limit: 0 })).toHaveLength(1);
    expect(MAX_LIMIT).toBeGreaterThan(0);
  });

  it('finds nothing rather than everything for an unrelated query', () => {
    expect(bank.list({ q: 'harpsichord' })).toEqual([]);
  });

  /**
   * The index is external-content, so it does not see writes on its own — three
   * triggers keep it in step. Without the update trigger the bank searches
   * correctly right up to the first edit, which is the worst possible failure mode
   * for a search index.
   */
  it('keeps the index in step with a rating update', () => {
    const stored = bank.insert(recipe({ name: 'sword-clash', prompt: 'two swords clashing', tags: ['sword'] }));
    bank.vote(stored.id, 1);
    expect(bank.list({ q: 'swords' }).map((r) => r.name)).toEqual(['sword-clash']);
  });
});

describe('votes', () => {
  it('adds and subtracts', () => {
    const stored = bank.insert(recipe());
    expect(bank.vote(stored.id, 1)?.rating).toBe(1);
    expect(bank.vote(stored.id, 1)?.rating).toBe(2);
    expect(bank.vote(stored.id, -1)?.rating).toBe(1);
  });

  it('reports an unknown id rather than pretending', () => {
    expect(bank.vote(4242, 1)).toBeUndefined();
  });
});

describe('retrieve', () => {
  beforeEach(() => {
    bank.insert(recipe());
    bank.insert(
      recipe({
        name: 'powerup',
        prompt: 'power-up jingle, rising sweep with a sparkle on top',
        tags: ['powerup', 'jingle', 'reward'],
        durationMs: 520,
      }),
    );
    bank.insert(
      recipe({
        name: 'explosion',
        prompt: 'big explosion with deep body and a long rumble tail',
        category: 'explosion',
        tags: ['explosion'],
        durationMs: 1200,
      }),
    );
  });

  /** The plan's acceptance criterion for this phase. */
  it('puts coin first for "coin pickup sound"', () => {
    const result = bank.retrieve('coin pickup sound', 3);
    expect(result.fallback).toBe(false);
    expect(result.recipes[0]?.name).toBe('coin');
  });

  it('ranks a name match above a prompt match', () => {
    /* Both recipes mention "pickup"; only one is called coin. */
    expect(bank.retrieve('pickup', 3).recipes[0]?.name).toBe('coin');
  });

  it('respects k', () => {
    expect(bank.retrieve('coin explosion powerup', 2).recipes).toHaveLength(2);
  });

  /**
   * An empty answer is the worst possible one here: the caller is a model that
   * needs grammar examples and has nowhere else to get them.
   */
  it('falls back to the best-rated recipes rather than answering nothing', () => {
    const top = bank.insert(recipe({ name: 'door-creak', prompt: 'creaking door', tags: ['door'] }));
    bank.vote(top.id, 1);

    const result = bank.retrieve('harpsichord glissando', 2);
    expect(result.fallback).toBe(true);
    expect(result.recipes).toHaveLength(2);
    expect(result.recipes[0]?.name).toBe('door-creak');
  });

  it('falls back for a prompt with no searchable words at all', () => {
    const result = bank.retrieve('the a of', 1);
    expect(result.query).toBeNull();
    expect(result.fallback).toBe(true);
    expect(result.recipes).toHaveLength(1);
  });
});

describe('identity', () => {
  /**
   * `list` is capped at {@link MAX_LIMIT}, so anything that deduplicates by listing
   * starts re-inserting silently once the bank outgrows the cap — the seeder did
   * exactly that. Asked per name, the answer does not depend on how big the bank is.
   */
  it('answers hasName regardless of how many recipes are stored', () => {
    for (let i = 0; i < MAX_LIMIT + 5; i++) bank.insert(recipe({ name: `filler-${String(i)}` }));
    bank.insert(recipe({ name: 'buried' }));
    for (let i = 0; i < 20; i++) bank.insert(recipe({ name: `later-${String(i)}` }));

    expect(bank.hasName('buried')).toBe(true);
    expect(bank.hasName('filler-0')).toBe(true);
    expect(bank.hasName('never-stored')).toBe(false);
    /* And the listing genuinely cannot see it, which is the trap. */
    expect(bank.list({ limit: MAX_LIMIT }).some((r) => r.name === 'filler-0')).toBe(false);
  });

  it('recognizes an identical recipe and distinguishes a changed one', () => {
    const stored = bank.insert(recipe());
    expect(bank.findIdentical('coin', recipe().soundline)?.id).toBe(stored.id);
    expect(bank.findIdentical('coin', 'sound "coin" 260ms pickup\n  b: tone sine 400Hz | gain 0.5 decay 70ms\n')).toBeUndefined();
    expect(bank.findIdentical('other', recipe().soundline)).toBeUndefined();
  });
});

describe('robustness', () => {
  /**
   * The profile is the one field the server cannot recompute — it has no audio
   * stack — so a malformed one will eventually reach the table. When it does, that
   * recipe should lose its usefulness, not take down every search that ranks it.
   */
  it('serves a recipe with an unreadable profile instead of throwing', () => {
    const good = bank.insert(recipe());
    const broken = bank.insert(recipe({ name: 'broken', profile: null as unknown as SoundProfile }));

    expect(bank.get(broken.id)?.profile.durationMs).toBe(0);
    expect(bank.get(broken.id)?.profile.loudnessLufsApprox).toBe(-Infinity);
    expect(bank.get(good.id)?.profile).toEqual(profile);
    expect(bank.list()).toHaveLength(2);
  });
});
