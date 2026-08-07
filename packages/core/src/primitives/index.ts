/**
 * Registry of DSP builders, keyed exactly like the grammar's signature tables.
 *
 * The two registries must stay in lockstep with `grammar/signatures.ts` — a word
 * the parser accepts but the compiler cannot build would fail at render time
 * instead of at parse time, which is the one failure mode this project is
 * designed to avoid. {@link assertRegistryComplete} makes that a test, not a
 * hope.
 *
 * @packageDocumentation
 */

import { EFFECT_NAMES, PRIMITIVE_NAMES } from '../grammar/signatures.js';
import { chirp } from './chirp.js';
import { click } from './click.js';
import { fm } from './fm.js';
import { grains } from './grains.js';
import { modal } from './modal.js';
import { noise } from './noise.js';
import { plate } from './plate.js';
import { pluck } from './pluck.js';
import { sub } from './sub.js';
import { tone } from './tone.js';
import { bp } from './effects/bp.js';
import { delay } from './effects/delay.js';
import { dist } from './effects/dist.js';
import { hp } from './effects/hp.js';
import { lp } from './effects/lp.js';
import { verb } from './effects/verb.js';
import type { EffectDef, PrimitiveDef } from './types.js';

/** Every primitive builder, keyed by the word that opens a layer. */
export const PRIMITIVE_DEFS: Readonly<Record<string, PrimitiveDef>> = {
  tone,
  noise,
  chirp,
  pluck,
  modal,
  plate,
  fm,
  sub,
  click,
  grains,
};

/** Every effect builder, keyed by the word that follows `>>`. */
export const EFFECT_DEFS: Readonly<Record<string, EffectDef>> = {
  lp,
  hp,
  bp,
  dist,
  delay,
  verb,
};

/** Look up a primitive builder; throws when the grammar knows a word this does not. */
export function primitiveDef(name: string): PrimitiveDef {
  const def = PRIMITIVE_DEFS[name];
  if (def === undefined) throw new Error(`no DSP builder for primitive '${name}'`);
  return def;
}

/** Look up an effect builder; throws when the grammar knows a word this does not. */
export function effectDef(name: string): EffectDef {
  const def = EFFECT_DEFS[name];
  if (def === undefined) throw new Error(`no DSP builder for effect '${name}'`);
  return def;
}

/**
 * Names the grammar accepts but the compiler cannot build, and vice versa.
 *
 * Empty in a healthy build; asserted empty by `test/primitives.test.ts`.
 */
export function registryGaps(): { readonly missing: string[]; readonly extra: string[] } {
  const declared = [...PRIMITIVE_NAMES, ...EFFECT_NAMES];
  const built = [...Object.keys(PRIMITIVE_DEFS), ...Object.keys(EFFECT_DEFS)];
  return {
    missing: declared.filter((name) => !built.includes(name)),
    extra: built.filter((name) => !declared.includes(name)),
  };
}

export type { BuildContext, EffectDef, PrimitiveDef } from './types.js';
