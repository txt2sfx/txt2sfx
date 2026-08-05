# Primitives and effects

Eight sources, six effects, one envelope. The **authoritative parameter tables** —
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
| `fm` | Two-operator FM: bells, mallets, sci-fi timbres that additive layers cannot reach. |
| `sub` | The part you feel: a low sine, usually swept downwards. Explosions, impacts. |
| `click` | Pure transient with no pitch of its own. The edge on a pop, a UI tick. |

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
