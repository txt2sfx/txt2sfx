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

import { DRUM, LANES, knobsFor, midiToHz, stepSeconds, type LoopNote, type LoopTrack } from './loop.js';

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
  /** The track's drive knob, 0 … 1. Saturates the voices that can take it. */
  readonly drive: number;
}

/** The context a track implies. One place, so a new dimension is one edit and not four. */
export function voiceContext(track: LoopTrack): VoiceContext {
  const knobs = knobsFor(track.prompt);
  return { stepSeconds: stepSeconds(track), brightness: knobs.brightness, drive: knobs.drive };
}

/** Filter cutoff for a note, shifted by the prompt's brightness. */
function cutoff(base: number, context: VoiceContext, low = 120, high = 16000): string {
  return hz(base * Math.pow(2, context.brightness), low, high);
}

/**
 * The saturation settings for an amount of drive, and the gain they smuggle in with them.
 *
 * ## The envelope is upstream of the chain, and that decides everything here
 *
 * `compile/compile.ts` wires a layer as **source → envelope → chain**, even though a soundline
 * reads `source >> chain | envelope`. So a `dist` in the chain does not see a full-scale
 * oscillator: it sees the *enveloped* signal, at whatever level the note's velocity and the
 * lane's balance left it. And `tanh(kx)/tanh(k)` has slope `k/tanh(k)` at zero, so a quiet
 * input comes out that much *louder* — a shaper here is a saturator and a makeup amplifier at
 * once.
 *
 * Two consequences, both measured the hard way:
 *
 * - **`drive 9` erases dynamics.** At that setting the makeup is ×9: a note at velocity 0.35
 *   and a note at 0.9 both come out near full scale, so velocity, `LaneSpec.level` and the
 *   whole balance stop meaning anything, and every voice becomes a wall. A bass written at
 *   `gain 0.21` measured a peak of 0.911 — 4.3× its own gain.
 * - **The makeup has to be divided back out**, which is what {@link trim} does with the number
 *   returned here rather than with a fudge factor. What is left is the part that is actually
 *   saturation: loud parts compressed and thick with harmonics, quiet parts nearly untouched —
 *   which is how an overdriven amplifier behaves, and it keeps velocity meaning something.
 *
 * So the range is 1…3.5, not 1…9. The signature's doc calls 10 "aggressive clipping"; in a
 * chain downstream of an envelope, 3.5 already is.
 */
function shaper(amount: number): { readonly k: number; readonly mix: number; readonly makeup: number } {
  const k = 1 + amount * 2.5;
  const mix = 0.3 + amount * 0.4;
  return { k, mix, makeup: 1 - mix + (mix * k) / Math.tanh(k) };
}

/** Divides out the makeup gain {@link drive} brings with it. Always paired, same `scale`. */
function trim(context: VoiceContext, scale = 1): number {
  const amount = context.drive * scale;
  return amount < 0.05 ? 1 : 1 / shaper(amount).makeup;
}

/**
 * The saturation stage, or nothing at all.
 *
 * Placed **before** the filter in every template that has one — distort, then tone-shape, the
 * way an amplifier does. After the filter it would work as a limiter instead: the filter's own
 * overshoot arrives at the curve's flat end, gets squashed, and the makeup division then leaves
 * the whole note quiet. Before it, peak and velocity come out where they went in.
 *
 * Returned as a fragment to splice into a chain rather than applied by a wrapper, because a
 * voice is text and the text is the cache key: a clean recipe and a driven one have to be two
 * different strings, or the cache would hand a clean render to a driven track.
 *
 * `scale` is how much of the track's drive this instrument takes. A bass can wear all of it;
 * a plucked string is a resonating delay line and turns to noise long before that.
 */
function drive(context: VoiceContext, scale = 1): string {
  const amount = context.drive * scale;
  if (amount < 0.05) return '';
  /* `drive` is named rather than positional — the parser says so in one sentence, which is
     the whole argument for the grammar being a table. */
  const { k, mix } = shaper(amount);
  return ` >> dist drive ${n(k, 2)} mix ${n(mix)}`;
}

