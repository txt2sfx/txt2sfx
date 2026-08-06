/**
 * Procedural sample tables: the noise, burst, modal, pluck and reverb buffers,
 * plus the waveshaper curve.
 *
 * ## Parity contract
 *
 * Every generator in this file exists **twice**: once as a TypeScript function
 * that fills a `Float32Array` (used by the live graph and the offline renderer)
 * and once as a JavaScript source string that does the same thing inside the
 * exported function. They must agree sample for sample, so the two versions sit
 * next to each other and are written with the same operations in the same order
 * — the float arithmetic is only reproducible if the expression trees match.
 *
 * `test/codegen.test.ts` renders both backends and demands bit-identical output;
 * any drift here shows up there immediately. When you change a generator, change
 * both halves in the same edit.
 *
 * ## Why seeded, not random
 *
 * `Math.random()` would make render snapshots, peak measurements and optimizer
 * fitness values drift between runs, which destroys the one property the whole
 * pipeline is built on: a soundline plus a seed is a sound, exactly.
 *
 * @packageDocumentation
 */

import type { IRBufferSpec, IRNoiseColor } from './ir.js';
import { num, numList } from './emit.js';

/* ------------------------------------------------------------------------- *
 * Deterministic noise source
 * ------------------------------------------------------------------------- */

/**
 * MINSTD (Lehmer) parameters: `s = s * 16807 mod (2^31 - 1)`.
 *
 * Chosen over the more usual 32-bit LCG for two reasons at once. It is *better* —
 * full period over its whole state, no weak low-order bits — and it is *shorter*
 * to export: `s*16807%2147483647` needs no `Math.imul`, because 2^31 * 16807 stays
 * under 2^53 and therefore stays exact in a double. Seventeen bytes saved in every
 * generator that draws random numbers, four of them.
 *
 * The state must never reach 0, which is why {@link normalizeSeed} exists.
 */
const LCG_MUL = 16807;
const LCG_MOD = 2147483647;

/**
 * Scale from the generator's `[1, 2^31-2]` state to roughly `(-1, 1)`.
 *
 * 2^30 rather than `LCG_MOD / 2`, so the result can never round *above* 1 — a
 * source that peaks at 1.0000000019 would quietly break the peak invariant.
 */
const LCG_SCALE = 1073741824;

/** Noise colour as the numeric tag the multi-colour generator branches on. */
const COLOR_TAG: Readonly<Record<IRNoiseColor, number>> = { white: 0, pink: 1, brown: 2 };

/** Number of samples a recipe produces at a given sample rate. */
export function bufferLength(spec: IRBufferSpec, sampleRate: number): number {
  return ((sampleRate * spec.sec) | 0) || 1;
}

/** Allocate the sample array for a recipe of `sec` seconds. */
function alloc(sec: number, sampleRate: number): Float32Array {
  return new Float32Array(((sampleRate * sec) | 0) || 1);
}

/* ------------------------------------------------------------------------- *
 * noise
 * ------------------------------------------------------------------------- */

/**
 * Broadband noise with a spectral tilt.
 *
 * Pink uses Paul Kellet's three-pole economy filter — about -3 dB/octave across
 * the audible band at a fraction of the cost of a proper Voss-McCartney bank.
 * Brown is a leaky integrator, which is -6 dB/octave by construction. Both are
 * scaled to sit near unit peak and then hard-clamped: every primitive in
 * txt2sfx promises a roughly unit-peak signal so that the `gain` a soundline
 * writes is the gain a listener gets, and so that the mix peak is predictable
 * from the layer gains alone.
 */
function fillNoise(color: IRNoiseColor, seed: number, sec: number, sampleRate: number): Float32Array {
  const a = alloc(sec, sampleRate);
  const k = COLOR_TAG[color];
  let s = seed;
  let p = 0;
  let q = 0;
  let r = 0;
  let l = 0;
  for (let i = 0; i < a.length; i++) {
    s = (s * LCG_MUL) % LCG_MOD;
    const x = s / LCG_SCALE - 1;
    let v = x;
    if (k === 1) {
      p = 0.99765 * p + x * 0.099046;
      q = 0.963 * q + x * 0.2965164;
      r = 0.57 * r + x * 1.0526913;
      v = (p + q + r + x * 0.1848) * 0.25;
    } else if (k === 2) {
      l = (l + 0.02 * x) / 1.02;
      v = l * 3.5;
    }
    a[i] = v < -1 ? -1 : v > 1 ? 1 : v;
  }
  return a;
}

