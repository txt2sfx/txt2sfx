/**
 * The three knobs above the slots: pitch, length, brightness.
 *
 * A slot is a number the author marked as uncertain. These are the opposite —
 * they move *every* number of a kind at once, so the recipe keeps its shape and
 * only its register changes. That is the one edit a listener can ask for without
 * reading the grammar ("same sound, lower / shorter / darker"), which is why the
 * playground offers it without a model or a key.
 *
 * The transform itself lives in `@txt2sfx/core` — it is grammar-aware and belongs
 * next to the signature table. This module is only the mapping from a slider's
 * travel to a ratio, plus the decision of which transform each knob drives.
 *
 * ## The anchor
 *
 * These were jogs: grab one, the current text becomes the base, letting go
 * returns the control to centre. The argument was that between two gestures the
 * text is the state, so a knob holding "×2 of a frozen base" could be made to lie
 * by one hand edit. True, but the price was worse than the risk — a knob that
 * snaps back cannot be *undone*. Pull the pitch down, hear that it went too far,
 * and there is no way back to where the recipe started except by dragging up
 * until it sounds right again, which lands on different numbers every time.
 *
 * So a master is now anchored. {@link anchorMasters} freezes the recipe as it was
 * when it loaded; every move rebuilds the text from that base with *all three*
 * ratios applied ({@link moveMaster}), so the knobs read as absolute — centre is
 * always exactly the recipe as it arrived, and returning one there restores its
 * numbers to the character. Rounding still cannot compound, and for a stronger
 * reason than the jog had: the result is `round(base × ratio)` across the whole
 * session with the base, not merely inside one gesture.
 *
 * The lie the jog was avoiding is handled by dropping the anchor rather than by
 * dropping the position: an edit that did not come from a master — typing, a fit,
 * a variation, opening another recipe — leaves `source` different from
 * {@link MasterAnchor.source}, and the caller re-anchors on what it now has. This
 * is why the anchor carries the text it produced.
 *
 * ## Why a master at rest is skipped rather than applied at ratio 1
 *
 * `scaleBrightness(source, 1)` is not the identity: a layer with no filter gets
 * one inserted, at `OPEN_CUTOFF_HZ`. Composing all three unconditionally would
 * therefore edit the recipe the moment any *other* knob moved. A position exactly
 * at {@link MASTER_CENTER} is skipped, which is also what makes "put it back in
 * the middle" restore the base byte for byte.
 *
 * @packageDocumentation
 */

import { SoundlineError, scaleBrightness, scaleKind, type ScaleResult } from '@txt2sfx/core';

/** Which master a slider drives. */
export type MasterKind = 'pitch' | 'length' | 'brightness';

/**
 * The masters in the order the panel lists them — and the order they compose in.
 *
 * Load-bearing for the second reason as well as the first. Pitch and brightness
 * overlap (a `lp` cutoff is a `freq`, so the pitch master moves it too), and
 * brightness may *insert* a filter, so the two do not commute. Fixing one order
 * for every rebuild is what makes a pair of positions mean one recipe rather than
 * one recipe per sequence of drags that reached them.
 */
export const MASTER_KINDS: readonly MasterKind[] = ['pitch', 'length', 'brightness'];

/** Slider position at rest — the centre, where the ratio is exactly 1. */
export const MASTER_CENTER = 0.5;

/**
 * The widest ratio either end of the travel reaches.
 *
 * Four is two octaves of pitch, or a quarter to four times the length. Past that
 * a recipe stops being the same sound — a 4× pop is a thud, an 8× one is a
 * different design — and redesigning is work for the text, not for a slider.
 */
export const MASTER_RANGE = 4;

/**
 * Slider position (0..1) to a multiplier, logarithmically, centred on 1.
 *
 * The same curve as the slot sliders (`lib/slots.ts`) and for the same reason:
 * frequency and time are heard as ratios, so half the travel has to be "down by
 * the same factor" as the other half is "up".
 */