/** How long this note sounds, in milliseconds. */
export function voiceMs(note: LoopNote, context: VoiceContext, tail = 1.25): number {
  const held = note.length * context.stepSeconds * 1000 * tail;
  return Math.round(Math.max(MIN_VOICE_MS, Math.min(MAX_VOICE_MS, held)));
}

/**
 * The envelope of an instrument that **sustains** rather than decays.
 *
 * An organ, a brass section and a choir are all driven for as long as the note lasts: air or
 * current keeps arriving, so the level is flat and the interesting numbers are the two ends.
 * Every template in this file used to write `decay <the whole note>`, which is a struck
 * string — the shape of a piano — and a held chord voiced that way is audibly falling away
 * under the arrangement from the moment it arrives. `hold` is the parameter that says
 * otherwise, and the three sustaining families here are the reason it earns its place.
 *
 * `release` is the fraction of the note spent letting go: a quarter, which at 500 ms is the
 * 125 ms it takes a hand to leave a key. The three add up to the declared duration exactly,
 * so the `duration.contract` invariant has nothing to forgive.
 */
function held(ms: number, attack: number, release = 0.25): string {
  const decay = Math.max(1, Math.round(ms * release));
  const hold = Math.max(0, Math.min(3000, ms - decay - attack));
  return `attack ${String(attack)}ms hold ${String(hold)}ms decay ${String(decay)}ms`;
}

/**
 * How long a held voice takes to arrive, capped by the brief.
 *
 * Shared by the bed and by every sustaining family, because the mistake is shared: a flat
 * percentage of the note is a second of fade-in on a two-bar chord, which is the defining
 * sound of ambience and used to arrive under marches too. The cap closes as the brief gets
 * more aggressive — a still one keeps its swell, a driven one gets an attack in tens of
 * milliseconds, which is marcato.
 */
