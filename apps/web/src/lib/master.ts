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
 * ## The jog
 *
 * The slider has no absolute position to show, because after the gesture the text
 * *is* the state: a user can edit the recipe by hand between two drags, and a
 * knob still holding "×2 of a frozen base" would then be lying. So it is a jog —
 * grab it, the current text becomes the base, every move applies one
 * multiplication to that base, and letting go returns the control to centre. The
 * error of `roundLiteral` therefore never compounds inside a gesture: it is
 * always `round(base × ratio)`, not a chain of rounded deltas.
 *
 * @packageDocumentation
 */

import { SoundlineError, scaleBrightness, scaleKind, type ScaleResult } from '@txt2sfx/core';

/** Which master a slider drives. */
export type MasterKind = 'pitch' | 'length' | 'brightness';

/** The masters in the order the panel lists them. */
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
