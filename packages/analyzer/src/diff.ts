/**
 * Turning a distance into instructions.
 *
 * ## Why numbers are not enough
 *
 * A language model handed `centroid: 1204 vs 3390` has to work out which
 * direction is which, which parameter moves it, and which layer owns that
 * parameter — three inferences, each of which it can get wrong, before it makes
 * an edit. Handed `centroid 1.2kHz vs 3.4kHz — raise bp frequency in layer
 * 'snap'`, it edits. These strings, not the raw fields, are what goes into the
 * prompt.
 *
 * ## Only what is wrong, worst first
 *
 * Every directive has a threshold, and a field inside it produces nothing at
 * all. A model told about eight discrepancies will fix the first two and
 * restructure something unrelated; told about the two that matter, it fixes
 * them. The ordering is by the same normalized distance the fitness function
 * uses, so the list and the score never disagree about what is worst.
 *
 * @packageDocumentation
 */

import type { SoundAST, SoundProfile } from '@txt2sfx/shared';
import { profileDistanceParts, type ProfileDistanceParts } from './distance.js';

/** How large a normalized field distance has to be to earn a directive. */
const THRESHOLD = 0.08;

const hz = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}kHz` : `${Math.round(value)}Hz`;

const ms = (value: number): string => `${Math.round(value)}ms`;

/** Mean of a series. */
const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/** Filters, in the order a "make it brighter" instruction should prefer them. */
const FILTERS = ['bp', 'lp', 'hp'] as const;

/**
 * The layer whose filter is the best place to move the spectrum.
 *
 * Picked as the filter tuned closest to where the sound's energy currently sits:
 * that is the one already shaping the band in question, so moving it changes the
 * centroid instead of adding a second, competing resonance. Without an AST there
 * is nothing to name and the directive stays generic rather than guessing.
 */
function filterSite(ast: SoundAST | undefined, nearHz: number): string | undefined {
  if (ast === undefined) return undefined;
  let best: { layer: string; effect: string; distance: number } | undefined;
  for (const layer of ast.layers) {
    for (const effect of layer.chain) {
      if (!FILTERS.includes(effect.name as (typeof FILTERS)[number])) continue;
      const arg = effect.args['freq'];
      if (arg === undefined || arg.kind !== 'number') continue;
      const value = arg.head.unit === 'kHz' ? arg.head.value * 1000 : arg.head.value;
      const distance = Math.abs(Math.log2(Math.max(value, 1) / Math.max(nearHz, 1)));
      if (best === undefined || distance < best.distance) {
        best = { layer: layer.name, effect: effect.name, distance };
      }
    }
  }
  return best === undefined ? undefined : `${best.effect} frequency in layer '${best.layer}'`;
}

/** The loudest layer by written gain — where a level correction should land. */
function loudestLayer(ast: SoundAST | undefined): string | undefined {
  if (ast === undefined || ast.layers.length === 0) return undefined;
  let best = ast.layers[0];
  let bestGain = -Infinity;
  for (const layer of ast.layers) {
    const arg = layer.envelope.args['gain'];
    const gain = arg !== undefined && arg.kind === 'number' ? arg.head.value : 1;
    if (gain > bestGain) {
      bestGain = gain;
      best = layer;
    }
  }
  return best?.name;
}

/** One directive and the distance that justified it. */
interface Directive {
  readonly weight: number;
  readonly text: string;
}

/**
 * Differences between a candidate and a target, phrased as instructions.
 *
 * @param candidate - Profile of what was rendered.
 * @param target - Profile of what was asked for.
 * @param ast - The candidate's soundline, when available. With it, directives
 *   name the layer and parameter to change; without it they say what is wrong
 *   but not where.
 */
export function humanReadableDiff(
  candidate: SoundProfile,
  target: SoundProfile,
  ast?: SoundAST,
): string[] {
  const parts: ProfileDistanceParts = profileDistanceParts(candidate, target);
  const directives: Directive[] = [];

  const add = (weight: number, text: string): void => {
    if (weight >= THRESHOLD) directives.push({ weight, text });
  };

  if (candidate.durationMs > target.durationMs) {
    add(
      parts.duration,
      `duration is ${ms(candidate.durationMs)}, target ${ms(target.durationMs)} — shorten the layer decays and any delay or reverb tail`,
    );
  } else {
    add(
      parts.duration,
      `duration is ${ms(candidate.durationMs)}, target ${ms(target.durationMs)} — lengthen the decay of the layer that carries the body`,
    );
  }

  add(
    parts.attack,
    candidate.attackMs > target.attackMs
      ? `attack is ${ms(candidate.attackMs)}, target ${ms(target.attackMs)} — shorten the gain ramp`
      : `attack is ${ms(candidate.attackMs)}, target ${ms(target.attackMs)} — lengthen the gain ramp so the onset is less abrupt`,
  );

  const candidateCentroid = mean(candidate.centroidHz);
  const targetCentroid = mean(target.centroidHz);
  const site = filterSite(ast, candidateCentroid);
  const direction = candidateCentroid < targetCentroid ? 'raise' : 'lower';
  add(
    parts.centroid,
    `centroid ${hz(candidateCentroid)} vs ${hz(targetCentroid)} — ${direction} ${site ?? 'the filter frequency in the layer carrying the texture'}`,
  );

  const partialDirection = candidate.peakHz < target.peakHz ? 'raise' : 'lower';
  add(
    parts.peakHz,
    `dominant partial ${hz(candidate.peakHz)} vs ${hz(target.peakHz)} — ${partialDirection} the source frequency; a wrong dominant partial is heard as the wrong object, not as the wrong tone`,
  );

  add(
    parts.flatness,
    candidate.flatness < target.flatness
      ? `too tonal (flatness ${candidate.flatness.toFixed(3)} vs ${target.flatness.toFixed(3)}) — add or raise a noise layer, or widen the band-pass Q`
      : `too noisy (flatness ${candidate.flatness.toFixed(3)} vs ${target.flatness.toFixed(3)}) — lower the noise layer's gain, or narrow the band-pass Q`,
  );

  add(
    parts.noiseRatio,
    candidate.noiseRatio < target.noiseRatio
      ? `not enough broadband content (${candidate.noiseRatio.toFixed(2)} vs ${target.noiseRatio.toFixed(2)}) — the target is closer to a texture than to a pitch`
      : `too much broadband content (${candidate.noiseRatio.toFixed(2)} vs ${target.noiseRatio.toFixed(2)}) — the target has a clearer pitch than this render`,
  );

  const envelopeShape = shapeNote(candidate, target);
  if (envelopeShape !== undefined) add(parts.envelope, envelopeShape);

  const levelDelta = candidate.loudnessLufsApprox - target.loudnessLufsApprox;
  if (Number.isFinite(levelDelta)) {
    const layer = loudestLayer(ast);
    add(
      parts.loudness,
      `${Math.abs(levelDelta).toFixed(1)} dB ${levelDelta < 0 ? 'quieter' : 'louder'} than the target — adjust gain${layer === undefined ? '' : ` in layer '${layer}'`}`,
    );
  }

  return directives.sort((a, b) => b.weight - a.weight).map((directive) => directive.text);
}