function swell(ms: number, context: VoiceContext, share = 0.28): number {
  return Math.max(4, Math.round(Math.min(ms * share, 700 - context.drive * 640)));
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
    /* The kick takes the drive, at half strength: a saturated sub is the difference between
       a march and a metronome, and it is the one place in the kit where distortion reads as
       *weight* rather than as dirt.
       The snare does not, and that is a measurement rather than taste — its crack is white
       noise, which is already peaky and flat, so a shaper only makes it louder and flatter.
       It clipped on its own at half drive (`0.38` gain, peak past 1.0) while adding nothing
       an ear would call aggression. */
    case DRUM.kick:
      return [
        `sound "kick" 260ms`,
        `  body: sub 92Hz -> 44Hz in 80ms${drive(context, 0.5)} | gain ${n(note.gain * 0.88 * trim(context, 0.5))} decay 210ms`,
        `  snap: click 3ms | gain ${n(note.gain * 0.22)} decay 16ms`,
      ].join('\n');
    case DRUM.snare:
      return [
        `sound "snare" 240ms`,
        `  crack: noise white >> hp ${cutoff(1500, context, 400, 6000)} | gain ${n(note.gain * 0.68)} decay 130ms`,
        `  body: tone tri 190Hz | gain ${n(note.gain * 0.26)} decay 85ms`,
      ].join('\n');
    /* A tom is a pitched membrane: a short falling sub for the head, a filtered noise burst
       for the stick. The kit's only voice between the kick and the snare, and the one that
       makes a march sound like drums rather than like a click track. */
    case DRUM.tom:
      return [
        `sound "tom" 320ms`,
        `  head: sub 150Hz -> 88Hz in 120ms${drive(context, 0.4)} | gain ${n(note.gain * 0.8 * trim(context, 0.4))} decay 280ms`,
        `  stick: noise white >> bp ${cutoff(2200, context, 600, 8000)} Q2 | gain ${n(note.gain * 0.16)} decay 28ms`,
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

/**
 * The bass: a saturated saw over a sine an octave below it.
 *
 * ## Why there are two layers
 *
 * A single filtered saw is *the* reason a heavy arrangement came out sounding like a toy. Its
 * fundamental is where the note is, and a low-pass at seven times that leaves a buzzy,
 * mid-heavy stack of harmonics with almost nothing under 80 Hz — so the whole mix had exactly
 * one voice with any bottom in it, the kick, for 200 ms at a time. The sub layer is a plain
 * sine an octave down: no harmonics to muddy the mid, nothing to distort, just the weight the
 * saw does not have. It is the difference between "distorted" and "heavy".
 *
 * The saw takes the track's drive in full, shaped *after* the filter for the reason
 * {@link trim} gives. The sub never is: saturating a sine is how a sub becomes a buzz.
 */
function bass(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1.1);
  const freq = midiToHz(note.midi);
  /**
   * Where the sub layer sits: an octave down when there is room, on the fundamental when
   * there is not.
   *
   * A register shift can put this lane at G1, and an octave below that is 24 Hz — energy the
   * mixdown pays for in headroom and almost nobody can hear. Below 38 Hz the layer reinforces
   * the fundamental instead, which is the same intent (weight the saw does not have) spent
   * where a speaker can deliver it.
   */
  const sub = freq / 2 < 38 ? freq : freq / 2;
  return [
    `sound "bass" ${String(ms)}ms`,
    /* 0.58 and 0.38 rather than the single layer's old 0.85: two layers sum, the saw's own
       post-filter peak is about 1.5× its gain, and a voice that clips on its own clips in the
       mix. Measured — the pair lands at 0.95 worst case, and the bass is *quieter* on paper
       while carrying far more weight, which is the whole trade. */
    `  body: tone saw ${hz(freq, 20, 4000)}${drive(context)} >> lp ${cutoff(freq * 7, context, 120, 6000)} | gain ${n(note.gain * 0.58 * trim(context))} attack 4ms decay ${String(ms)}ms`,
    `  sub: tone sine ${hz(sub, 30, 2000)} | gain ${n(note.gain * 0.38)} attack 6ms decay ${String(ms)}ms`,
  ].join('\n');
}

/**
 * The heavy chord lane: two saws an octave apart, driven together.
 *
 * The `lead` template used to play this lane, which meant the loudest chords in an aggressive
 * arrangement were a single thin saw at 260–520 Hz — a chiptune, whatever the notes were. Two
 * saws an octave apart through one shaper is the power chord: the octave doubling is what makes
 * it read as *weight* rather than as a note, and shaping the pair together (rather than each
 * alone) is what glues them into one instrument.
 *
 * Driven at 0.9 of the track's drive even when the brief is calm — a chord lane called `stabs`
 * is asking for teeth. A minimum of its own, so it never arrives as a polite pad.
 */
function power(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1.05);
  const freq = midiToHz(note.midi);
  const hot: VoiceContext = { ...context, drive: Math.max(0.35, context.drive) };
  return [
    `sound "power" ${String(ms)}ms`,
    `  low: tone saw ${hz(freq / 2, 20, 4000)}${drive(hot, 0.9)} >> lp ${cutoff(freq * 4, context, 200, 9000)} | gain ${n(note.gain * 0.6 * trim(hot, 0.9))} attack 5ms decay ${String(ms)}ms`,
    `  high: tone saw ${hz(freq, 20, 6000)}${drive(hot, 0.9)} >> lp ${cutoff(freq * 5, context, 200, 12000)} | gain ${n(note.gain * 0.42 * trim(hot, 0.9))} attack 5ms decay ${String(ms)}ms`,
  ].join('\n');
}

