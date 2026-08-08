/**
 * Ranking a library's answer, and the two ways it must not break.
 *
 * A ranking that invents an id puts a recording on screen that the search never
 * returned — the user clicks play and hears a 404. A ranking that drops rows makes a
 * search silently return less than it found. Both are invisible from the outside,
 * which is why the parser is strict and the caller keeps every row.
 */

import { describe, expect, it } from 'vitest';
import { mockProvider, parseRanking, rankSounds, type RankCandidate } from '../src/index.js';
import { ProviderError } from '../src/provider.js';

const candidates: readonly RankCandidate[] = [
  { id: 101, name: 'door_slam_heavy.wav', seconds: 1.2, tags: ['door', 'wood', 'slam'] },
  { id: 202, name: 'door ambience loop', seconds: 47.5, tags: ['door', 'room', 'ambience'] },
  { id: 303, name: 'latch_click.flac', seconds: 0.4, tags: ['latch', 'metal', 'click'] },
];

const ids = candidates.map((c) => c.id);

describe('parseRanking', () => {
  it('reads id and reason, in the model’s order', () => {
    expect(parseRanking('101 - heavy wooden slam, right length\n303 - metal latch after the slam', ids)).toEqual([
      { id: 101, note: 'heavy wooden slam, right length' },
      { id: 303, note: 'metal latch after the slam' },
    ]);
  });

  /* Every separator a model reaches for between a number and its reason. */
  it('accepts the punctuation models actually use', () => {
    expect(parseRanking('#101: wood\n202. room tone\n303 — metal', ids).map((r) => r.note)).toEqual([
      'wood',
      'room tone',
      'metal',
    ]);
  });

  it('keeps a bare id with no reason', () => {
    expect(parseRanking('101', ids)).toEqual([{ id: 101, note: '' }]);
  });

  /* The failure that reaches the screen as a broken play button. */
  it('drops ids that were never offered', () => {
    expect(parseRanking('999 - perfect match\n101 - fine', ids)).toEqual([{ id: 101, note: 'fine' }]);
  });

  it('keeps the first mention of a repeated id', () => {
    expect(parseRanking('101 - first\n101 - second', ids)).toEqual([{ id: 101, note: 'first' }]);
  });

  it('ignores prose between the lines instead of failing on it', () => {
    const reply = 'Here is my ranking:\n\n101 - closest\nThe others are ambience.\n303 - second best';
    expect(parseRanking(reply, ids).map((r) => r.id)).toEqual([101, 303]);
  });

  it('caps a reason that turned into prose', () => {
    const note = parseRanking(`101 - ${'because it matches the request very well '.repeat(10)}`, ids)[0]?.note ?? '';
    expect(note.length).toBeLessThanOrEqual(80);
  });

  it('rejects a reply too long to be a ranking', () => {
    expect(parseRanking('101 - ok\n'.repeat(1000), ids)).toEqual([]);
  });
});

describe('rankSounds', () => {
  it('sends the request and the list, and returns the order', async () => {
    const provider = mockProvider({ replies: ['303 - short metal latch\n101 - wooden slam'] });
    const ranked = await rankSounds({ prompt: 'ржавая щеколда падает', candidates, provider });

    expect(ranked.map((r) => r.id)).toEqual([303, 101]);
    const sent = provider.requests[0]?.messages[0]?.content ?? '';
    expect(sent).toContain('ржавая щеколда падает');
    expect(sent).toContain('101 | door_slam_heavy.wav | 1.2s | door, wood, slam');
    /* Provenance prose in a description is most of the tokens and none of the signal,
       so it is never sent — see the note on `RankCandidate`. */
    expect(sent).not.toContain('Zoom');
  });

  /* This step improves an order; it is not a precondition for one. Every failure
     means "keep the order the library gave", never "show nothing". */
  it('returns nothing to apply when the model fails', async () => {
    const provider = mockProvider({
      reply: () => {
        throw new ProviderError({ provider: 'mock', message: 'rate limited' });
      },
    });
    await expect(rankSounds({ prompt: 'a door', candidates, provider })).resolves.toEqual([]);
  });

  it('returns nothing to apply when the reply is not a ranking', async () => {
    const provider = mockProvider({ replies: ['I cannot rank these without hearing them.'] });
    await expect(rankSounds({ prompt: 'a door', candidates, provider })).resolves.toEqual([]);
  });

  it('does not call the model with nothing to rank', async () => {
    const provider = mockProvider({ replies: ['101 - x'] });
    await expect(rankSounds({ prompt: 'a door', candidates: [], provider })).resolves.toEqual([]);
    await expect(rankSounds({ prompt: '  ', candidates, provider })).resolves.toEqual([]);
    expect(provider.requests).toHaveLength(0);
  });
});
