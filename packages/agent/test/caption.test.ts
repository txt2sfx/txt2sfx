/**
 * Captioning a request for the reference model.
 *
 * The failure being fixed is invisible from the outside — a Russian prompt reaches
 * `run.py` intact, is destroyed by t5-base's tokenizer, and comes back as thirty
 * seconds of CPU spent on the model's median output. So the tests here pin the two
 * things that stop that: a caption the tokenizer can actually read, and an honest
 * report when no model was available to write one.
 */

import { describe, expect, it } from 'vitest';
import { CAPTION_LIMIT, audioCaption, captionIssue, mockProvider, parseCaption } from '../src/index.js';
import { ProviderError } from '../src/provider.js';

const CAPTION = 'ice magic spell cast, frozen arrow whoosh, crystalline shatter, sharp attack, dry close-up';

describe('parseCaption', () => {
  it('takes a caption line as it is', () => {
    expect(parseCaption(CAPTION)).toBe(CAPTION);
  });

  it('strips the quoting and labelling a model adds despite being told not to', () => {
    expect(parseCaption('"glass bottle shattering, bright debris"')).toBe('glass bottle shattering, bright debris');
    expect(parseCaption('Caption: glass bottle shattering')).toBe('glass bottle shattering');
    expect(parseCaption('**glass bottle shattering**')).toBe('glass bottle shattering');
  });

  it('keeps only the first line, which is where a model puts the answer', () => {
    expect(parseCaption(`${CAPTION}\n\nI chose "crystalline" because…`)).toBe(CAPTION);
  });

  /* A newline surviving into the caption would reach argv and be refused there as a
     control character — a confusing way to learn that a model wrapped its answer. */
  it('collapses whitespace', () => {
    expect(parseCaption('  metal   door \t clunk  ')).toBe('metal door clunk');
  });

  it('rejects an empty reply', () => {
    expect(parseCaption('')).toBeUndefined();
    expect(parseCaption('   \n  ')).toBeUndefined();
    expect(parseCaption('""')).toBeUndefined();
  });

  /* Unlike a retrieval query, there is no good fallback to reject in favour of: the
     raw prompt is the thing that was unreadable. So a long reply is trimmed, and
     trimmed at a descriptor boundary rather than mid-word. */
  it('trims a long reply at the last comma inside the limit', () => {
    const long = `${'wooden crate smashing on stone, '.repeat(10)}dry close-up`;
    const parsed = parseCaption(long);
    expect(parsed?.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(parsed?.endsWith('stone')).toBe(true);
  });

  it('trims at a word boundary when there is no comma to use', () => {
    const long = `${'rumbling '.repeat(40)}end`;
    const parsed = parseCaption(long);
    expect(parsed?.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(parsed?.endsWith('rumbling')).toBe(true);
  });

  it('rejects an essay rather than trimming one', () => {
    expect(parseCaption('Certainly! '.repeat(400))).toBeUndefined();
  });
});

describe('captionIssue', () => {
  it('passes a caption t5-base can read', () => {
    expect(captionIssue(CAPTION)).toBeNull();
    /* Numbers and punctuation carry meaning in requests like "8-bit" and "~500 Hz". */
    expect(captionIssue('8-bit arcade blip, ~500 Hz square wave, very short')).toBeNull();
  });

  /* Every script breaks in the same place, so the rule is "not Latin" rather than a
     list — the measurement in the module header is Cyrillic, but Han and Hangul
     tokenize into the same holes. */
  it('reports any non-Latin letter', () => {
    expect(captionIssue('магическое заклинание')).toBe('script');
    expect(captionIssue('氷の矢')).toBe('script');
    expect(captionIssue('ice arrow, 얼음 화살')).toBe('script');
  });

  it('accepts Latin letters that carry accents', () => {
    expect(captionIssue('café door chime, dry')).toBeNull();
  });

  it('reports a caption past what the 64-token window holds', () => {
    expect(captionIssue('a'.repeat(CAPTION_LIMIT))).toBeNull();
    expect(captionIssue('a'.repeat(CAPTION_LIMIT + 1))).toBe('length');
  });
});

describe('audioCaption', () => {
  it('asks the model and reports that a model wrote it', async () => {
    const provider = mockProvider({ replies: [CAPTION] });
    await expect(
      audioCaption({ prompt: 'магическое заклинание леденая стрела', provider, seconds: 2 }),
    ).resolves.toEqual({ text: CAPTION, source: 'model' });
    expect(provider.requests[0]?.maxTokens).toBe(128);
  });

  /* The length is not decoration: two seconds is one event with an attack and a
     decay, eight is something that evolves, and the same checkpoint is conditioned on
     `seconds_total` either way. */
  it('tells the model how long the render is', async () => {
    const provider = mockProvider({ replies: [CAPTION] });
    await audioCaption({ prompt: 'a coin', provider, seconds: 2 });
    expect(provider.requests[0]?.messages[0]?.content).toContain('2 seconds');
    expect(provider.requests[0]?.messages[0]?.content).toContain('one-shot');
  });

  it('leaves the length out when the caller did not say', async () => {
    const provider = mockProvider({ replies: [CAPTION] });
    await audioCaption({ prompt: 'a coin', provider });
    expect(provider.requests[0]?.messages[0]?.content).toBe('a coin');
  });

  /* Never rejects: the caller shows this in an editable field, and an exception there
     would replace a usable starting point with nothing. */
  it('falls back to the prompt and says why when the call fails', async () => {
    const provider = mockProvider({
      reply: () => {
        throw new ProviderError({ provider: 'mock', message: 'rate limited' });
      },
    });
    const caption = await audioCaption({ prompt: 'a coin', provider });
    expect(caption).toMatchObject({ text: 'a coin', source: 'prompt' });
    expect(caption.note).toContain('rate limited');
  });

  it('falls back to the prompt when the reply is not a caption', async () => {
    const provider = mockProvider({ replies: ['Certainly! '.repeat(400)] });
    const caption = await audioCaption({ prompt: 'a coin', provider });
    expect(caption).toMatchObject({ text: 'a coin', source: 'prompt' });
  });

  it('spends no call on an empty prompt', async () => {
    const provider = mockProvider({ replies: [CAPTION] });
    const caption = await audioCaption({ prompt: '   ', provider });
    expect(caption.text).toBe('');
    expect(provider.requests).toHaveLength(0);
  });
});