/**
 * The distorted electric guitar.
 *
 * ## The cabinet is the instrument
 *
 * A saw through a waveshaper is a buzzer, and more drive does not make it a guitar — what
 * makes a guitar sound like a guitar is what happens *after* the distortion. A 4×12 speaker
 * is a mechanical low-pass: nothing useful above about 5 kHz, and a roll-off under 80 Hz. All
 * the fizz a shaper generates above the eighth harmonic — the part an ear reads as "cheap
 * synth distortion" — never leaves the box. So `lp` **after** `dist` is the box, and it is the
 * load-bearing line in this template rather than a tone preference.
 *
 * Before the shaper is the pickup: an inductive low-pass with a resonant peak around 2.7 kHz,
 * which is where a guitar's bite actually comes from. Hence `Q1.6` and not a flat filter.
 *
 * The cabinet's own numbers are absolute and not multiples of the note, unlike every other
 * filter in this file. That is the point: a speaker does not know what is being played through
 * it, which is precisely why a low chord and a high one come out of it sounding like one
 * instrument. The high-pass gives way for a note whose fundamental is under it — below E2 a
 * player reaches for a bigger cabinet, and eating the fundamental would be worse than the mud.
 *
 * ## Why two layers rather than an octave pair
 *
 * {@link power} doubles the note an octave down because it has to *invent* weight out of one
 * pitch. A guitar lane never needs to: the chord generator hands it a shell voicing — root,
 * fifth, octave — which is a power chord already. What the two layers add is what a producer
 * adds instead, a second take a few cents off. Seven cents of detune and a slightly later
 * pick, and the beating between them is the whole sound of a double-tracked rhythm guitar.
 *
 * Driven at a floor of 0.45 whatever the brief says. A clean electric is a different
 * instrument; a lane called `guitar` in this table is asking for an amplifier.
 */
function guitar(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 0.95);
  const freq = midiToHz(note.midi);
  const hot: VoiceContext = { ...context, drive: Math.max(0.45, context.drive) };
  const pickup = cutoff(2700, context, 700, 6000);
  const cab = `>> lp ${cutoff(3600, context, 1200, 8000)} >> hp ${hz(Math.min(95, freq * 0.75), 20, 400)}`;
  /**
   * 0.34 and 0.28, and the numbers are far below what the written gain suggests for a reason
   * worth recording: this chain amplifies about **ten times** more than `trim` accounts for.
   *
   * `trim` divides out the shaper's makeup gain at *unity* input. It cannot know about the
   * resonant pickup filter in front of it, and a sawtooth through a Q1.6 low-pass overshoots
   * badly — the discontinuity every 9 ms rings the resonance — so the shaper sees roughly twice
   * the amplitude the envelope set, and being compressive it does not pass that overshoot on
   * proportionally. Then two layers four cents apart sum almost coherently, because they beat
   * with a period of two and a half seconds and no note here is that long.
   *
   * At 0.5 and 0.42 the pair measured a peak of **1.118** on a written gain of 0.11. Nothing
   * downstream normalizes a voice, so that clips in the mix. These are the same numbers scaled
   * to land at 0.76 — measured, not derived, which is the honest way to size a chain whose
   * gain no closed form predicts.
   */
  const string = (name: string, detune: number, level: number, attack: number): string =>
    `  ${name}: tone saw ${hz(freq * detune, 20, 6000)} >> lp ${pickup} Q1.6${drive(hot)} ${cab} | gain ${n(note.gain * level * trim(hot))} attack ${String(attack)}ms decay ${String(ms)}ms`;
  return [
    `sound "guitar" ${String(ms)}ms`,
    string('l', 1, 0.34, 3),
    string('r', 1.004, 0.28, 6),
    /* The pick. Fourteen milliseconds of filtered noise at a tenth of the level: not audible
       as a sound of its own, and the difference between a note that *starts* and a note that
       is simply there. Every physical string is struck by something. */
    `  pick: noise white >> bp ${cutoff(2400, context, 800, 9000)} Q3 | gain ${n(note.gain * 0.12)} attack 0ms decay 14ms`,
  ].join('\n');
}

