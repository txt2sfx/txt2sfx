# Primitives and effects

Ten sources, six effects, one envelope. The **authoritative parameter tables** —
units, ranges, defaults, which parameters accept trajectories — are generated from the
signature table the parser itself uses and served at `GET /api/llms.txt`, or produced
in-process by `llmsText()` from `@txt2sfx/agent`. Reading them there means never
reading a stale table.

This document is the part worth writing by hand: what each one is *for*, and where the
implementation deliberately departs from the obvious approach.

## Sources

| primitive | what it is for |
| --- | --- |
| `tone` | Pitched body: sine, triangle, square, saw. The thing a listener hears as the note. |
| `noise` | Texture: white, pink, brown. Breath, grit, blast, wind. |
| `chirp` | A fast frequency sweep as a source in its own right — zaps, whooshes, risers. |
| `pluck` | Plucked string: a short excitation into a damped resonance. |
| `modal` | A struck object's partials (metal, wood, glass, membrane) — bells, clashes, hits. |
| `plate` | The same idea with its decay written in milliseconds instead of a `Q`: long bright rings, plates, bars, tanks. |
| `fm` | Two-operator FM: bells, mallets, sci-fi timbres that additive layers cannot reach. |
| `sub` | The part you feel: a low sine, usually swept downwards. Explosions, impacts. |
| `click` | Pure transient with no pitch of its own. The edge on a pop, a UI tick. |
| `grains` | A dense field of short events: water, rain, gravel, fire, boiling, a crowd. |

## Effects

| effect | what it is for |
| --- | --- |
| `lp` `hp` `bp` | Biquad filters. Where a sound sits in the spectrum, and how wide. |
| `dist` | Waveshaper: loudness and grit without gain, and harmonics a filter cannot add. |
| `delay` | Echo and recirculation. With high feedback it is not an echo, it is a texture. |
| `verb` | Cheap room. A tail that outlives the decay, because the chain runs after the envelope. |

`dist`, `delay` and `verb` take a `mix`. At `mix 0` no wet path is built; at `mix 1` no
summing node is built. Both edges occur in the reference set (`helicopter` is `mix 1`),
and every node not built is bytes not exported.

### Why `grains` exists

Not a convenience — a gap. `noise` is stationary and `chirp` is a single sweep, so
nothing in the other eight primitives produces a *scatter of individual events*, and
water, rain, gravel, fire and crowds are all exactly that. It was measured rather than
guessed: against a water-splash recording, a recipe built from four filtered noise
layers converges to a spectral flatness of about 0.42 where the reference sits at
0.58, and the optimizer reports a genuine stall — the numbers are exhausted and the
residual is the missing shape.

One grain is a damped sine whose pitch slides by `bend` over its own length: Minnaert's
collapsing bubble, the same physics `bubble-pop` is built on. That one shape covers the
whole range, because two parameters decide how it is heard. `spread` sets the texture —
a few hundred pings scattered across three octaves read as broadband ticks (rain,
gravel), half an octave reads as individual droplets. And `bend` sets the *material*:

| `bend` | what it sounds like |
| --- | --- |
| 1 | ice, glass, ceramic — a bright ping whose pitch does not move |
| 1.2–1.6 | water: a collapsing cavity rises in pitch, and that rise is the cue the ear uses |
| below 1 | a bubble rising and releasing — a falling "bloop" |

That parameter exists because of a listening test, not a theory: with the bend hidden at
6 % a splash was described as "small shards of ice scattering", which is exactly what a
field of short bright pings with no pitch movement is. The reference measured in §9.2 of
the plan rises about 15 % in 8 ms.

Three properties are worth knowing before using it:

- **Density is not loudness.** The field normalizes to unit peak, so `rate 220` is
  busier than `rate 12` (measured: RMS 0.0442 against 0.0218) and no louder (peak 0.477
  against 0.545). `gain` remains the only level control, which is what keeps a model
  from re-tuning gain every time it reaches for a denser texture.
