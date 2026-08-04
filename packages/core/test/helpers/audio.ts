/**
 * Test-side audio plumbing.
 *
 * `node-web-audio-api` lives here and only here: the core package injects its
 * offline context (see `render/offline.ts`), so the native module is a
 * devDependency of the workspace and never a dependency of the library.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfflineAudioContext as NodeOfflineAudioContext } from 'node-web-audio-api';
import type { SoundAST } from '@txt2sfx/shared';
import { parse } from '../../src/index.js';
import type { OfflineContextFactory } from '../../src/render/offline.js';

const EXAMPLES_DIR = fileURLToPath(new URL('../../../../examples', import.meta.url));

/**
 * The injected factory.
 *
 * `node-web-audio-api` implements the same interface but is not structurally
 * identical to lib.dom's declarations, so the cast happens once, here, instead of
 * leaking casts into every test.
 */
export const offlineContext: OfflineContextFactory = (options) =>
  new NodeOfflineAudioContext(options) as unknown as OfflineAudioContext;

/** One reference recipe: its file name, source text and parsed AST. */
export interface Example {
  readonly file: string;
  readonly name: string;
  readonly source: string;
  readonly ast: SoundAST;
}

/** Every `examples/*.soundline`, parsed. */
export function loadExamples(): Example[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith('.soundline'))
    .sort()
    .map((file) => {
      const source = readFileSync(join(EXAMPLES_DIR, file), 'utf8').replace(/\r\n/g, '\n');
      return { file, name: file.replace(/\.soundline$/, ''), source, ast: parse(source) };
    });
}

/**
 * Coarse RMS envelope of a buffer.
 *
 * The phase-3 analyzer will do this properly; here it is only needed to compare
 * two renders of the same sound, where a shape comparison is more informative
 * than a per-sample one.
 */
export function rmsEnvelope(buffer: AudioBuffer, points = 64): number[] {
  const data = buffer.getChannelData(0);
  const size = Math.max(1, Math.floor(data.length / points));
  const out: number[] = [];
  for (let p = 0; p < points; p++) {
    let sum = 0;
    let count = 0;
    for (let i = p * size; i < Math.min((p + 1) * size, data.length); i++) {
      const value = data[i] ?? 0;
      sum += value * value;
      count += 1;
    }
    out.push(count > 0 ? Math.sqrt(sum / count) : 0);
  }
  return out;
}

/** Largest absolute difference between two buffers, sample by sample. */
export function maxAbsDiff(a: AudioBuffer, b: AudioBuffer): number {
  const left = a.getChannelData(0);
  const right = b.getChannelData(0);
  let worst = 0;
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = Math.abs((left[i] ?? 0) - (right[i] ?? 0));
    if (diff > worst) worst = diff;
  }
  return worst;
}

/** Root-mean-square of a whole buffer. */
export function rms(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += (data[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, data.length));
}