/**
 * The drawbar organ.
 *
 * The one instrument in this table that is not an imitation. A Hammond generates a note by
 * summing sine waves off geared tone wheels, which is exactly what this is: no filter, no
 * saturation shaping the timbre, just partials at fixed ratios of the fundamental. The
 * "realism" here costs nothing because it is the same physics.
 *
 * The registration is the classic one — 16′, 8′, 5⅓′, 4′, the drawbars a rock organist pulls
 * — and the 5⅓′ at **1.5×** the fundamental is what makes it read as an organ rather than as
 * a stack of octaves. That third-harmonic drawbar is the Hammond signature; a chord voiced
 * without it is a church organ at best and a sine pad at worst.
 *
 * Brightness moves the *upper drawbars* rather than a cutoff, because that is the control the
 * instrument actually has. An organist gets brighter by pulling 4′ and 2⅔′ out, and there is
 * no filter on the console to move.
 *
 * The key click is not ornament: a Hammond's busbar contacts arrive before the tone does, and
 * that 10 ms tick is most of how an ear identifies the instrument in one note.
 *
 * ## The honest limit
 *
 * The drive lands on the 8′ layer alone. A soundline layer is `source → envelope → chain`
 * summed at the *end*, so there is no bus to saturate: shaping four partials separately is
 * four saturators, not one overdriven amplifier, and the intermodulation that makes a driven
 * organ growl cannot happen here. One layer taking it is the closest this DSL reaches, and
 * that is a property of the format rather than a number to tune.
 */
function organ(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1);
  const freq = midiToHz(note.midi);
  const envelope = held(ms, 8, 0.18);
  /* Upper drawbars in or out, ±40% around the middle position. */
  const upper = 1 + context.brightness * 0.4;
  const bar = (name: string, ratio: number, level: number, saturate: boolean): string =>
    `  ${name}: tone sine ${hz(freq * ratio, 20, 12000)}${saturate ? drive(context, 0.7) : ''} | gain ${n(note.gain * level * (saturate ? trim(context, 0.7) : 1))} ${envelope}`;
  return [
    `sound "organ" ${String(ms)}ms`,
    bar('d16', 0.5, 0.3, false),
    bar('d8', 1, 0.46, true),
    bar('d5', 1.5, 0.2 * upper, false),
    bar('d4', 2, 0.24 * upper, false),
    `  key: click 2ms >> hp ${cutoff(1800, context, 500, 9000)} | gain ${n(note.gain * 0.14)} attack 0ms decay 10ms`,
  ].join('\n');
}

/**
 * The brass section.
 *
 * Two things make brass brass, and neither is the waveform. The first is that **it takes time
 * to speak**: a player has to move air, so the note arrives over 30–50 ms rather than
 * instantly, and a saw with a 3 ms attack is a synth lead whatever else is done to it. The
 * second is that it gets *brighter as it arrives* — the bell's harmonics build after the
 * fundamental — and there is no filter envelope in this DSL to do that with.
 *
 * So the brightness sweep is written as **two layers with different attacks**: a dull core
 * that speaks first and a bright layer that opens three times slower over the top of it. The
 * sum gets brighter over the first hundred milliseconds, which is the same audible event, and
 * it costs one layer instead of an envelope generator the format does not have.
 *
 * `Q1.8` on the core's low-pass is the bell resonance — a real one peaks around 1 kHz — and a
 * resonant cutoff is the cheapest way to have a formant at all. The detune is a *section*: two
 * players are never in perfect tune and that beating is the difference between a section and
 * one synthesized horn.
 */
