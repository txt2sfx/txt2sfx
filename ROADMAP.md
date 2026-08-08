# Roadmap

Dates are absent on purpose. The ordering is by dependency, and each milestone names the
thing that has to become true, not the work that has to be done.

## v0 — prototype *(current)*

The pipeline end to end: the `soundline` language with a byte-stable round trip, eight
primitives and six effects behind one intermediate representation, exact render parity
between the live graph and the exported JavaScript, a physical-invariant validator, an
acoustic analyzer with its own FFT, a differential-evolution optimizer over `~` slots, a
recipe bank with FTS5 retrieval, the playground, providers for Gemini and Anthropic,
the generate-and-repair loop, and a reproducible benchmark.

Known and deliberate gaps, all listed under *Honesty about limits* in the README:
similarity is judged numerically; three- and four-layer exports exceed 1 KB; one reference
recipe (`helicopter`) breaks its duration contract on purpose.

## v0.1 — the playground closes the loop *(done)*

The prompt bar, the provider picker and the key field, all in tab memory, with the gallery
reading from the bank as well as `examples/`. Technically a thin layer over
`@txt2sfx/agent`; the reason it was a milestone of its own is that "paste a key, type a
sentence, hear a sound" is the first point at which someone who has not read this
repository can judge it.

Two things landed alongside it, both because the front door made them visible. The
playground now shows the **validator's own issues** on whatever is in the editor, hand
edits included — it used to enforce those invariants only inside the agent loop. And a
solved recipe can be **published to the bank** from the sidebar, which is what makes the
bank fill up with anything other than the ten seeded examples.

## v0.2 — a judge that hears

Two independent upgrades to the same weakness — the metric is not perception:

- **A CLAP judge**, as an optional plugin. The interface already exists as a stub: profile
  in, distance out, same shape the optimizer minimizes.
- **Vision comparison of spectrograms.** The Compare panel already exports a
  self-contained PNG with both signals, the mode and the alignment state drawn into it,
  plus a markdown table of the metrics — deliberately, so a vision model can be handed
  both and asked which is closer, and why.

Neither replaces the numeric metric; both are votes alongside it.

## v0.3 — SFX-Bench, 50 targets, public table

Grow `bench/` from six targets to fifty, and publish the table. The blocker is not code:
the interesting targets have **recordings** as references rather than our own recipes, and
that needs a sample set with licensing we can actually publish. The analyzer already takes
`{ samples, sampleRate }`, and `node-web-audio-api` decodes mp3/wav/flac/ogg through
symphonia, so the decoding half is done.

Half of the licensing half is now answered by hand: the playground's `Search` tab queries
freesound.org filtered to **CC0**, plays the result, and loads it as the B side — a corpus
this project can publish results against, one sound at a time. What is still missing is
the collection step: choosing fifty of them, pinning ids, and fetching them reproducibly
from `bench/` rather than from a browser tab.

Also in scope: reporting per-target *model* scores when run against a real provider, so the
table says something about models and not only about this repository.

## v0.4 — showcase on GitHub Pages

The playground, built statically, with the bank's contents baked in as a read-only gallery:
click a sound, hear it, read its soundline, copy the JavaScript. No key required to browse;
a key field for generating. This is the artifact that makes the pitch in one click.

## v1.0 — a stable grammar

Freeze `soundline`. That means:

- a versioned grammar (`GET /api/health` already reports `soundline/v0` for exactly this
  reason), with a migration path for recipes written against an older version;
- the invariant tables settled — including the `helicopter` question, which should be
  decided by benchmark data about how often honest recipes hit the same rule, not by
  argument about one recipe;
- published packages, so `@txt2sfx/core` can be a dependency rather than a workspace;
- an export budget story that holds for three- and four-layer sounds, or an explicit
  decision that 1 KB was the wrong number.

## Not planned

- **Cloud text-to-audio models in the core.** No Stable Audio, no ElevenLabs. The output is
  code, and a model that returns audio cannot produce code. A local generator that runs on
  the user's own machine is a different question and stays open.
- **Hosting anyone's key.** The LLM is the user's, always.
- **A visual node editor.** The text *is* the interface; it is what a model writes, what a
  diff shows, and what a human edits. A canvas would need a second source of truth.
