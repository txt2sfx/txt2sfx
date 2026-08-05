# SFX-Bench v0

A regression benchmark for the txt2sfx pipeline: for each target, run the agent loop
against a reference sound and report how close it got, in how many iterations, and at
what export size.

```powershell
pnpm bench                                   # scripted model, no key, reproducible
pnpm bench -- --strict                       # non-zero exit if a target regresses
pnpm bench -- --targets laser,coin
pnpm bench -- --out bench/results.md
pnpm bench -- --provider gemini              # real model, GEMINI_API_KEY
pnpm bench -- --provider anthropic --model claude-opus-5
```

## What it measures, and what it does not

The default run uses a **scripted model**: each target file carries the reply (or
replies) the model is pretending to give. That makes the whole thing reproducible and
turns it into a regression test for *this repository* — everything downstream of the
model is real, so a moved number means the validator, the renderer, the optimizer or
the loop changed, not that a vendor shipped a new checkpoint.

Pass `--provider gemini` or `--provider anthropic` and the scripted replies are
ignored: the same targets become a model evaluation. Useful, and not reproducible.
Which is why it is not the default.

`distance` is the profile distance between the accepted recipe's render and the
reference recipe's render (`--audio` adds the multi-resolution spectral loss, which is
stricter and slower). Zero means the same sound. For scale: in the measured matrix of
the ten reference recipes, two *different* sounds sit between 0.36 and 0.60, so a
threshold of 0.1 asks for something distinctly closer than any two different sounds in
the set.

## The `path` column is the interesting one

It lists what each iteration ended on. `render → accepted` means the loop caught a
buffer that clipped and the model fixed it; `distance → accepted` means the numerical
optimizer was stuck, the model was asked to change the structure, and did. A target
whose path collapses to a bare `accepted` has stopped exercising the stage it was
written for — a regression the distance column cannot show, which is why
`bench/test/targets.test.ts` pins each target's shape.

## Measured on 2026-08-05

Node 24.15 on win32-arm64, scripted model, profile-only metric, optimizer 16 × 24,
seed 1:

| target | result | path | distance | budget | export |
| --- | --- | --- | --- | --- | --- |
| bubble-pop | pass | accepted | 0.090 → 0.031 | ≤ 0.100 | 877 B |
| ui-click | pass | accepted | 0.192 → 0.077 | ≤ 0.100 | 786 B |
| coin | pass | invalid → accepted | 0.000 → 0.000 | ≤ 0.050 | 531 B |
| laser | pass | distance → accepted | 0.000 → 0.000 | ≤ 0.050 | 553 B |
| footstep-gravel | pass | accepted | 0.171 → 0.005 | ≤ 0.120 | 1708 B *(over)* |
| explosion | pass | render → accepted | 0.000 → 0.000 | ≤ 0.050 | 1458 B *(over)* |

6 of 6, about 0.3 s in total. The two `(over)` rows are the honest part: a three- or
four-layer recipe pays a fixed cost for its procedural buffer generators and does not
fit in 1 KB (see §5.4 of the plan). `withinBudget` is a report, not a gate.

## Adding a target

One JSON file per target in `targets/`, named `NN-<name>.json` so runs are comparable
in order:

```json
{
  "name": "coin",
  "prompt": "coin pickup sound for a platformer, arcade style",
  "reference": "coin",
  "maxDistance": 0.05,
  "exercises": "Validator repair: the first attempt files a 260 ms jingle under `pop`.",
  "attempts": [
    ["sound \"coin\" 260ms pop", "  blip: tone square 988Hz | gain 0.5 decay 70ms"],
    ["sound \"coin\" 260ms pickup", "  blip: tone square 988Hz | gain 0.5 decay 70ms"]
  ]
}
```

- `reference` names a recipe in `examples/`; its render is the target sound.
- `attempts` is one entry per iteration, each a list of soundline lines — a list
  because the recipe is the thing a reader most needs to be able to read.
- A single-attempt target must contain `~` slots: with nothing to fit, it measures
  nothing. A multi-attempt target must actually differ between attempts. Both rules
  are enforced by the tests.
- `exercises` says which stage the target is for. Write it for the person who will
  read a failure six months from now.

## Roadmap

v0.3 in `ROADMAP.md` is 50 targets and a published table, which needs targets whose
reference is a **recording** rather than one of our own recipes — the analyzer already
takes `{ samples, sampleRate }` and `node-web-audio-api` decodes mp3/wav/flac/ogg, so
the missing piece is the sample set and its licensing, not the code.