export function positionToRatio(position: number): number {
  const t = Math.min(1, Math.max(0, position));
  return Math.pow(MASTER_RANGE, 2 * t - 1);
}

/** A multiplier back to its slider position (0..1). */
export function ratioToPosition(ratio: number): number {
  if (!(ratio > 0)) return MASTER_CENTER;
  const t = (Math.log(ratio) / Math.log(MASTER_RANGE) + 1) / 2;
  return Math.min(1, Math.max(0, t));
}

/**
 * Apply one master to a recipe.
 *
 * A source that does not parse has no knobs rather than an exception: this is
 * called on every render to decide whether a slider is live, and the editor is
 * mid-keystroke half of that time. The error itself is already on screen — the
 * recipe card shows it — so swallowing it here hides nothing.
 */
export function applyMaster(source: string, kind: MasterKind, ratio: number): ScaleResult {
  try {
    switch (kind) {
      case 'pitch':
        return scaleKind(source, 'freq', ratio);
      case 'length':
        return scaleKind(source, 'time', ratio);
      case 'brightness':
        return scaleBrightness(source, ratio);
    }
  } catch (error) {
    if (error instanceof SoundlineError) return { source, touched: 0 };
    throw error;
  }
}

/** Where all three knobs are standing, 0..1 each. */
export type MasterPositions = Readonly<Record<MasterKind, number>>;

/** Every master in the middle: the recipe exactly as it was anchored. */
export const MASTER_REST: MasterPositions = {
  pitch: MASTER_CENTER,
  length: MASTER_CENTER,
  brightness: MASTER_CENTER,
};

/** Whether nothing is turned — the interface draws the readouts faint when so. */
export function atRest(positions: MasterPositions): boolean {
  return MASTER_KINDS.every((kind) => positions[kind] === MASTER_CENTER);
}

/**
 * A recipe, the knob positions measured against it, and what the two produce.
 *
 * `base` is never rewritten by a move — that is the whole point of anchoring —
 * and `source` is carried rather than recomputed so a caller can tell in one
 * comparison whether the text it holds is still the one these positions describe.
 */
export interface MasterAnchor {
  /** The recipe the positions are relative to, as it stood when anchored. */
  readonly base: string;
  readonly positions: MasterPositions;
  /** `base` with every off-centre master applied; the text the editor should show. */
  readonly source: string;
}

/** Take this text as the new zero, with all three knobs in the middle. */
export function anchorMasters(base: string): MasterAnchor {
  return { base, positions: MASTER_REST, source: base };
}

/**
 * Rebuild the recipe with one knob moved.
 *
 * From the base every time, never from the current text: applying a delta to an
 * already-scaled recipe would make the position mean "how far the last drag
 * went", which is the jog this replaced.
 */
export function moveMaster(anchor: MasterAnchor, kind: MasterKind, position: number): MasterAnchor {
  const positions: MasterPositions = { ...anchor.positions, [kind]: clampPosition(position) };
  let source = anchor.base;
  for (const each of MASTER_KINDS) {
    /* Skipped at rest, not applied at ratio 1 — see the header. */
    if (positions[each] === MASTER_CENTER) continue;
    source = applyMaster(source, each, positionToRatio(positions[each])).source;
  }
  return { base: anchor.base, positions, source };
}

/**
 * A position as the multiplier it stands for: `×1`, `×0.5`, `×2.83`.
 *
 * The jog deliberately showed no readout, because it had no absolute position to
 * report. An anchored knob does, and it is the number that answers "how far have
 * I taken this" — the one question the old control could not be asked.
 *
 * `toFixed(2)` always leaves a decimal point in the string, so stripping the
 * trailing zeros cannot eat a digit; the range is `[1/4..4]`, never a bare `10`.
 */
export function formatRatio(position: number): string {
  return `×${positionToRatio(position).toFixed(2).replace(/\.?0+$/, '')}`;
}

/** A slider can only report 0..1, but a stored position must be sane regardless. */
function clampPosition(position: number): number {
  return Number.isFinite(position) ? Math.min(1, Math.max(0, position)) : MASTER_CENTER;
}