function brass(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1);
  const freq = midiToHz(note.midi);
  /* 35 ms at rest, closing towards 12 as the brief gets aggressive: a marcato section attacks
     harder than a legato one, and the same knob decides everywhere in this file. */
  const attack = Math.max(12, Math.round(35 - context.drive * 23));
  /* The bell's resonance is a property of the horn, not of the note: a trombone's peak sits
     near 700 Hz whichever pitch is being played, which is why a section playing an octave apart
     still sounds like one section. So the cutoffs have a floor, and only rise with the note once
     the note has climbed past them — a multiple alone left a low brass note with four audible
     harmonics, which is a muted synth pad and not a horn. */
  const body = Math.max(freq * 3, 800);
  return [
    `sound "brass" ${String(ms)}ms`,
    `  core: tone saw ${hz(freq, 20, 6000)}${drive(context, 0.5)} >> lp ${cutoff(body, context, 300, 9000)} Q1.8 | gain ${n(note.gain * 0.5 * trim(context, 0.5))} ${held(ms, attack)}`,
    `  bell: tone saw ${hz(freq * 1.003, 20, 6000)} >> lp ${cutoff(Math.max(freq * 7, 2400), context, 400, 14000)} Q1.2 | gain ${n(note.gain * 0.26)} ${held(ms, Math.min(220, attack * 3))}`,
  ].join('\n');
}

/**
 * The electric piano.
 *
 * A Rhodes is a hammer hitting a steel tine beside a pickup, and the sound is two things at
 * once: a sharp inharmonic "bark" from the strike that dies in a tenth of a second, and a
 * near-sine tone from the tine that rings on. `fm` with the index **ramped down** is exactly
 * that decomposition — it is how the DX7 got its famous electric piano out of one operator
 * pair, and the ramp is the part that matters. A fixed index is a bell for the whole note.
 *
 * The ratio is chosen so the bark lands in a **fixed frequency band** rather than at a fixed
 * multiple of the note. That is not a convenience: the tine is a struck bar whose overtone
 * sits where its geometry puts it, roughly the same region across the keyboard, so a constant
 * ratio would put a low note's bark at 900 Hz and a high note's in the ultrasound.
 *
 * The sine layer under it is the pickup's fundamental. Without it the voice is all attack and
 * no note, which is what an `fm` pair alone sounds like at low index.
 */
function epiano(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1.4);
  const freq = midiToHz(note.midi);
  /* The bark at ~5.5 kHz, clamped to what the signature and the ear both allow. */
  const ratio = Math.max(3, Math.min(16, 5500 / freq));
  /* The strike dies in a fixed time, not a fraction of the note: a whole note and a
     sixteenth are struck by the same hammer. */
  const bark = Math.min(Math.round(ms * 0.5), 140);
  const index = 3.4 + context.brightness * 1.6;
  return [
    `sound "epiano" ${String(ms)}ms`,
    `  tine: fm ${hz(freq, 20, 4000)} ratio ${n(ratio)} index ${n(index)} -> 0.4 in ${String(bark)}ms | gain ${n(note.gain * 0.5)} attack 2ms decay ${String(ms)}ms`,
    `  body: tone sine ${hz(freq, 20, 6000)} | gain ${n(note.gain * 0.34)} attack 4ms decay ${String(ms)}ms`,
  ].join('\n');
}

/**
 * The choir, by formants.
 *
 * Two detuned saws through a low-pass is a *pad*. It was also what the `choir` lane played,
 * which is why asking for voices got a synthesizer with a slow attack: a vowel is not a
 * filter setting, it is **two resonances at fixed frequencies** — the mouth cavity and the
 * one behind the tongue — and moving the note does not move them. That is the whole of
 * formant synthesis and it is the reason this reads as a voice at all.
 *
 * The vowel comes from the brief, through the same brightness knob everything else uses: dark
 * is an /u/ (320 and 800 Hz), bright is an /a/ (730 and 1150). The layer is *named* after the
 * vowel it is singing, so the recipe says which one — the point of voices being text.
 *
 * Breath is the third layer. A little filtered pink noise under a sung note is the difference
 * between a choir and an organ playing the same chord; a real one is dozens of people
 * exhaling.
 */