- **`bend` means the end frequency**, not the phase coefficient. Phase `2πf·t·(1 + k·t/T)`
  has instantaneous frequency `f·(1 + 2k·t/T)`, so the factor is halved internally; a
  parameter that bent twice as far as it claimed would be worse than none.
- **It costs bytes.** A one-layer `grains` recipe exports at about 980 B, most of it the
  generator. That is the same trade every buffer source makes — see *Export size* below.

### Why `plate` exists

`modal` already sums decaying partials, so a second additive bank needs a reason. The
reason is one line of physics: a resonator of quality `Q` has `tau = Q / (pi * f)`, so
with `Q` capped at 400 the longest ring available at 3.6 kHz is `tau` 35 ms — 60 dB
down inside 250 ms. Worse, the layer envelope **multiplies** with that rather than
extending it: two exponentials of time constants `a` and `b` reach -60 dB at
`6.9 * ab / (a + b)`, which is always shorter than either. Inside the `impact`
category, where the envelope decay is capped at 1200 ms, nothing built from `modal`
can hold a bright ring for a second. `plate` writes the decay as a time — the t60 of
its lowest mode, frequency-independent — and `tilt` puts the physics back by making
high modes die first, which is what real metal does.

It was measured, not argued. The target is a Stable Audio render of *"steel on steel:
a noise strike transient plus two metallic modal rings"* (`test/stable-audio/`), fitted
headless with the same differential evolution the playground runs:

| recipe | layers | export | distance | duration | attack | dominant | loudness |
| --- | --- | --- | --- | --- | --- | --- | --- |
| reference | — | — | — | 1002 ms | 14 ms | 3605 Hz | -17.2 LUFS |
| `modal` + `pluck` + noise | 5 | 1894 B | 0.252 | 741 ms | 30 ms | 3287 Hz | -29.0 LUFS |
| `plate` x2 + noise | 3 | 1505 B | **0.179** | 949 ms | 14 ms | 3644 Hz | -18.1 LUFS |

The 11 dB of loudness and the 200 ms of decay came from the same change, and it is not
the one that was expected: a ring whose length is not tied to its pitch can be held
near its own level with `hold` instead of being cut by an exponential. **Write the
length in the primitive's `decay` and keep the envelope flat over it** — an exponential
envelope on top multiplies with the bank and neither number is then what you hear.

Two more things the measurements settled:

- **`slope` places the spectrum; `modes` does not.** With the default `1/k` amplitude
  law the lowest mode dominates, so the fitted dominant partial sat an octave below the
  reference no matter what a band-pass on the layer did — a 12 dB/octave skirt cannot
  outvote a 6 dB amplitude advantage. Flattening the law moves the energy up into the
  stretched modes: on a 600 Hz bank of 16 modes the mean centroid runs 832 Hz at
  `slope 2` to 2942 Hz at `slope 0`.
- **Density here is spectral, not dynamic.** The hypothesis was that many modes would
  lower the crest factor towards the reference's 15 dB. Measured false: 3 modes give
  21.7 dB and 12 give 23.4, because `1/k` leaves mode one owning the peak. The claim
  is recorded here because it was wrong — the crest gap to a diffusion render is still
  open, and the next attempt should not re-run this one.

Modes landing above the Nyquist rate are **dropped, not rendered**. An aliased mode
folds to an arbitrary frequency, so it is heard as a wrong partial rather than a
missing one, and the first version of this primitive fitted to a centroid of 4.6 kHz
against a 3.1 kHz target entirely on folded energy. `freq`, `stretch` and the sample
rate therefore decide together how many of the `modes` are audible: at 3.6 kHz with
`stretch 1.4`, three of them are.

## Deviations from the obvious implementation

Four places where the straightforward approach was measured and rejected. Each is
documented in the TSDoc of the file that owns it; this is the summary.