const NOISE_STEP = 's=s*16807%2147483647;';
const NOISE_X = 'const x=s/1073741824-1;';
const NOISE_PINK = 'p=.99765*p+x*.099046;q=.963*q+x*.2965164;r=.57*r+x*1.0526913;';
const NOISE_PINK_V = '(p+q+r+x*.1848)*.25';
const NOISE_BROWN = 'l=(l+.02*x)/1.02;';
const NOISE_BROWN_V = 'l*3.5';
const NOISE_CLAMP = 'a[i]=v<-1?-1:v>1?1:v}return b}';

/**
 * Emit only the colours the sound actually uses.
 *
 * This is the single largest saving in the emitter. The three-colour generator is
 * about 300 bytes; a sound that only asks for white noise gets a 130-byte one and
 * ships no pink filter it never runs. A sound that mixes colours keeps the `k`
 * argument and the branches, but only the branches it needs.
 */
function emitNoise(colors: ReadonlySet<IRNoiseColor>): string {
  const multi = colors.size > 1;
  const state = ['s=d_'];
  if (colors.has('pink')) state.push('p=0', 'q=0', 'r=0');
  if (colors.has('brown')) state.push('l=0');
  const head =
    `Z=(s_,d_${multi ? ',k' : ''})=>{const b=A(s_),a=b.getChannelData(0);` +
    `let ${state.join(',')};for(let i=0;i<a.length;i++){${NOISE_STEP}`;

  if (!multi) {
    if (colors.has('white')) return `${head}a[i]=s/1073741824-1}return b}`;
    const body = colors.has('pink')
      ? `${NOISE_PINK}const v=${NOISE_PINK_V};`
      : `${NOISE_BROWN}const v=${NOISE_BROWN_V};`;
    return `${head}${NOISE_X}${body}${NOISE_CLAMP}`;
  }

  const branches: string[] = [];
  if (colors.has('pink')) branches.push(`if(k==1){${NOISE_PINK}v=${NOISE_PINK_V}}`);
  if (colors.has('brown')) {
    branches.push(`${branches.length > 0 ? 'else ' : ''}if(k==2){${NOISE_BROWN}v=${NOISE_BROWN_V}}`);
  }
  return `${head}${NOISE_X}let v=x;${branches.join('')}${NOISE_CLAMP}`;
}

/* ------------------------------------------------------------------------- *
 * burst — the `click` transient
 * ------------------------------------------------------------------------- */

/**
 * Short noise burst under an exponential window.
 *
 * A click could also be a Dirac impulse or a windowed bump; neither works here.
 * A single-sample impulse carries almost no energy at any sane gain, and a
 * unipolar bump is a DC thump that biases every peak measurement downstream. A
 * windowed noise burst is broadband, zero-mean, and its `width` does what the
 * grammar promises: wider means more low-frequency content, which is duller.
 */
function fillBurst(seed: number, sec: number, sampleRate: number): Float32Array {
  const a = alloc(sec, sampleRate);
  const n = a.length;
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * LCG_MUL) % LCG_MOD;
    a[i] = (s / LCG_SCALE - 1) * Math.exp((-3 * i) / n);
  }
  return a;
}

const EMIT_BURST =
  'U=(s_,d_)=>{const b=A(s_),a=b.getChannelData(0),n=a.length;let s=d_;' +
  `for(let i=0;i<n;i++){${NOISE_STEP}a[i]=(s/1073741824-1)*Math.exp(-3*i/n)}return b}`;

/* ------------------------------------------------------------------------- *
 * modal
 * ------------------------------------------------------------------------- */

/**
 * Additive bank of exponentially decaying partials.
 *
 * The obvious implementation is a bank of biquad band-passes excited by an
 * impulse, and that is what the phase plan called for. Additive synthesis into
 * a buffer was chosen instead for one decisive reason: **level control**. The
 * output amplitude of a resonator driven by a burst depends on the burst
 * spectrum, the bandwidth and the excitation length, so it is not predictable
 * from the soundline — and an unpredictable source level breaks the
 * `peak <= 0.95` invariant that every example is tuned against. Here the sum is
 * divided by the sum of the partial amplitudes, so the buffer provably peaks at
 * or below 1.
 *
 * The acoustics are unchanged: partial `k` rings at `freq * ratio[k]` and decays
 * with the time constant a resonator of quality `Q` would have,
 * `tau = Q / (pi * f)`. Amplitude falls as `1 / ratio`, the usual first
 * approximation for a struck body — higher modes take less of the strike
 * energy.
 */