function voice(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1);
  const freq = midiToHz(note.midi);
  const attack = swell(ms, context, 0.22);
  /* /u/ → /o/ → /a/ as the brief brightens. Two numbers per vowel, from the standard
     formant table; interpolated rather than switched so a mid brief is not either. */
  const open = (context.brightness + 1) / 2;
  const vowel = open < 0.34 ? 'oo' : open < 0.67 ? 'oh' : 'ah';
  const f1 = 320 + open * 410;
  const f2 = 800 + open * 350;
  /* 0.9 and 0.62 against the bed's 0.6 and 0.5, because a band-pass throws away most of a
     sawtooth: a formant at 525 Hz over a 110 Hz note passes the fifth harmonic and rejects the
     fundamental that carries the energy. Measured, the pair came out 3.2× quieter than the pad
     it replaced — the loss is part of the instrument, so the compensation belongs in the
     template beside it rather than in the lane's mix level. */
  return [
    `sound "choir" ${String(ms)}ms`,
    `  ${vowel}: tone saw ${hz(freq, 20, 4000)} >> bp ${hz(f1, 200, 1400)} Q3.5 | gain ${n(note.gain * 0.9)} ${held(ms, attack)}`,
    `  ring: tone saw ${hz(freq * 1.004, 20, 4000)} >> bp ${hz(f2, 400, 2600)} Q5 | gain ${n(note.gain * 0.62)} ${held(ms, Math.round(attack * 1.3))}`,
    `  breath: noise pink >> bp ${cutoff(2400, context, 700, 9000)} Q1 | gain ${n(note.gain * 0.13)} ${held(ms, Math.round(attack * 1.6))}`,
  ].join('\n');
}

function pluck(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1.6);
  /* `pluck` tunes a delay line, so its floor is a real one: below 40 Hz there is no
     line to tune. Notes that low belong to the bass lane and never reach here. */
  return [
    `sound "pluck" ${String(ms)}ms`,
    /* A third of the drive. A plucked string is a resonating delay line; shape it hard and
       the pitch stops being audible before the aggression arrives. */
    `  string: pluck ${hz(midiToHz(note.midi), 40, 8000)} damp ${n(0.45 - context.brightness * 0.2)} bright ${n(0.55 + context.brightness * 0.25)}${drive(context, 0.34)} | gain ${n(note.gain * 0.85 * trim(context, 0.34))} decay ${String(ms)}ms`,
  ].join('\n');
}

function bell(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 2.2);
  return [
    `sound "bell" ${String(ms)}ms`,
    `  ring: fm ${hz(midiToHz(note.midi), 20, 8000)} ratio 3.5 index ${n(3.5 + context.brightness * 2)} | gain ${n(note.gain * 0.75)} decay ${String(ms)}ms`,
  ].join('\n');
}

/**
 * The melody voice.
 *
 * A saw, not a square. A square filtered four octaves up is a chip-tune lead: bright,
 * nasal and cheerful whatever the notes under it are — which was half of the reason every
 * take of this screen sounded like the same happy game, and a wave nobody chose is not a
 * mood anybody declared. A saw with the filter an octave lower keeps the cutting edge a
 * lead needs and leaves the brightness where the brief can reach it.
 */
function lead(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1.15);
  const freq = midiToHz(note.midi);
  return [
    `sound "lead" ${String(ms)}ms`,
    `  body: tone saw ${hz(freq, 20, 8000)}${drive(context, 0.8)} >> lp ${cutoff(freq * 3, context, 300, 16000)} | gain ${n(note.gain * 0.72 * trim(context, 0.8))} attack 8ms decay ${String(ms)}ms`,
  ].join('\n');
}

