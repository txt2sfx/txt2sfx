/**
 * Rewriting a request into a retrieval query.
 *
 * The failure being fixed is silent, which is why it is worth its own tests: a
 * Russian prompt matches nothing in an English FTS index, `retrieve` answers with
 * top-rated recipes instead, and the run reports three examples that have nothing
 * to do with what was asked.
 */

import { describe, expect, it } from 'vitest';
import type { Recipe } from '@txt2sfx/shared';
import { generateSound, mockProvider, parseKeywords, searchQuery, staticBank } from '../src/index.js';
import { ProviderError } from '../src/provider.js';

const recipe = (name: string): Recipe =>
  ({
    id: 1,
    name,
    prompt: `${name} sound`,
    soundline: `sound "${name}" 40ms pop\n  a: click 2ms | gain 0.6 attack 0ms decay 20ms\n`,
    profile: {},
    category: 'pop',
    tags: [],
    durationMs: 40,
    rating: 0,
    createdAt: '2026-08-05T00:00:00.000Z',
  }) as unknown as Recipe;

describe('parseKeywords', () => {
  it('takes a keyword line as it is', () => {
    expect(parseKeywords('stone water splash lake impact')).toBe('stone water splash lake impact');
  });

  it('normalizes case, punctuation and stray quoting', () => {
    expect(parseKeywords('Stone, Water, "Splash".')).toBe('stone water splash');
  });

  it('keeps only the first line, which is where a model puts the answer', () => {
    expect(parseKeywords('stone water splash\n\nI chose these because…')).toBe('stone water splash');
  });

  it('caps the count so one word cannot dominate an FTS query', () => {
    const many = Array.from({ length: 20 }, (_, i) => `word${String(i)}`).join(' ');
    expect(parseKeywords(many)?.split(' ')).toHaveLength(8);
  });

  /* A caller with a perfectly good fallback is better served by a rejection than by
     a sentence trimmed into something that looks like keywords. */
  it('rejects prose rather than trimming it', () => {
    const essay = `Certainly! ${'The sound of a stone entering water is complex. '.repeat(8)}`;
    expect(parseKeywords(essay)).toBeUndefined();
  });

  it('rejects an empty reply', () => {
    expect(parseKeywords('')).toBeUndefined();
    expect(parseKeywords('   \n  ')).toBeUndefined();
  });

  /* Better a half-translated line than the whole sentence: one usable token still
     ranks, and rejecting non-Latin script outright would throw that away. */
  it('keeps words of any script', () => {
    expect(parseKeywords('камень water splash')).toBe('камень water splash');
  });
});

describe('searchQuery', () => {
  it('asks the model and returns its keywords', async () => {
    const provider = mockProvider({ replies: ['stone water splash impact'] });
    await expect(searchQuery({ prompt: 'большой камень плюхнулся в озеро', provider })).resolves.toBe(
      'stone water splash impact',
    );
    /* Short and separate: this is a cheap call, and the request carries only the
       prompt and its own tiny system text. */
    expect(provider.requests[0]?.maxTokens).toBe(64);
    expect(provider.requests[0]?.messages).toHaveLength(1);
  });

  /* Retrieval is an improvement to the prompt, not a precondition for it. */
  it('falls back to the prompt when the model fails', async () => {
    const provider = mockProvider({
      reply: () => {
        throw new ProviderError({ provider: 'mock', message: 'rate limited' });
      },
    });
    await expect(searchQuery({ prompt: 'a coin', provider })).resolves.toBe('a coin');
  });

  it('falls back to the prompt when the reply is not keywords', async () => {
    const provider = mockProvider({ replies: [`Sure! ${'Here is my reasoning about water. '.repeat(10)}`] });
    await expect(searchQuery({ prompt: 'a splash', provider })).resolves.toBe('a splash');
  });
});

describe('the loop', () => {
  const reply = '```soundline\nsound "x" 40ms pop\n  a: click 2ms | gain 0.6 attack 0ms decay 20ms\n```\n';

  it('retrieves with the rewritten query when asked to', async () => {
    const queries: string[] = [];
    const bank = {
      retrieve: (query: string) => {
        queries.push(query);
        return Promise.resolve({ recipes: [recipe('coin')], fallback: false });
      },
    };
    const provider = mockProvider({ replies: ['coin pickup arcade', reply] });

    const result = await generateSound({
      prompt: 'монетка звякнула',
      provider,
      bank,
      rewriteQuery: true,
    });

    expect(queries).toEqual(['coin pickup arcade']);
    expect(result.accepted).toBe(true);
  });

  it('leaves the prompt alone by default', async () => {
    const queries: string[] = [];
    const bank = {
      retrieve: (query: string) => {
        queries.push(query);
        return Promise.resolve({ recipes: [recipe('coin')], fallback: false });
      },
    };
    await generateSound({ prompt: 'a coin', provider: mockProvider({ replies: [reply] }), bank });
    expect(queries).toEqual(['a coin']);
  });

  /* An explicit query is the caller saying it already knows better. */
  it('prefers an explicit retrieval query over a rewrite', async () => {
    const queries: string[] = [];
    const bank = {
      retrieve: (query: string) => {
        queries.push(query);
        return Promise.resolve({ recipes: [], fallback: false });
      },
    };
    const provider = mockProvider({ replies: [reply] });
    await generateSound({
      prompt: 'монетка',
      provider,
      bank,
      rewriteQuery: true,
      retrievalQuery: 'coin pickup',
    });
    expect(queries).toEqual(['coin pickup']);
    /* And the rewrite call was never made — the first reply went to the recipe. */
    expect(provider.requests).toHaveLength(1);
  });

  /* No bank means the rewrite has no consumer, so spending a call on it would be
     pure waste. */
  it('does not rewrite when there is no bank', async () => {
    const provider = mockProvider({ replies: [reply] });
    await generateSound({ prompt: 'монетка', provider, rewriteQuery: true });
    expect(provider.requests).toHaveLength(1);
  });

  it('reports what retrieval found, fallback included', async () => {
    const events: { query: string; count: number; fallback: boolean }[] = [];
    await generateSound({
      prompt: 'a coin',
      provider: mockProvider({ replies: [reply] }),
      bank: staticBank([recipe('coin')]),
      onEvent: (event) => {
        if (event.type === 'retrieval') events.push({ query: event.query, count: event.count, fallback: event.fallback });
      },
    });
    expect(events).toEqual([{ query: 'a coin', count: 1, fallback: false }]);
  });
});