| what | the obvious way | what it does | why |
| --- | --- | --- | --- |
| `modal` | 2–5 biquad resonators excited by a burst | additive synthesis into a buffer | The level of a resonator driven by a burst is not predictable from the soundline, and an unpredictable source level breaks the `peak ≤ 0.95` invariant the examples are calibrated against. The acoustics are the same — each partial rings at `freq × ratio` and decays with `tau = Q/(π·f)` — and dividing by the sum of amplitudes makes the buffer peak *provably* ≤ 1. |
| `click` | a single impulse | a windowed noise burst | A Dirac carries no energy at a sane gain, and a unipolar bump is a DC hit that drags every downstream peak measurement below the truth. A burst is broadband, has zero mean, and makes `width` do what the grammar promises: wider is duller. |
| PRNG | a 32-bit LCG | MINSTD (`s·16807 mod 2³¹−1`) | Full period, no weak low bits — **and** shorter in the export, because `2³¹ × 16807 < 2⁵³` means no `Math.imul`. 17 bytes saved in each of four generators. The state must never reach zero, which is what `normalizeSeed` is for. |
| `pluck` | a Karplus–Strong feedback loop | a precomputed buffer | The export needs no `DelayNode`, no feedback path and no plumbing around it. |

Other decisions that shape how these behave:

- **Attack is always linear**; decay is exponential by default, to an *absolute* floor
  of −60 dBFS. A relative floor would make quiet layers ring longer than loud ones.
- **Every exponential ramp is clamped away from zero**, including when the author writes
  `-> 0Hz` or `index -> 0`. The intent is audible, the literal zero is not.
- **Layer seeds are decorrelated** by a multiplicative hash of the layer index. Two
  white-noise layers sharing a seed do not give a wider texture — they give the same
  texture 6 dB louder.
- **The renderer reports clipping and never normalizes.** Normalization hides the
  problem where it can still be fixed properly, in the spec.

## Measured peaks

Default seed, 44.1 kHz. No example clips, and the sum of layer gains is neither an
upper bound (layers do not peak together — different attacks, decays and delays spread
them) nor a lower one (`hp` differentiates and can lift the peak above its input; there
is a test pinning that).

| example | peak | | example | peak |
| --- | --- | --- | --- | --- |
| bubble-pop | 0.785 | | helicopter | 0.505 |
| coin | 0.498 | | laser | 0.818 |
| door-creak | 0.283 | | powerup | 0.418 |
| explosion | 0.744 | | sword-clash | 0.436 |
| footstep-gravel | 0.355 | | ui-click | 0.397 |

`explosion` has about 2 dB of headroom, which is why the optimizer's fitness penalizes
clipping rather than only rewarding a spectral match: a search told to match a spectrum
will happily spend that headroom.

## Export size

`GLOBAL_LIMITS.maxExportBytes` is 1024. Measured, after emitter optimization:

| example | layers | bytes | | example | layers | bytes |
| --- | --- | --- | --- | --- | --- | --- |
| coin | 2 | **531** | | helicopter | 3 | 1093 |
| laser | 2 | **553** | | powerup | 3 | 1169 |
| ui-click | 2 | **811** | | door-creak | 3 | 1185 |
| bubble-pop | 2 | **876** | | explosion | 4 | 1458 |
| | | | | sword-clash | 3 | 1579 |
| | | | | footstep-gravel | 3 | 1708 |

All four two-layer recipes fit in 1 KB; three- and four-layer recipes exceed it by
7–67 %. The cause is structural, not sloppy generation: the procedural buffer generators
are a fixed cost, and that cost is exactly what buys a project with no audio assets.
`footstep-gravel` pays for a two-colour noise generator, a modal bank and a waveshaper
curve — about 640 bytes before the first graph node.

What is already done for size: one shared `const` prelude; noise generators emitted only
for the colours actually used; one-character aliases for long `AudioParam` method names,
for `connect`, for `start`/`stop` and for repeated `ctx.createX()` factories — each only
when it pays for its own declaration; values equal to Web Audio defaults omitted
entirely; a parameter with a single event written as `.value=`.

Ideas deliberately not taken: `a.connect(b).connect(c)` chaining saves ~3 bytes a link
and complicates the emitter; a shared envelope helper would save ~20 bytes per layer but
would encode the envelope's shape in a second place — destroying the single-DSP property
that makes exact render parity possible.

So the honest claim, and the one the README makes, is **300–1000 bytes for a typical
SFX**, not "always under a kilobyte".
