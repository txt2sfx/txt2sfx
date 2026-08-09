/**
 * The kept-renders store, minus the IndexedDB plumbing.
 *
 * Same division as `lib/keystore.ts`: the decisions are pure and tested here, and the
 * ~40 lines that talk to IndexedDB fail loudly rather than quietly. What matters is that
 * one record left by an older build cannot take the sidebar down with it, and that the
 * cap drops the *oldest* — a list that evicted the newest would throw away the render
 * somebody is looking at.
 */

import { describe, expect, it } from 'vitest';
import { RENDER_LIMIT, isKeptRender, newestFirst, type KeptRender } from '../src/lib/renders.js';

function record(overrides: Partial<KeptRender> = {}): KeptRender {
  return {
    id: 'a',
    title: 'Metal Door Slam',
    file: 'sfx_metal_door_slam',
    blob: new Blob(['x'], { type: 'audio/mpeg' }),
    extension: 'mp3',
    bytes: 1,
    durationMs: 2000,
    prompt: 'heavy steel door slams shut',
    seed: 24301,
    at: 1000,
    ...overrides,
  };
}

describe('isKeptRender', () => {
  it('accepts what this version writes', () => {
    expect(isKeptRender(record())).toBe(true);
  });

  it('rejects anything that is not the current shape', () => {
    expect(isKeptRender(null)).toBe(false);
    expect(isKeptRender({})).toBe(false);
    expect(isKeptRender({ ...record(), id: '' })).toBe(false);
    /* The one field a reader cannot substitute for: without the bytes there is nothing
       to play and nothing to download, so the row would be a name and two dead buttons. */
    expect(isKeptRender({ ...record(), blob: 'data:audio/mpeg;base64,AAA' })).toBe(false);
    expect(isKeptRender({ ...record(), durationMs: '2s' })).toBe(false);
  });
});

describe('newestFirst', () => {
  it('orders by when it was made, newest first', () => {
    const ordered = newestFirst([record({ id: 'old', at: 1 }), record({ id: 'new', at: 9 })]);
    expect(ordered.map((entry) => entry.id)).toEqual(['new', 'old']);
  });

  it('keeps the newest up to the cap and drops the oldest', () => {
    const many = Array.from({ length: RENDER_LIMIT + 5 }, (_unused, index) =>
      record({ id: `r${String(index)}`, at: index }),
    );
    const kept = newestFirst(many);
    expect(kept).toHaveLength(RENDER_LIMIT);
    expect(kept[0]?.id).toBe(`r${String(RENDER_LIMIT + 4)}`);
    expect(kept.map((entry) => entry.id)).not.toContain('r0');
  });

  it('does not mutate what it was given', () => {
    const given = [record({ id: 'a', at: 1 }), record({ id: 'b', at: 9 })];
    newestFirst(given);
    expect(given.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});
