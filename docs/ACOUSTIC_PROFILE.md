# Measuring sounds

`@txt2sfx/analyzer` is three layers, each usable alone:

1. `extractProfile(signal)` measures one sound — a candidate render or a decoded
   reference, identically.
2. `profileDistance`, `stftDistance` and `soundDistance` say how far apart two of them
   are. The last is what the optimizer minimizes.
3. `humanReadableDiff` turns a distance into instructions a model can act on.

Zero dependencies, including no Web Audio: the input is `{ samples, sampleRate }`, which
a browser, Node and a decoded file can all supply. Decoding belongs to the caller.

## The profile

`SoundProfile` is about a hundred numbers: duration to −60 dBFS, attack to peak, a
64-point RMS envelope (peak-normalized), a 32-point spectral-centroid trajectory,
median spectral flatness, noise ratio, dominant partial, approximate LUFS.

It is compact on purpose. The recipe bank stores profiles and no audio, so retrieval and
profile-only fitness work without a single render — and a profile survives JSON, which a
`Float32Array` does not.

## Three deviations from the naive metric

| what | the naive way | what it does | why |
| --- | --- | --- | --- |
| the metric | one `profileDistance` = fields + STFT loss | `profileDistance` (fields), `stftDistance` (waves), `soundDistance` (both, 50/50) | An STFT loss cannot be computed from a `SoundProfile`: the profile is a hundred numbers, the loss needs audio. The bank stores only profiles and must still compare recipes without rendering. One function cannot serve both calls. |
| STFT loss | L1 on log-magnitudes | L1 on log-magnitudes **plus spectral convergence**, 50/50 per frame | L1 alone is diluted by the bins where both signals sit on the floor, and in a sparse spectrum that is nearly every bin: a 1 kHz sine against a 1.4 kHz sine — nothing in common — scored **0.046**, because six bins differing by 100 dB were averaged across 250 bins that agreed about silence. With energy normalization the same pair scores ≈0.5. |
| `noiseRatio` | share of energy outside harmonic peaks, on the mean spectrum | per frame, median, threshold from a **ring** mean with the main lobe excised | Averaging the spectrum over time turns a sweep into a plateau with no peaks: `bubble-pop` — two tonal layers, no noise at all — measured 0.93. And a ±4-bin mean that includes the peak itself compresses the metric, so purely tonal recipes scored 0.64 instead of ~0. After both fixes: tonal 0.00–0.04, noisy 0.31–0.81. |

## Window size is a measurement decision

The analysis window is 512–2048 samples, chosen from the signal length. Both ends were
measured, not guessed:

- **2048 samples (43 ms) is too long for a transient.** It covered a whole 14 ms pop and
  smeared one gliding tone into three phantom partials — the "cluster of partials at
  896/982/1060 Hz" in an early measurement was an artifact of the window.
- **128 samples is too short.** `peakHz` for `bubble-pop` came out at 772 Hz: it read the
  first instant of the sweep instead of the sweep.

512 is also the window the playground's Compare panel uses, deliberately: a judgement
formed by looking at pictures should mean the same thing to the optimizer.

`peakHz` is refined by parabolic interpolation on log magnitudes, because a 512-point
window has 86 Hz bins and the job is to tell 1055 Hz from 1098 Hz — half a bin. Measured
error under 21 Hz on synthetic sines at 1055 / 1098 / 3210 Hz.

LUFS is approximate on purpose: a first-order 100 Hz high-pass instead of the full
BS.1770 K-filter, whose coefficients are derived per sample rate. The number is used for
two things — comparison with a target, and loudness normalization before spectral
comparison — and for both, one multiply-add per sample is enough.

## Reference measurements

If a change to the analyzer moves these, that needs explaining:

| recipe | dur, ms | atk, ms | peakHz | centroid₀, Hz | flatness | noise | LUFS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bubble-pop | 42 | 1 | 836 | 1115 | 0.0014 | 0.005 | −15.1 |
| coin | 182 | 1 | 1320 | 4948 | 0.0314 | 0.001 | −18.8 |
| door-creak | 201 | 3 | 100 | 131 | 0.0032 | 0.000 | −28.8 |
| explosion | 1128 | 3 | 58 | 866 | 0.0019 | 0.314 | −28.5 |
| footstep-gravel | 103 | 4 | 5275 | 8456 | 0.3471 | 0.812 | −30.4 |
| helicopter | 3892 | 9 | 62 | 812 | 0.0154 | 0.318 | −36.7 |
| laser | 150 | 1 | 1630 | 6386 | 0.4239 | 0.584 | −20.5 |
| powerup | 464 | 1 | 451 | 4083 | 0.1166 | 0.041 | −19.4 |
| sword-clash | 163 | 6 | 2101 | 4317 | 0.0136 | 0.014 | −27.4 |
| ui-click | 20 | 1 | 1800 | 4232 | 0.1113 | 0.016 | −25.4 |

Two sanity properties are pinned as tests. `peakHz` returns the number the recipe
actually contains — `sword-clash` 2101 against `modal metal 2100Hz`, `coin` 1320 against
`tone square 1319Hz`, `ui-click` 1800 against `tone sine 1800Hz`, `helicopter` 62 against
`sub ~62Hz`. And the analyzer measures `helicopter` at 3892 ms where the compiler
*estimates* 4046 — two independent roads to the same finding about that recipe.

The `soundDistance` matrix over the ten references is symmetric with an exactly zero
diagonal. Closest pairs: bubble-pop↔ui-click 0.36, coin↔laser 0.37, laser↔footstep 0.37.
`explosion` is furthest from everything (0.58–0.60), being the only long low sound. So
**different sounds live between 0.36 and 0.60** — compressed at the top, but ordered, and
what matters for fitness is the neighbourhood of zero, where a recovered recipe lands
below 0.05.

## A bug worth remembering

The onset detector looked for the steepest rise starting from frame 1. A sound whose
layers all have `attack 0ms` has no rise at all: it starts at full amplitude on sample 0
and every later frame is quieter. The maximum "rise" was then zero, found in the trailing
silence the renderer appends — so the onset landed past the end of the sound and the
whole profile zeroed out. No error, no warning.

Fixed by comparing frame 0 against implicit silence before the signal, in the analyzer
*and* in the playground's own copy of the formula (`apps/web/src/lib/analysis.ts`), which
had the same bug and would have broken the Compare panel on any recipe made of
`attack 0ms` layers. Both are pinned by regression tests.

## Directives, not numbers

`humanReadableDiff(candidate, target, ast?)` returns lines like:

```
attack is 45ms, target 8ms — shorten the gain ramp
centroid 1.2kHz vs 3.4kHz — raise bp frequency in layer 'snap'
dominant partial 300Hz vs 1.8kHz — raise the source frequency; a wrong dominant
partial is heard as the wrong object, not as the wrong tone
```

A model handed `centroid: 1204 vs 3390` has to work out which direction is which, which
parameter moves it, and which layer owns that parameter — three inferences before it can
edit anything. Handed the sentence, it edits.

Two rules keep the list useful: every field has a threshold and produces nothing below
it, and the ordering is by the same normalized distance the fitness uses, so the list and
the score never disagree about what is worst. A model told about eight discrepancies
fixes two and restructures something unrelated; told about the two that matter, it fixes
them.

The layer named in a directive is chosen, not guessed: the filter tuned closest to where
the energy currently sits (so moving it changes the centroid instead of adding a
competing resonance), and the loudest layer by written gain for a level correction.
Without an AST the directive says what is wrong and stays quiet about where.
