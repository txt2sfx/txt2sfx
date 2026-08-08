/**
 * One note of a loop, as a soundline recipe.
 *
 * This file is the join between NeurosLoop and the rest of the project. A lane does not
 * own a synthesizer: it owns a *family*, and a family is a template that turns
 * `(pitch, loudness, length, brightness)` into ordinary soundline text. Everything after
 * that — parse, compile to IR, render offline, emit JavaScript — is the machinery that
 * already exists, unchanged and unaware that a soundtrack is being made out of it.
 *
 * Two consequences are worth stating, because they are the reason the screen is built
 * this way at all:
 *
 * - **The soundtrack exports as code.** `codegen` takes each distinct voice to a
 *   self-contained arrow function, so a loop ships as a table of those plus a schedule.
 *   No sample data, no audio file. That is the same claim the rest of the playground
 *   makes, made about eight bars of music.
 * - **A voice is auditable.** Every note is a recipe someone can read, paste into the
 *   studio, and edit. There is no hidden instrument definition anywhere.
 *
 * ## Why velocity and length are baked in
 *
 * The text *is* the cache key and the export key. A note that differs only in loudness
 * has to be a different recipe, or the emitted module would need per-note gain plumbing
 * wrapped around generated code that connects itself to `ctx.destination`. Velocity is
 * quantized upstream (`VELOCITY_STEP`), so a sixteen-bar hat lane still collapses to
 * three or four distinct renders.
 *
 * ## No category, on purpose
 *
 * The headers here declare a duration and nothing else, which means `misc`. A category
 * is a promise to be judged against a set of physical invariants, and "a G#3 held for
 * two bars" is not a `pop`, an `impact` or a `cycle` — claiming one would make the
 * validator enforce the physics of a sound effect on a note of music. `misc` is the
 * honest answer and it is what the serializer omits anyway.
 *
 * @packageDocumentation
 */

import { DRUM, LANES, midiToHz, type LoopNote } from './loop.js';

/** Longest a single note may ring, whatever the grid says. */
const MAX_VOICE_MS = 4000;

/** Shortest, so a sixteenth at 160 bpm still has a body. */
const MIN_VOICE_MS = 60;

/** A number as a soundline literal: enough digits to be exact, none that are noise. */
function n(value: number, digits = 2): string {
  return String(Number(value.toFixed(digits)));
}

/** A frequency literal, clamped into the primitive's documented range. */
function hz(value: number, low: number, high: number): string {
  return `${n(Math.max(low, Math.min(high, value)), 1)}Hz`;
}

/** Everything a template needs beyond the note itself. */
export interface VoiceContext {
  /** Seconds per sixteenth, so a note's length in steps becomes milliseconds. */
  readonly stepSeconds: number;
  /** The track's brightness knob, −1 … +1. Moves every filter cutoff by an octave. */
  readonly brightness: number;
}

/** Filter cutoff for a note, shifted by the prompt's brightness. */
function cutoff(base: number, context: VoiceContext, low = 120, high = 16000): string {
  return hz(base * Math.pow(2, context.brightness), low, high);
}

/** How long this note sounds, in milliseconds. */
export function voiceMs(note: LoopNote, context: VoiceContext, tail = 1.25): number {
  const held = note.length * context.stepSeconds * 1000 * tail;
  return Math.round(Math.max(MIN_VOICE_MS, Math.min(MAX_VOICE_MS, held)));
}

/* ------------------------------------------------------------------------- *
 * The kit
 * ------------------------------------------------------------------------- */

/**
 * Percussion, by GM note number.
 *
 * The mapping is the General MIDI one — 36 kick, 38 snare, 42 closed hat — so the MIDI
 * export lands on the right pads in any DAW without a translation table. A note this
 * file does not recognise falls through to the tick, which is audible and obviously
 * wrong rather than silent and mysteriously missing.
 */
function kit(note: LoopNote, context: VoiceContext): string {
  const g = n(note.gain);
  switch (note.midi) {
    case DRUM.kick:
      return [
        `sound "kick" 260ms`,
        `  body: sub 92Hz -> 44Hz in 80ms | gain ${n(note.gain * 0.88)} decay 210ms`,
        `  snap: click 3ms | gain ${n(note.gain * 0.22)} decay 16ms`,
      ].join('\n');
    case DRUM.snare:
      return [
        `sound "snare" 240ms`,
        `  crack: noise white >> hp ${cutoff(1500, context, 400, 6000)} | gain ${n(note.gain * 0.68)} decay 130ms`,
        `  body: tone tri 190Hz | gain ${n(note.gain * 0.26)} decay 85ms`,
      ].join('\n');
    case DRUM.clap:
      return [
        `sound "clap" 260ms`,
        `  burst: noise white >> bp ${cutoff(1800, context, 500, 7000)} Q2 | gain ${g} decay 150ms`,
      ].join('\n');
    case DRUM.hatClosed:
      return [
        `sound "hat" 90ms`,
        `  ts: noise white >> hp ${cutoff(7000, context, 2000, 16000)} | gain ${n(note.gain * 0.85)} decay 42ms`,
      ].join('\n');
    case DRUM.hatOpen:
      return [
        `sound "hat-open" 340ms`,
        `  ts: noise white >> hp ${cutoff(6000, context, 2000, 16000)} | gain ${n(note.gain * 0.7)} decay 300ms`,
      ].join('\n');
    default:
      return [
        `sound "tick" 130ms`,
        `  knock: modal wood ${cutoff(900, context, 200, 5000)} Q60 | gain ${n(note.gain * 0.95)} decay 95ms`,
      ].join('\n');
  }
}