/**
 * The bed: pads, strings, choir, drone.
 *
 * ## Why the attack is capped, and by the brief
 *
 * It used to be a flat 28% of the note. On a two-bar chord that is a second of fade-in — the
 * defining sound of ambience — and it arrived under *every* arrangement, including marches,
 * because the number knew nothing about what was being written. A held chord that takes a
 * second to appear cannot be a string section stabbing on the beat, so a request for
 * something militant with `strings` in it came back as space music with a drum track. The
 * cap now closes as the brief gets more aggressive: a still one keeps its swell, a driven one
 * gets an attack in tens of milliseconds, which is marcato.
 */
function pad(note: LoopNote, context: VoiceContext): string {
  const ms = voiceMs(note, context, 1);
  const freq = midiToHz(note.midi);
  const attack = swell(ms, context);
  /* Two saws a few cents apart is the whole trick behind a pad — one of them alone is
     a buzzer, and the beating between them is what the ear reads as width. */
  return [
    `sound "pad" ${String(ms)}ms`,
    `  a: tone saw ${hz(freq, 20, 6000)}${drive(context, 0.4)} >> lp ${cutoff(freq * 5, context, 200, 12000)} | gain ${n(note.gain * 0.6 * trim(context, 0.4))} attack ${String(attack)}ms decay ${String(ms)}ms`,
    `  b: tone saw ${hz(freq * 1.006, 20, 6000)}${drive(context, 0.4)} >> lp ${cutoff(freq * 4, context, 200, 12000)} | gain ${n(note.gain * 0.5 * trim(context, 0.4))} attack ${String(Math.round(attack * 1.2))}ms decay ${String(ms)}ms`,
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
 * ## The one thing the drive knob changes about the balance
 *
 * The mid and high lanes step back as the brief gets heavier. This is not taste dressed up:
 * `mixLoop` scales the *whole* sum to fit the ceiling, so five dense mid-range lanes cost the
 * kick and the bass real level — a driven `hellmarch` measured a sum peak of 3.5 and lost
 * 11 dB, most of which came off the bottom, which is precisely how "heavy" turns into
 * "children's song". Taking the crowded register down instead is what leaves room in the sum
 * for the two lanes that carry weight, and it is the same decision a person makes with a
 * fader.
 *
 * An unknown lane returns the pluck template rather than throwing. A missing lane is a
 * table gap, and a soundtrack with one lane playing the wrong instrument is a bug you
 * can hear and fix; an exception in the middle of composing is a blank screen.
 */
export function voiceFor(laneName: string, note: LoopNote, context: VoiceContext): string {
  const spec = LANES[laneName];
  const family = spec?.family ?? 'pluck';
  /* Everything above the bass, and not percussive: chords, keys, arps, bells, leads, the bed,
     the air, and the three mid-register instruments that joined them. The kit, the bass, the
     power lane and the guitar keep their level whatever happens — a guitar that steps back
     when the brief turns heavy is backwards, it is the thing being asked for. */
  const crowded =
    family === 'pluck' ||
    family === 'bell' ||
    family === 'lead' ||
    family === 'pad' ||
    family === 'air' ||
    family === 'organ' ||
    family === 'brass' ||
    family === 'epiano' ||
    family === 'voice';
  const balance = crowded ? 1 - 0.3 * context.drive : 1;
  const mixed: LoopNote = {
    ...note,
    gain: Math.max(0.01, Math.min(1, note.gain * (spec?.level ?? 0.5) * balance)),
  };
  switch (family) {
    case 'kit':
      return kit(mixed, context);
    case 'bass':
      return bass(mixed, context);
    case 'bell':
      return bell(mixed, context);
    case 'lead':
      return lead(mixed, context);
    case 'power':
      return power(mixed, context);
    case 'guitar':
      return guitar(mixed, context);
    case 'organ':
      return organ(mixed, context);
    case 'brass':
      return brass(mixed, context);
    case 'epiano':
      return epiano(mixed, context);
    case 'voice':
      return voice(mixed, context);
    case 'pad':
      return pad(mixed, context);
    case 'air':
      return air(mixed, context);
    case 'pluck':
    default:
      return pluck(mixed, context);
  }
}
