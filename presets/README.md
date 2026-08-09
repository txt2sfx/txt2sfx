# presets/

Fifty ready-made sounds, one file each. They exist so that a playground opened
without an API key is still useful: the gallery has something in every category to
listen to, open in the studio, turn the sliders on and export — the whole product
except the sentence that generates a new one.

## How this differs from `examples/`

`examples/` is the **reference set**: ten recipes the tests, the documentation and
the few-shot prompt are all pinned against. Adding one means a row in
`docs/ACOUSTIC_PROFILE.md`, a prompt in the seeder's table and an edit to every test
that counts them. That weight is deliberate for a reference, and wrong for a
catalog.

A preset is lighter and stricter at the same time:

| | `examples/` | `presets/` |
| --- | --- | --- |
| prompt and tags | in the seeder's `PROMPTS` table | in the file, as `#` comments |
| a row in `docs/ACOUSTIC_PROFILE.md` | required | no |
| may carry a validation error | yes — `helicopter` does, knowingly | **no** |
| must render without clipping | checked by the render tests | **enforced by `seed --strict`** |

The one deliberate validation error in the repository stays where it is documented,
in `examples/helicopter.soundline`. Presets do not get that exemption: they are the
first thing a new user hears, and a catalog that ships with a warning attached to it
teaches the wrong thing about what the validator is for.

## The contract

Every file in this directory must:

1. **Be canonical** — `serialize(parse(src)) === src`, byte for byte. The serializer
   is the only definition of canonical (two-space indent, arguments in signature
   order, `misc` omitted from the header). Round-tripping is what lets a human and a
   model edit the same file without reformatting each other's work.
2. **Declare a prompt**, as the first thing in the file:
   ```
   # prompt: sci-fi laser pistol zap, quick and thin
   ```
   Written the way somebody would actually type it into the box, not as a
   description of the recipe — retrieval ranks a query against these.
3. **Declare tags**, comma-separated:
   ```
   # tags: laser, pistol, zap, weapon
   ```
   At least two. They are what a search that misses the prompt still finds.
4. **Validate clean.** `validate(ast)` returns nothing — not even a warning.
5. **Render clean.** Audible, no clipping, and a peak at or below
   `GLOBAL_LIMITS.maxPeak` (0.95). Measured, not asserted: the seeder renders every
   preset and reports the peak.
6. **Leave something to turn.** At least two `~value[min..max]` slots with ranges
   that are worth searching, because a preset with no slots gives the studio's
   sliders and its Fit button nothing to work on. Delegate what a metric judges well
   — filter cutoffs, levels, rates — and keep what was chosen by ear as a literal.

Both markers are read by `recipeMeta()` in `@txt2sfx/core`, which is also what the
playground uses to fill in a card's prompt and what the seeder stores in the bank.

## Checking your work

```powershell
corepack pnpm vitest run test/presets.test.ts        # canon, validation, metadata
corepack pnpm --filter @txt2sfx/server seed -- --strict
```

The test covers everything derivable from the text. The seeder is what renders: its
report prints the measured peak per recipe, and under `--strict` a preset that
clips or fails validation is `REFUSED` rather than stored. Run it against a scratch
database if you do not want the recipes in your local bank:

```powershell
$env:TXT2SFX_DB = "$env:TEMP/preset-check.db"; corepack pnpm --filter @txt2sfx/server seed -- --strict
```

That run seeds `examples/` too, so it refuses `helicopter` and exits non-zero —
that is the one documented exception and not something to fix here. What matters
for a preset is that no preset appears on a `REFUSED` line, in the validation-error
list, or in the clipping list at the bottom.

## Adding one

Write the file, run the two commands above, and add its name to the manifest in
`test/presets.test.ts` — the test pins the exact list, so a preset cannot go missing
silently and a new one cannot arrive without being looked at. Nothing else in the
repository has to change.