function fillModal(
  freq: number,
  ratios: readonly number[],
  q: number,
  sec: number,
  sampleRate: number,
): Float32Array {
  const a = alloc(sec, sampleRate);
  const n = a.length;
  let m = 0;
  for (const r of ratios) m += 1 / r;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (const r of ratios) {
      const g = freq * r;
      v += (Math.sin(2 * Math.PI * g * t) * Math.exp((-Math.PI * g * t) / q)) / r;
    }
    a[i] = v / m;
  }
  return a;
}

const EMIT_MODAL =
  'M=(s_,f,rs,q)=>{const b=A(s_),a=b.getChannelData(0),n=a.length;let m=0;for(const r of rs)m+=1/r;' +
  'for(let i=0;i<n;i++){const t=i/R;let v=0;for(const r of rs){const g=f*r;' +
  'v+=Math.sin(2*Math.PI*g*t)*Math.exp(-Math.PI*g*t/q)/r}a[i]=v/m}return b}';

/* ------------------------------------------------------------------------- *
 * plate — dense mode bank, decay decoupled from frequency
 * ------------------------------------------------------------------------- */

/**
 * A struck plate: many stretched modes, each with its own decay time.
 *
 * What separates this from {@link fillModal} is that **decay does not come from
 * `Q`**. A resonator of quality `Q` has `tau = Q / (pi * f)`, so with `Q` capped at
 * 400 the longest ring available at 3.6 kHz is 35 ms — and the layer envelope
 * *multiplies* with it rather than extending it, so no combination of the two
 * reaches the second of decay a diffusion render of steel on steel measures. Here
 * `decay` is the time the lowest mode takes to fall 60 dB and it means the same
 * thing at 300 Hz as at 8 kHz. `tilt` puts the physics back: real metal loses its
 * top end first, so `tau(k) = tau(1) * k ** -tilt`.
 *
 * That decoupling is what the measurements credit. Against that reference, fitting
 * a recipe built from `modal` + `pluck` + noise stalls at a distance of 0.252 with
 * the render dying at 741 ms and sitting 12 dB quiet; the same three jobs written
 * with `plate` and a flat (`hold`) envelope fit to 0.179 — 949 ms and 0.9 dB. Both
 * numbers moved for the same reason: a ring whose length is not tied to its pitch
 * can be held near its own level instead of being cut by an exponential.
 *
 * **`slope` places the spectrum, `modes` does not.** Measured on a 600 Hz bank of
 * 16 modes, the mean centroid runs 832 Hz at `slope 2` to 2942 Hz at `slope 0` —
 * flattening the amplitude law moves the energy up into the stretched modes, which
 * is the one thing a band-pass on the layer could not do (a 12 dB/octave skirt
 * leaves the fundamental dominant). What `modes` does *not* buy is a lower crest
 * factor: with `1/k` amplitudes the lowest mode dominates the peak, so 3 modes
 * measure 21.7 dB of crest and 12 measure 23.4. Density here is spectral, not
 * dynamic.
 *
 * Phases are seeded rather than aligned. A physical strike does start every mode
 * together — that is what a transient *is* — but that peak belongs to the strike
 * layer a recipe already has, and stacking a second one there would spend the
 * headroom the `peak <= 0.95` invariant is protecting. Dividing by the sum of
 * amplitudes keeps the buffer provably inside unit peak, exactly as `modal` does.
 */
