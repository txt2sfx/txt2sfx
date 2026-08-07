/**
 * `plate <freq> [modes] [stretch] [slope] [decay] [tilt]` — a dense bank of stretched modes.
 *
 * The gap this fills was measured, not imagined. Fitting a recipe to a diffusion
 * render of "steel on steel" stalls at a distance of about 0.25 with the rest of
 * the primitive set, and the residual is always the same two numbers: the render
 * dies at ~740 ms where the reference holds 1002, and its crest factor is ~26 dB
 * where the reference measures 15. Neither is a value the optimizer can reach.
 *
 * - `modal` cannot hold a long ring at a high pitch: `tau = Q / (pi * f)`, so at
 *   3.6 kHz the ceiling of `Q 400` is `tau` 35 ms, and the layer envelope
 *   multiplies with that rather than extending it. Here the decay is written in
 *   milliseconds and means the same thing at any pitch.
 * - `grains` is dense but broadband — it lifts spectral flatness by an order of
 *   magnitude past a metal reference, which measures 0.06.
 * - `pluck` rings long and is tonal, but it is one harmonic comb: adding modes is
 *   the only way to raise the average level without raising the peak.
 *
 * So: many partials, `1/k` amplitudes, seeded phases, and a per-mode decay that
 * starts from a time rather than from a resonance. `stretch` decides the material
 * far more than the spectrum's tilt does — the ear reads inharmonicity as "what
 * this object is made of" — and `tilt` is why real metal loses its edge before it
 * loses its body.
 *
 * @packageDocumentation
 */

import { numberOf, voiceSeconds } from './args.js';
import { primitiveSignature } from './signature.js';
import type { PrimitiveDef } from './types.js';

const signature = primitiveSignature('plate');

/** Struck plates, bars, bells, tanks: anything metal that rings on. */
export const plate: PrimitiveDef = {
  signature,
  build(args, ctx) {
    const freq = numberOf(args, signature, 'freq');
    const modes = numberOf(args, signature, 'modes');
    const stretch = numberOf(args, signature, 'stretch');
    const slope = numberOf(args, signature, 'slope');
    const decayMs = numberOf(args, signature, 'decay');
    const tilt = numberOf(args, signature, 'tilt');

    /* `decay` is a t60, so at that moment the lowest mode is 60 dB down and every
       other mode is further: generating past it buys inaudible samples, and the
       buffer is the expensive part of this primitive. */
    const decay = decayMs / 1000;
    const sec = Math.min(voiceSeconds(ctx), decay + 0.01);
    const buffer = ctx.ir.buffer({ kind: 'plate', freq, modes, stretch, slope, decay, tilt, seed: ctx.seed, sec });
    return ctx.ir.player(buffer, false, ctx.start, ctx.stop);
  },
};
