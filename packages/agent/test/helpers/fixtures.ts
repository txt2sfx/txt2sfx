/**
 * Fixtures shared by the agent tests: stored recipes, a renderer, and a target.
 *
 * `node-web-audio-api` is reached only from here, exactly as in the optimizer's
 * tests — the package under test takes its renderer as an argument so that it never
 * has to know an audio stack exists.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OfflineAudioContext as NodeOfflineAudioContext } from 'node-web-audio-api';
import type { Recipe, SoundAST, SoundCategory, SoundProfile } from '@txt2sfx/shared';
import { declaredDurationMs, parse, renderSound } from '@txt2sfx/core';
import { extractProfile, type Signal } from '@txt2sfx/analyzer';
import type { Target } from '@txt2sfx/optimizer';

const EXAMPLES_DIR = fileURLToPath(new URL('../../../../examples', import.meta.url));

/** Source text of one reference recipe, newlines normalized (`.gitattributes`). */
export function loadExample(name: string): string {
  return readFileSync(`${EXAMPLES_DIR}/${name}.soundline`, 'utf8').replace(/\r\n/g, '\n');
}

/** A profile-shaped placeholder: the bank stores one, few-shot never reads it. */
export const PLACEHOLDER_PROFILE: SoundProfile = {
  durationMs: 42,
  attackMs: 1,
  rmsEnvelope: [1, 0.5, 0.2],
  centroidHz: [1100, 900],
  flatness: 0.01,
  noiseRatio: 0.02,
  peakHz: 836,
  loudnessLufsApprox: -15,
};

let nextId = 1;

/** A stored recipe built around a soundline, with the derived fields filled in. */
export function storedRecipe(init: {
  name: string;
  soundline: string;
  prompt?: string;
  tags?: readonly string[];
  rating?: number;
}): Recipe {
  let category: SoundCategory = 'misc';
  let durationMs = 0;
  try {
    const ast = parse(init.soundline);
    category = ast.category;
    durationMs = declaredDurationMs(ast);
  } catch {
    /* A deliberately broken fixture still has to be constructible: `selectFewShot`
       is the thing under test in that case. */
  }
  return {
    id: nextId++,
    name: init.name,
    prompt: init.prompt ?? `${init.name} sound`,
    soundline: init.soundline,
    profile: PLACEHOLDER_PROFILE,
    category,
    tags: init.tags ?? [init.name],
    durationMs,
    rating: init.rating ?? 0,
    createdAt: '2026-08-05T00:00:00.000Z',
  };
}

/**
 * Render an AST to mono samples.
 *
 * The channel data is **copied**: `getChannelData` returns a view into memory the
 * native context owns, and a target held across later renders turns to NaN when
 * that context is collected (§7.2 of the plan).
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

/** A rendered recipe as an optimization target. */
export async function targetFrom(source: string, options: { withAudio?: boolean } = {}): Promise<Target> {
  const signal = await renderSignal(parse(source));
  const profile = extractProfile(signal);
  /* Profile-only by default: the spectral loss is the expensive half, and a test
     that only needs "is this the same sound" does not need it. */
  return options.withAudio === true ? { profile, signal } : { profile };
}

/** A reply as a model would send it: one fenced block and a sentence of prose. */
export function fenced(soundline: string, prose = 'Here you go:'): string {
  return `${prose}\n\n\`\`\`\n${soundline}\`\`\`\n`;
}