function fillPlate(
  freq: number,
  modes: number,
  stretch: number,
  slope: number,
  decay: number,
  tilt: number,
  seed: number,
  sec: number,
  sampleRate: number,
): Float32Array {
  const a = alloc(sec, sampleRate);
  const n = a.length;
  const count = Math.max(1, Math.round(modes));
  // decay is t60: ln(1000) = 6.907755278982137 time constants.
  const tau = decay / 6.907755278982137;
  const nyquist = sampleRate / 2;
  let m = 0;
  let s = seed;
  for (let k = 1; k <= count; k++) {
    /* The draw happens before the Nyquist test so the phase sequence is a property
       of the seed alone: a buffer generated at 48 kHz must not be a different sound
       from the same recipe at 44.1, only a differently band-limited one. */
    s = (s * LCG_MUL) % LCG_MOD;
    const phase = (2 * Math.PI * s) / LCG_MOD;
    const f = freq * k ** stretch;
    /* A mode above Nyquist does not ring, it *aliases* — and it aliases somewhere
       arbitrary, so it would be heard as a wrong partial rather than as a missing
       one. Measured: `plate 3600Hz modes 12 stretch 1.4` puts mode 4 at 113 kHz and
       fitted to a centroid of 4.6 kHz against a 3.1 kHz target, entirely on folded
       energy. Skipped modes are left out of the normalizer too, so dropping them
       costs no level. */
    if (f >= nyquist) continue;
    const d = tau * k ** -tilt;
    const amp = k ** -slope;
    m += amp;
    /* Written to match `EMIT_PLATE` operation for operation — float multiplication
       is not associative, and the parity test compares samples, not shapes. */
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      a[i] = (a[i] ?? 0) + amp * Math.sin(2 * Math.PI * f * t + phase) * Math.exp(-t / d);
    }
  }
  if (m > 0) for (let i = 0; i < n; i++) a[i] = (a[i] ?? 0) / m;
  return a;
}

const EMIT_PLATE =
  'W=(s_,f,md,st,sl,dc,tl,d_)=>{const b=A(s_),a=b.getChannelData(0),n=a.length,' +
  'ct=Math.max(1,Math.round(md)),tu=dc/6.907755278982137;let m=0,s=d_;' +
  `for(let k=1;k<=ct;k++){${NOISE_STEP}const ph=2*Math.PI*s/2147483647,g=f*k**st;` +
  'if(g>=R/2)continue;const d=tu*k**-tl,am=k**-sl;m+=am;' +
  'for(let i=0;i<n;i++){const t=i/R;a[i]+=am*Math.sin(2*Math.PI*g*t+ph)*Math.exp(-t/d)}}' +
  'if(m>0)for(let i=0;i<n;i++)a[i]/=m;return b}';

/* ------------------------------------------------------------------------- *
 * pluck — Karplus-Strong
 * ------------------------------------------------------------------------- */

/**
 * Karplus-Strong string, rendered ahead of time into a buffer.
 *
 * A live delay-line loop and a precomputed buffer sound the same; the buffer
 * wins because the export needs no `DelayNode`, no feedback `GainNode` and no
 * loop wiring — one `AudioBufferSourceNode` and a fill loop, which is far fewer
 * bytes.
 *
 * `damp` maps to an amplitude time constant of 20 ms (dead) to 620 ms (ringing),
 * from which the per-round-trip loop gain follows; that is more useful to a
 * model than exposing the raw loop gain, where the audible difference between
 * 0.99 and 0.999 is enormous. `bright` sets the cutoff of the one-pole filter on
 * the excitation burst. The two-sample averaging in the loop is the classic
 * Karplus-Strong low-pass, and it is what makes the tail lose its highs first.
 */
function fillPluck(
  freq: number,
  damp: number,
  bright: number,
  seed: number,
  sec: number,
  sampleRate: number,
): Float32Array {
  const a = alloc(sec, sampleRate);
  const n = a.length;
  const ln = Math.max(2, Math.round(sampleRate / freq));
  const g = Math.exp(-ln / sampleRate / (0.02 + 0.6 * (1 - damp)));
  const k = 0.1 + 0.9 * bright;
  let s = seed;
  let p = 0;
  for (let i = 0; i < n; i++) {
    if (i < ln) {
      s = (s * LCG_MUL) % LCG_MOD;
      p = p + k * (s / LCG_SCALE - 1 - p);
      a[i] = p;
    } else {
      a[i] = g * 0.5 * ((a[i - ln] ?? 0) + (a[i - ln + 1] ?? 0));
    }
  }
  return a;
}

