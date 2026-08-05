/**
 * Test-side audio plumbing for the optimizer.
 *
 * `node-web-audio-api` is reached only from here. The optimizer takes its
 * renderer as an argument precisely so that it never has to know an audio stack
 * exists; the tests are the ones that have to supply one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OfflineAudioContext as NodeOfflineAudioContext } from 'node-web-audio-api';
import type { SoundAST } from '@txt2sfx/shared';
import { renderSound } from '@txt2sfx/core';
import { extractProfile, type Signal } from '@txt2sfx/analyzer';
import type { Target } from '../../src/index.js';

const EXAMPLES_DIR = fileURLToPath(new URL('../../../../examples', import.meta.url));

/** Source text of one reference recipe, with newlines normalized. */
export function loadExample(name: string): string {
  return readFileSync(`${EXAMPLES_DIR}/${name}.soundline`, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Render an AST to mono samples — the `render` argument `optimize` expects.
 *
 * The channel data is **copied** out of the `AudioBuffer`, and that is not
 * defensive style. `node-web-audio-api`'s `getChannelData` hands back a view into
 * memory owned by the native context; hold that view while the context becomes
 * unreachable, and the next garbage collection frees the samples underneath it.
 * The symptom is spectacular and misleading: a signal that read as finite audio a
 * moment ago starts returning NaN, every distance involving it becomes NaN, and
 * eventually the process dies with no JavaScript stack — which is what a run of a
 * few hundred renders against one long-lived target does.
 *
 * Anything that keeps samples longer than the context that produced them has to
 * copy. Phase 5's seeder will be in exactly this position.
 */
export async function renderSignal(ast: SoundAST): Promise<Signal> {
  const result = await renderSound(ast, {
    context: (options) => new NodeOfflineAudioContext(options) as unknown as OfflineAudioContext,
  });
  return {
    samples: Float32Array.from(result.buffer.getChannelData(0)),
    sampleRate: result.buffer.sampleRate,
  };
}

/** A rendered recipe as an optimization target, profile and audio both. */
export async function targetFrom(ast: SoundAST): Promise<Target> {
  const signal = await renderSignal(ast);
  return { signal, profile: extractProfile(signal) };
}