/**
 * Where in its own span the candidate's energy sits, compared with the target.
 *
 * Both envelopes are already peak-normalized and span-relative, so their
 * difference is purely shape. Front-loaded against back-loaded is the
 * distinction worth reporting: it is the difference between a hit and a swell,
 * and it is invisible in duration and attack, which can both match exactly.
 */
function shapeNote(candidate: SoundProfile, target: SoundProfile): string | undefined {
  const half = Math.floor(candidate.rmsEnvelope.length / 2);
  if (half === 0) return undefined;
  const tail = (profile: SoundProfile): number =>
    mean(profile.rmsEnvelope.slice(half)) / Math.max(mean(profile.rmsEnvelope.slice(0, half)), 1e-6);
  const candidateTail = tail(candidate);
  const targetTail = tail(target);
  if (Math.abs(Math.log2(Math.max(candidateTail, 1e-3) / Math.max(targetTail, 1e-3))) < 0.5) return undefined;
  return candidateTail > targetTail
    ? 'energy sits too late in the sound — make the decay steeper, or use `curve exp` if it is linear'
    : 'energy sits too early in the sound — the target sustains longer after its peak; raise hold or flatten the decay';
}

/** The diff as a numbered block, ready to paste into a prompt. */
export function diffMarkdown(directives: readonly string[]): string {
  if (directives.length === 0) return 'No significant differences.';
  return directives.map((text, index) => `${index + 1}. ${text}`).join('\n');
}