const EMIT_PLUCK =
  'P=(s_,f,dm,br,d_)=>{const b=A(s_),a=b.getChannelData(0),n=a.length,ln=Math.max(2,Math.round(R/f)),' +
  'g=Math.exp(-ln/R/(.02+.6*(1-dm))),k=.1+.9*br;let s=d_,p=0;for(let i=0;i<n;i++){' +
  `if(i<ln){${NOISE_STEP}p=p+k*(s/1073741824-1-p);a[i]=p}` +
  'else a[i]=g*.5*(a[i-ln]+a[i-ln+1])}return b}';

/* ------------------------------------------------------------------------- *
 * grains — a field of short events
 * ------------------------------------------------------------------------- */

/**
 * Scatter of short damped pings, summed and then normalized to unit peak.
 *
 * One grain is a sine that decays inside its own width while its frequency slides by
 * `bend` — Minnaert's collapsing bubble, the same physics `bubble-pop` is built on
 * (see §9.2 of the plan: a real pop's resonance climbs 960 → 1109 Hz in 8 ms, and
 * sweeping it *downwards* is what turns a pop into a thud). Three random draws per
 * grain: when it happens, how far its frequency sits from the centre, and how loud
 * it is. Amplitude scatter is not decoration — a field of equally loud events reads
 * as a machine, and 0.35..1 is enough to break that up.
 *
 * ## `bend` is what tells water from ice
 *
 * It was a hidden 1.06 until a listener said a grain field sounded like "small
 * shards of ice scattering" rather than a splash, which is exactly right: a bright
 * short ping whose pitch does not move is glass or ice, and the rising chirp is the
 * cue the ear uses for water. At 6 % it is barely audible; the measured reference in
 * §9.2 rises about 15 %, and a convincing droplet wants 20–60 %.
 *
 * The factor is applied so that `bend` means what it says — the frequency at the
 * *end* of the grain, as a multiple of the start. Note the halving: phase
 * `2πf·t·(1 + k·t/T)` has instantaneous frequency `f·(1 + 2k·t/T)`, so a naive
 * `k = bend - 1` would bend twice as far as advertised, and a parameter that lies by
 * a factor of two is worse than no parameter.
 *
 * ## Why it normalizes, and why that is not the same as `gain`
 *
 * The sum of `rate * sec` overlapping grains has no analytic bound, so unlike
 * `modal` this generator cannot divide by a known total; it measures its own peak
 * and scales to exactly 1. Two consequences, both wanted. The `peak <= 0.95`
 * invariant stays provable from the layer gains, as it is for every other source.
 * And density stops changing loudness: `rate 200` is denser than `rate 20`, not
 * louder, so a model can reach for density without re-tuning `gain` — which is the
 * distinction it keeps getting wrong when both are in one number.
 *
 * The cost is a second pass over the buffer, about 40 bytes in the export.
 */
