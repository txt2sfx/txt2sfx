/**
 * Physical limits of the sounds txt2sfx is allowed to emit.
 *
 * These numbers are the project's opinion, not physics handed down from above.
 * They encode what a listener accepts as "a pop", "a laser", "an explosion" —
 * the boundaries where a synthesized event stops reading as that event. The
 * validator turns every number here into a `ValidationIssue` with a hint, and
 * those hints are what the LLM sees when it overshoots.
 *
 * @packageDocumentation
 */

import type { SoundCategory } from './types.js';

/** Every category the validator knows about, in documentation order. */
export const SOUND_CATEGORIES = [
  'pop',
  'ui',
  'laser',
  'impact',
  'explosion',
  'pickup',
  'foley',
  'cycle',
  'misc',
] as const satisfies readonly SoundCategory[];

/** Per-category physical envelope of a plausible sound. */
export interface CategoryLimits {
  /** Total duration contract, in milliseconds. */
  readonly minDurationMs: number;
  readonly maxDurationMs: number;
  /** Longest decay any single layer may declare, in milliseconds. */
  readonly maxLayerDecayMs: number;
  /**
   * Longest frequency ramp allowed, in milliseconds.
   *
   * This is the anti-"pew" rule: a 120 ms downward sweep on something labelled
   * `pop` is the single most common way a language model turns a bubble pop
   * into a cartoon laser.
   */
  readonly maxFreqRampMs: number;
  /** Layer budget — tighter than the global cap for transient categories. */
  readonly maxLayers: number;
  /** Whether the header must carry the `loop` flag. */
  readonly requiresLoop: boolean;
  /** Prose used in validator hints and in PRIMITIVES.md. */
  readonly doc: string;
}

/**
 * Category limits.
 *
 * Sources of the ranges: pop/click transients are 10–60 ms because that is the
 * span of a real bursting membrane; UI feedback below ~30 ms reads as a glitch
 * and above ~120 ms as sluggish; laser/zap sits at 80–300 ms in every game
 * mix; impacts and explosions carry 200–1500 ms of body and rumble; loopable
 * cycles need at least half a second to establish a period and rarely exceed
 * three seconds before the loop becomes audible.
 */
export const CATEGORY_LIMITS: Readonly<Record<SoundCategory, CategoryLimits>> = {
  pop: {
    minDurationMs: 8,
    maxDurationMs: 60,
    maxLayerDecayMs: 40,
    maxFreqRampMs: 20,
    maxLayers: 4,
    requiresLoop: false,
    doc: 'Bursting, snapping, clicking transients: bubble wrap, cork, knuckle.',
  },
  ui: {
    minDurationMs: 30,
    maxDurationMs: 120,
    maxLayerDecayMs: 100,
    maxFreqRampMs: 40,
    maxLayers: 4,
    requiresLoop: false,
    doc: 'Interface feedback: clicks, ticks, toggles, hovers, errors.',
  },
  laser: {
    minDurationMs: 80,
    maxDurationMs: 300,
    maxLayerDecayMs: 300,
    maxFreqRampMs: 300,
    maxLayers: 4,
    requiresLoop: false,
    doc: 'Sci-fi beams and zaps: fast pitch sweeps with a resonant tail.',
  },
  impact: {
    minDurationMs: 60,
    maxDurationMs: 1500,
    maxLayerDecayMs: 1200,
    maxFreqRampMs: 400,
    maxLayers: 6,
    requiresLoop: false,
    doc: 'Hits and clashes: metal, wood, stone, body impacts.',
  },
  explosion: {
    minDurationMs: 200,
    maxDurationMs: 1500,
    maxLayerDecayMs: 1400,
    maxFreqRampMs: 900,
    maxLayers: 6,
    requiresLoop: false,
    doc: 'Blasts: sub body, broadband blast, crack, rumble tail.',
  },
  pickup: {
    minDurationMs: 80,
    maxDurationMs: 900,
    maxLayerDecayMs: 800,
    maxFreqRampMs: 600,
    maxLayers: 5,
    requiresLoop: false,
    doc: 'Rewards: coins, power-ups, level-ups, arcade jingles.',
  },
  foley: {
    minDurationMs: 40,
    maxDurationMs: 2000,
    maxLayerDecayMs: 1800,
    maxFreqRampMs: 1500,
    maxLayers: 6,
    requiresLoop: false,
    doc: 'Everyday physical events: footsteps, cloth, hinges, latches.',
  },
  cycle: {
    minDurationMs: 500,
    maxDurationMs: 3000,
    maxLayerDecayMs: 3000,
    maxFreqRampMs: 3000,
    maxLayers: 6,
    requiresLoop: true,
    doc: 'Loopable textures: rotors, engines, hums, wind. Header needs `loop`.',
  },
  misc: {
    minDurationMs: 5,
    maxDurationMs: 3000,
    maxLayerDecayMs: 3000,
    maxFreqRampMs: 3000,
    maxLayers: 6,
    requiresLoop: false,
    doc: 'Escape hatch: anything that does not fit a category above.',
  },
};

/** Limits that hold for every sound regardless of category. */
export const GLOBAL_LIMITS = {
  /**
   * Peak sample amplitude of the rendered mix. 0.95 leaves headroom for the
   * consumer's own gain staging and keeps intersample peaks off the rails.
   */
  maxPeak: 0.95,
  /** Hard cap on layer count — beyond this the export stops being compact. */
  maxLayers: 6,
  /**
   * Smallest target of an exponential ramp. Web Audio's
   * `exponentialRampToValueAtTime` throws on 0 and silently misbehaves near it;
   * 0.001 is -60 dB, inaudible, and safe.
   */
  minExpTarget: 0.001,
  /** Render sample rate used by the offline renderer and the analyzer. */
  sampleRate: 44100,
  /** Codegen budget: the exported function should stay inside this. */
  maxExportBytes: 1024,
} as const;

/** Units the lexer accepts as suffixes of numeric literals. */
export const UNITS = ['Hz', 'kHz', 'ms', 's', 'dB'] as const;