/* ------------------------------------------------------------------------- *
 * The pitched families
 * ------------------------------------------------------------------------- */

function bass(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1.1);
  const freq = midiToHz(note.midi);
  return [
    `sound "bass" ${String(ms)}ms`,
    `  body: tone saw ${hz(freq, 20, 4000)} >> lp ${cutoff(freq * 7, context, 120, 6000)} | gain ${n(note.gain * 0.85)} attack 4ms decay ${String(ms)}ms`,
  ].join('\n');
}

function pluck(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1.6);
  /* `pluck` tunes a delay line, so its floor is a real one: below 40 Hz there is no
     line to tune. Notes that low belong to the bass lane and never reach here. */
  return [
    `sound "pluck" ${String(ms)}ms`,
    `  string: pluck ${hz(midiToHz(note.midi), 40, 8000)} damp ${n(0.45 - context.brightness * 0.2)} bright ${n(0.55 + context.brightness * 0.25)} | gain ${n(note.gain * 0.85)} decay ${String(ms)}ms`,
  ].join('\n');
}

function bell(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 2.2);
  return [
    `sound "bell" ${String(ms)}ms`,
    `  ring: fm ${hz(midiToHz(note.midi), 20, 8000)} ratio 3.5 index ${n(3.5 + context.brightness * 2)} | gain ${n(note.gain * 0.75)} decay ${String(ms)}ms`,
  ].join('\n');
}

function lead(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1.15);
  const freq = midiToHz(note.midi);
  return [
    `sound "lead" ${String(ms)}ms`,
    `  body: tone square ${hz(freq, 20, 8000)} >> lp ${cutoff(freq * 4, context, 300, 16000)} | gain ${n(note.gain * 0.7)} attack 6ms decay ${String(ms)}ms`,
  ].join('\n');
}

function pad(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1);
  const freq = midiToHz(note.midi);
  /* Two saws a few cents apart is the whole trick behind a pad — one of them alone is
     a buzzer, and the beating between them is what the ear reads as width. */
  return [
    `sound "pad" ${String(ms)}ms`,
    `  a: tone saw ${hz(freq, 20, 6000)} >> lp ${cutoff(freq * 5, context, 200, 12000)} | gain ${n(note.gain * 0.6)} attack ${String(Math.round(ms * 0.28))}ms decay ${String(ms)}ms`,
    `  b: tone saw ${hz(freq * 1.006, 20, 6000)} >> lp ${cutoff(freq * 4, context, 200, 12000)} | gain ${n(note.gain * 0.5)} attack ${String(Math.round(ms * 0.34))}ms decay ${String(ms)}ms`,
  ].join('\n');
}

function air(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1);
  return [
    `sound "air" ${String(ms)}ms`,
    `  wash: noise pink >> bp ${cutoff(midiToHz(note.midi), context, 200, 12000)} Q1.5 | gain ${n(note.gain * 0.75)} attack ${String(Math.round(ms * 0.35))}ms decay ${String(ms)}ms`,
  ].join('\n');
}

/* ------------------------------------------------------------------------- *
 * The entry point
 * ------------------------------------------------------------------------- */

/**
 * The soundline for one note of one lane.
 *
 * Deterministic and pure: the same arguments always produce the same text, which is what
 * lets `lib/loop-render.ts` cache renders by the text itself and what lets the export
 * deduplicate voices without a second identity scheme.
 *
 * ## Where the balance between lanes is applied
 *
 * Here, once, from `LaneSpec.level` — and nowhere else. The note carries the *musical*
 * velocity, which is what the MIDI export writes and what a listener would call an
 * accent; the lane's level is a *mix* decision, which is why a shaker at full velocity
 * still sits under a kick at the same one. Keeping them apart is what stops a mix
 * adjustment from silently rewriting the exported MIDI.
 *
 * The multipliers inside each template stay where they are: those are ratios *within*
 * one voice — a kick's click against its body — and they are part of what the instrument
 * is, not of how loud it is in this arrangement.
 *
 * An unknown lane returns the pluck template rather than throwing. A missing lane is a
 * table gap, and a soundtrack with one lane playing the wrong instrument is a bug you
 * can hear and fix; an exception in the middle of composing is a blank screen.
 */
export function voiceFor(laneName: string, note: LoopNote, context: VoiceContext): string {
  const spec = LANES[laneName];
  const mixed: LoopNote = { ...note, gain: Math.max(0.01, Math.min(1, note.gain * (spec?.level ?? 0.5))) };
  switch (spec?.family ?? 'pluck') {
    case 'kit':
      return kit(mixed, context);
    case 'bass':
      return bass(mixed, context);
    case 'bell':
      return bell(mixed, context);
    case 'lead':
      return lead(mixed, context);
    case 'pad':
      return pad(mixed, context);
    case 'air':
      return air(mixed, context);
    case 'pluck':
    default:
      return pluck(mixed, context);
  }
}