function fillGrains(
  freq: number,
  rate: number,
  width: number,
  spread: number,
  jitter: number,
  bend: number,
  seed: number,
  sec: number,
  sampleRate: number,
): Float32Array {
  const a = alloc(sec, sampleRate);
  const n = a.length;
  const count = Math.max(1, Math.round(rate * sec));
  const step = n / count;
  const len = Math.max(2, Math.round(width * sampleRate));
  /* Half, so `bend` is the end frequency and not twice it — see the note above.
     Named `bf` and not `k` because the grain loop below counts with `k`: the first
     version of this shadowed the factor with the grain index, so every grain bent by
     its own position and `bend` did nothing at all. Both halves of the generator had
     the same mistake, which is why the parity test stayed green — a reminder that
     parity proves the two players agree, not that either is right. */
  const bf = (bend - 1) / 2;
  let s = seed;
  for (let k = 0; k < count; k++) {
    s = (s * LCG_MUL) % LCG_MOD;
    const u1 = s / LCG_MOD;
    s = (s * LCG_MUL) % LCG_MOD;
    const u2 = s / LCG_MOD;
    s = (s * LCG_MUL) % LCG_MOD;
    const u3 = s / LCG_MOD;
    /* `jitter` moves a grain up to half a step either way, so the field keeps its
       density: scattering without that bound thins the start and piles up the end. */
    const at = Math.max(0, Math.round(step * (k + jitter * (u1 - 0.5))));
    const f = freq * 2 ** (spread * (u2 - 0.5));
    const amp = 0.35 + 0.65 * u3;
    for (let i = 0; i < len && at + i < n; i++) {
      /* Written to match `EMIT_GRAINS` operation for operation, including the order
         of `* i / sampleRate`: float multiplication is not associative, and
         `f * (i / R)` differs from `f * i / R` in the last bit — which the parity
         test would catch as a mismatch between the live graph and the export. */
      a[at + i] =
        (a[at + i] ?? 0) +
        amp * Math.exp((-4 * i) / len) * Math.sin(((2 * Math.PI * f * i) / sampleRate) * (1 + (bf * i) / len));
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = a[i] ?? 0;
    if (v > peak) peak = v;
    else if (-v > peak) peak = -v;
  }
  if (peak > 0) for (let i = 0; i < n; i++) a[i] = (a[i] ?? 0) / peak;
  return a;
}

const EMIT_GRAINS =
  'Y=(s_,f,rt,wd,sp,jt,bd,d_)=>{const b=A(s_),a=b.getChannelData(0),n=a.length,' +
  'ct=Math.max(1,Math.round(rt*s_)),st=n/ct,ln=Math.max(2,Math.round(wd*R)),bf=(bd-1)/2;let s=d_;' +
  `for(let k=0;k<ct;k++){${NOISE_STEP}const u1=s/2147483647;${NOISE_STEP}const u2=s/2147483647;` +
  `${NOISE_STEP}const u3=s/2147483647,at=Math.max(0,Math.round(st*(k+jt*(u1-.5)))),` +
  'g=f*2**(sp*(u2-.5)),am=.35+.65*u3;' +
  'for(let i=0;i<ln&&at+i<n;i++)a[at+i]+=am*Math.exp(-4*i/ln)*Math.sin(2*Math.PI*g*i/R*(1+bf*i/ln))}' +
  'let p=0;for(let i=0;i<n;i++){const v=a[i];if(v>p)p=v;else if(-v>p)p=-v}' +
  'if(p>0)for(let i=0;i<n;i++)a[i]/=p;return b}';

/* ------------------------------------------------------------------------- *
 * verb — convolution impulse response
 * ------------------------------------------------------------------------- */

/**
 * Noise impulse response with a squared fade-out and a damped top end.
 *
 * `ConvolverNode` normalizes its response by default, so the wet level stays
 * predictable regardless of tail length — which is why this generator does not
 * normalize itself.
 */
function fillVerb(sec: number, damp: number, seed: number, sampleRate: number): Float32Array {
  const a = alloc(sec, sampleRate);
  const n = a.length;
  const k = 1 - 0.9 * damp;
  let s = seed;
  let l = 0;
  for (let i = 0; i < n; i++) {
    s = (s * LCG_MUL) % LCG_MOD;
    l = l + k * (s / LCG_SCALE - 1 - l);
    const e = 1 - i / n;
    a[i] = l * e * e;
  }
  return a;
}

const EMIT_VERB =
  'V=(s_,dm,d_)=>{const b=A(s_),a=b.getChannelData(0),n=a.length,k=1-.9*dm;let s=d_,l=0;' +
  `for(let i=0;i<n;i++){${NOISE_STEP}l=l+k*(s/1073741824-1-l);const e=1-i/n;a[i]=l*e*e}return b}`;

/* ------------------------------------------------------------------------- *
 * Waveshaper curve
 * ------------------------------------------------------------------------- */

/** Number of points in the `dist` transfer curve. Odd, so 0 maps to 0. */
export const CURVE_POINTS = 257;

/**
 * Soft-clipping transfer curve for the `dist` effect.
 *
 * `tanh(drive * x) / tanh(drive)` is the standard soft clipper, normalized so
 * that full-scale input still maps to full scale: distortion should change the
 * timbre without moving the peak, or every `drive` change would need a `gain`
 * change to compensate.
 */
export function shaperCurve(drive: number): Float32Array<ArrayBuffer> {
  const a = new Float32Array(CURVE_POINTS);
  const t = Math.tanh(drive);
  for (let i = 0; i < CURVE_POINTS; i++) a[i] = Math.tanh(drive * (i / 128 - 1)) / t;
  return a;
}

const EMIT_CURVE =
  'W=k=>{const a=new Float32Array(257),t=Math.tanh(k);' +
  'for(let i=0;i<257;i++)a[i]=Math.tanh(k*(i/128-1))/t;return a}';

/* ------------------------------------------------------------------------- *
 * Dispatch
 * ------------------------------------------------------------------------- */

/** Render a buffer recipe to samples. */
export function fillBuffer(spec: IRBufferSpec, sampleRate: number): Float32Array {
  switch (spec.kind) {
    case 'noise':
      return fillNoise(spec.color, spec.seed, spec.sec, sampleRate);
    case 'burst':
      return fillBurst(spec.seed, spec.sec, sampleRate);
    case 'modal':
      return fillModal(spec.freq, spec.ratios, spec.q, spec.sec, sampleRate);
    case 'plate':
      return fillPlate(
        spec.freq,
        spec.modes,
        spec.stretch,
        spec.slope,
        spec.decay,
        spec.tilt,
        spec.seed,
        spec.sec,
        sampleRate,
      );
    case 'pluck':
      return fillPluck(spec.freq, spec.damp, spec.bright, spec.seed, spec.sec, sampleRate);
    case 'grains':
      return fillGrains(
        spec.freq,
        spec.rate,
        spec.width,
        spec.spread,
        spec.jitter,
        spec.bend,
        spec.seed,
        spec.sec,
        sampleRate,
      );
    case 'verb':
      return fillVerb(spec.sec, spec.damp, spec.seed, sampleRate);
  }
}

/** Emitter specialized to one sound's set of recipes. */
export interface BufferEmitter {
  /**
   * Declarations to place in the export's prelude, as `name=value` fragments
   * for a single shared `const`.
   */
  readonly helpers: readonly string[];
  /** Expression that builds one recipe's `AudioBuffer`. */
  expr(spec: IRBufferSpec): string;
}

/**
 * Build the emitter for a specific sound.
 *
 * Specialized rather than general on purpose: whether the noise generator takes
 * a colour argument depends on how many colours this sound uses, so the helper
 * text and the call sites have to be decided together.
 */
export function bufferEmitter(specs: readonly IRBufferSpec[], needsCurve: boolean): BufferEmitter {
  const kinds = new Set(specs.map((s) => s.kind));
  const colors = new Set(specs.flatMap((s) => (s.kind === 'noise' ? [s.color] : [])));

  const helpers: string[] = [];
  if (kinds.size > 0) helpers.push('A=s_=>c.createBuffer(1,R*s_|0||1,R)');
  if (kinds.has('noise')) helpers.push(emitNoise(colors));
  if (kinds.has('burst')) helpers.push(EMIT_BURST);
  if (kinds.has('modal')) helpers.push(EMIT_MODAL);
  if (kinds.has('plate')) helpers.push(EMIT_PLATE);
  if (kinds.has('pluck')) helpers.push(EMIT_PLUCK);
  if (kinds.has('grains')) helpers.push(EMIT_GRAINS);
  if (kinds.has('verb')) helpers.push(EMIT_VERB);
  if (needsCurve) helpers.push(EMIT_CURVE);

  return {
    helpers,
    expr(spec) {
      switch (spec.kind) {
        case 'noise': {
          const tag = colors.size > 1 ? `,${num(COLOR_TAG[spec.color])}` : '';
          return `Z(${num(spec.sec)},${num(spec.seed)}${tag})`;
        }
        case 'burst':
          return `U(${num(spec.sec)},${num(spec.seed)})`;
        case 'modal':
          return `M(${num(spec.sec)},${num(spec.freq)},${numList(spec.ratios)},${num(spec.q)})`;
        case 'plate':
          return `W(${num(spec.sec)},${num(spec.freq)},${num(spec.modes)},${num(spec.stretch)},${num(spec.slope)},${num(spec.decay)},${num(spec.tilt)},${num(spec.seed)})`;
        case 'pluck':
          return `P(${num(spec.sec)},${num(spec.freq)},${num(spec.damp)},${num(spec.bright)},${num(spec.seed)})`;
        case 'grains':
          return `Y(${num(spec.sec)},${num(spec.freq)},${num(spec.rate)},${num(spec.width)},${num(spec.spread)},${num(spec.jitter)},${num(spec.bend)},${num(spec.seed)})`;
        case 'verb':
          return `V(${num(spec.sec)},${num(spec.damp)},${num(spec.seed)})`;
      }
    },
  };
}
