/**
 * The corpus dump.
 *
 * What is under test is the promise the dump makes: that the bank can be thrown away
 * without losing anything, and that what it publishes is the same thing it serves.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, serialize } from '@txt2sfx/core';
import { dumpBank, dumpFileName, dumpLine } from '../src/dump.js';
import { openDatabase } from '../src/schema.js';
import { soloActor } from '../src/identity.js';
import { type Store, storeOver } from '../src/store.js';

const MESSY = 'sound "tick" 45ms ui\n      body: tone sine 1800Hz  |  gain 0.6 decay 25ms\n';

let store: Store;
let directory: string;

beforeEach(() => {
  store = storeOver(openDatabase(':memory:'));
  directory = mkdtempSync(join(tmpdir(), 'txt2sfx-dump-'));
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const insert = (name: string, soundline: string) =>
  store.recipes.insert({
    name,
    prompt: `${name} for a game`,
    soundline,
    profile: {
      durationMs: 45,
      attackMs: 1,
      rmsEnvelope: [1, 0.2],
      centroidHz: [1800],
      flatness: 0.02,
      noiseRatio: 0.01,
      peakHz: 1800,
      loudnessLufsApprox: -14,
    },
    category: 'ui',
    tags: ['ui'],
    durationMs: 45,
  });

describe('dumping the bank', () => {
  it('writes one canonical soundline per recipe plus a jsonl index', () => {
    const stored = insert('tick', MESSY);
    const report = dumpBank(store.recipes, directory);

    expect(report.recipes).toBe(1);
    expect(report.unparsed).toEqual([]);

    const files = readdirSync(join(directory, 'soundlines'));
    expect(files).toEqual([dumpFileName(stored)]);

    /* Canonical, so the diff between two dumps is a change in the sound and never a
       change in whitespace. */
    const written = readFileSync(join(directory, 'soundlines', files[0] ?? ''), 'utf8');
    expect(written).toBe(serialize(parse(MESSY)));
    expect(written).not.toBe(MESSY);

    const lines = readFileSync(join(directory, 'bank.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ name: 'tick', category: 'ui', likes: 0 });
  });

  /** Moderation that does not reach the published corpus is not moderation. */
  it('skips hidden recipes', () => {
    const keep = insert('tick', MESSY);
    const hide = insert('spam', 'sound "spam" 45ms ui\n  body: tone sine 900Hz | gain 0.6 decay 25ms\n');
    store.recipes.setHidden(hide.id, true);

    const report = dumpBank(store.recipes, directory);
    expect(report.recipes).toBe(1);
    expect(readdirSync(join(directory, 'soundlines'))).toEqual([dumpFileName(keep)]);
    expect(readFileSync(join(directory, 'bank.jsonl'), 'utf8')).not.toContain('spam');
  });

  it('names files by id first, because two people may publish the same name', () => {
    const a = insert('laser', 'sound "laser" 300ms laser\n  body: chirp saw 2000Hz -> 200Hz in 240ms | gain 0.7 decay 260ms\n');
    const b = insert('laser', 'sound "laser" 300ms laser\n  body: chirp saw 2400Hz -> 200Hz in 240ms | gain 0.7 decay 260ms\n');
    dumpBank(store.recipes, directory);
    const files = readdirSync(join(directory, 'soundlines'));
    expect(files).toHaveLength(2);
    expect(files).toContain(dumpFileName(a));
    expect(files).toContain(dumpFileName(b));
  });

  it('writes a recipe that no longer parses as stored, and says which', () => {
    insert('legacy', 'this was a soundline in an older grammar');
    const report = dumpBank(store.recipes, directory);
    expect(report.unparsed).toEqual(['legacy']);
    const written = readFileSync(join(directory, 'soundlines', readdirSync(join(directory, 'soundlines'))[0] ?? ''), 'utf8');
    expect(written).toContain('older grammar');
  });

  it('carries attribution, lineage and likes into the index', () => {
    const actor = soloActor(store.identity);
    const parent = insert('tick', MESSY);
    const child = store.recipes.insert(
      { ...insertInput('tick-bright'), soundline: 'sound "tick" 45ms ui\n  body: tone sine 2400Hz | gain 0.6 decay 25ms\n' },
      { authorId: actor.id, parentId: parent.id },
    );
    store.social.like(child.id, actor.id);

    const line = JSON.parse(dumpLine(store.recipes.get(child.id) ?? child));
    expect(line).toMatchObject({ author: 'local', parentId: parent.id, likes: 1 });
    expect(line.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  /** Everything the index promises is present, in a stable order. */
  it('has no session, token, bucket, report or comment in it', () => {
    insert('tick', MESSY);
    const keys = Object.keys(JSON.parse(dumpLine(store.recipes.list()[0] ?? insert('x', MESSY))));
    expect(keys).toEqual([
      'id', 'name', 'prompt', 'category', 'tags', 'durationMs', 'likes',
      'createdAt', 'author', 'parentId', 'fingerprint', 'soundline', 'profile',
    ]);
  });
});

/** The insert payload, minus the soundline, for the cases that need to vary it. */
function insertInput(name: string) {
  return {
    name,
    prompt: `${name} for a game`,
    soundline: MESSY,
    profile: {
      durationMs: 45,
      attackMs: 1,
      rmsEnvelope: [1, 0.2],
      centroidHz: [1800],
      flatness: 0.02,
      noiseRatio: 0.01,
      peakHz: 1800,
      loudnessLufsApprox: -14,
    },
    category: 'ui' as const,
    tags: ['ui'],
    durationMs: 45,
  };
}
