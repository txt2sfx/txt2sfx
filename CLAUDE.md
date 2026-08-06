# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Text → **compact procedural Web Audio code** (300–1000 B typical, zero deps), not an audio file. The unit of exchange is `soundline`, a text DSL: an LLM writes it, a deterministic validator checks it against the physics of the category it claims, a renderer measures it, and a numerical optimizer fits every number marked `~value[min..max]`.

Four principles that are valid arguments in review (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)): scripts enforce and the model judges; spec-first, fail fast (never repair generated JS — repair the soundline and regenerate); structure and numbers are separate; the output is readable, diffable text.

## Commands

pnpm workspace. Node **22.16+ or 24+** — the lower bound is `node:sqlite` needing SQLite built with FTS5 (missing in 22.5–22.15 and all of 23.x); the server probes at startup and says so.

```powershell
npm install -g pnpm@10        # corepack is gone from Node 25
pnpm install
pnpm test                     # vitest, whole repo (~19 s; optimizer e2e is thousands of renders)
pnpm test:watch
pnpm typecheck                # sources + tests + playground — this is the lint (see below)
pnpm dev                      # playground on http://localhost:5173
pnpm build                    # tsc -b for packages + server; NOT needed for tests
pnpm build:web
pnpm bench                    # scripted model, no key, reproducible
pnpm bench -- --provider gemini --strict
pnpm --filter @txt2sfx/server seed    # renders examples/ into the SQLite bank
pnpm --filter @txt2sfx/server start   # http://127.0.0.1:8787
```

Single test file / single test:

```powershell
pnpm vitest run packages/core/test/parser.test.ts
pnpm vitest run packages/optimizer -t "recovers scrambled slots"
```

**There is no separate linter, on purpose.** TypeScript runs with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, and `tsconfig.test.json` type-checks tests as well as sources (a test that fails to type usually still runs). `pnpm typecheck` + `pnpm test` is the whole gate, same as CI.

**Tests and the playground run straight off TypeScript sources.** Both `vitest.config.ts` and `apps/web/vite.config.ts` alias `@txt2sfx/*` to each package's `src/index.ts`, so a change in `shared` is instantly visible everywhere and no stale `dist/` can pass. `pnpm build` exists for the server and the published export, not for the test loop.

## Architecture: the load-bearing decisions

**One DSP, two players.** `compile/ir.ts` defines `AudioIR` — a description of the graph independent of sample rate and of whether an audio stack exists. Primitives emit IR; `compile/graph.ts` (live `AudioNode`s) and `compile/codegen.ts` (printed JS) are dumb players of it. This is why the parity test can demand *byte-identical* renders rather than "RMS within tolerance", and why the export can be trusted. A second implementation of any primitive breaks it.

- `PrimitiveDef.build(args, ctx)` gets a `BuildContext` (`ir`, `seed`, `start`, `stop`) — never an `AudioContext`.
- IR times are seconds **relative to the sound's onset**; the backend adds the `when` offset, because the exported function takes it as an argument.
- `quantizeIR` rounds every number to six decimals **once, before both backends fork**. Not cosmetic: rounding after the fork shifts buffer lengths and therefore every sample.

**No audio stack below `apps/`.** `core` takes an `OfflineAudioContext` factory; the optimizer and the agent take a render function. That injection is what lets the same code run in Node, a browser tab and a test. The audio stack appears only in test helpers, the seeder and the bench.

**Anything holding samples longer than its `OfflineAudioContext` must copy them.** `getChannelData` returns a view into memory the native context owns; hold it across a few hundred renders and samples silently turn to NaN, then the process dies with no JS stack. `Float32Array.from(...)` on the way out.

**Numbers are stored as written**; conversions happen at the point of use. This is what makes `serialize(parse(src)) === src` hold byte for byte. `.gitattributes` forces LF for the same reason — without it the round-trip tests fail on Windows.

**Zero runtime dependencies** in `shared`, `core`, `analyzer`, `optimizer`, `agent` — the FFT, WAV encoder, differential evolution and HTTP providers are local on purpose. Dependencies belong in `apps/` (Fastify, React, Vite) or devDependencies.

### The agent loop (`packages/agent/src/loop.ts`)

Ordered stages, each reporting only what the model can act on: parse → validate (invariant `hint` fields go back verbatim as instructions) → render (peak and near-silence cannot be derived from text) → fit numbers.

The hard rule: **the model is asked for a structural change only when the optimizer is stuck** — `de.stopped === 'stalled'`, or a recipe with no `~` slots at all. A search that merely ran out of generations while still improving returns `outcome: 'distance'`; asking for a rewrite would discard what the search found.

With no target there is no distance to minimize, and a recipe is accepted as soon as it parses, validates and renders to something audible.

### The optimizer (`packages/optimizer`)

Differential evolution over `~value[min..max]` slots. Candidates are **text**, not ASTs: values are written back into the source at each literal's span and re-parsed, so the measured candidate is exactly the writable candidate (`slots.ts` explains all three reasons). The search runs in a unit cube mapped through the same logarithmic curve as the playground's sliders, because frequency and time are perceived as ratios.

The metric is scale-normalized and onset-aligned, so it cannot distinguish "this sound, closer" from "a different sound that scores well". The fit is therefore held to the model's design via `anchor` / `initialSpread`, and `generation` events carry a playable `source` so a search walking away from the intended sound is *audible*, not just a healthy-looking curve.

## Extension points

| You want to | Do this |
| --- | --- |
| add a primitive or effect | a `Signature` in `core/src/grammar/signatures.ts` plus a def that emits IR. Parser, serializer, contract document and generated tables all follow from the signature — never hand-write a table. Then add a row to `docs/PRIMITIVES.md` or `test/docs.test.ts` fails. |
| add an invariant | append a rule to `INVARIANTS` (it is an array for this reason). Stable `rule` id; `hint` phrased as an imperative instruction. |
| change the fitness | `analyzer/distance.ts`; weights are named constants. |
| add a model vendor | implement `LLMProvider` (one method) in `packages/agent`. Document the API version the request shape was written against and pin it in a test with an injected `fetch`. |
| add a reference recipe | a file in `examples/` in canonical form (`serialize` decides), plus prompt and tags in the seeder's table. Several tests count the examples; `docs/ACOUSTIC_PROFILE.md` needs a `\| name \|` row. |
| add a bench target | [bench/README.md](bench/README.md). Single-attempt targets must contain `~` slots; multi-attempt ones must actually differ between attempts — both enforced by tests. |

`test/docs.test.ts` also pins README wording (the honest size claim, the honesty-about-limits section) and checks every relative doc link resolves. If a change moves a measured number in `docs/`, update it in the same commit.

## Conventions specific to this repo

- **Explain the number.** A threshold, weight or default range says where it came from and what was measured. `0.08` is a mystery in six months.
- **Errors have two readers**, a human and a model in a repair loop: rule id, what was written, what is required, an imperative fix. Never "invalid input".
- **Comment *why*, not *what*.** When you reject the obvious approach, write down what you rejected — several files carry that as a header block.
- TypeScript strict, no `any` in public APIs, exported types carry TSDoc. Each package has exactly one public entry point (`src/index.ts`).
- **No `localStorage` in the playground.** State lives in React state; persistence goes through the bank's API. A pasted key lives in tab memory and travels only in requests the user started (`apps/web/src/lib/keystore.ts` documents what "remember" does and does not protect against). The one exception is the Stable Audio repo id, which is not a credential.
- Secrets come from the environment or the caller, never a checked-in file. See `.env.example`. The playground does **not** read env keys.
- `.plans/txt2sfx-v0.md` (Russian) is the project's memory: phase status, deviations from the original design, open questions. Substantive changes belong there.

## Known, deliberate exceptions

- `examples/helicopter.soundline` knowingly breaks a duration invariant — its rotor *is* a delay line with high feedback. It is seeded with the error reported rather than hidden, and few-shot selection prefers recipes that validate. This is why the CI seed step is not `--strict`.
- `codegen`'s 1 KB `withinBudget` is a **report, not a gate**. Three- and four-layer recipes exceed it because procedural buffer generators are a fixed cost; the compiler always emits working code and says what it cost.
- `renderSound` reports clipping and never normalizes — normalization would hide the problem where it can still be fixed in the spec.
- Dev-only instruments that must not reach a static build: the devtools `bridge` provider (`apps/web/src/lib/bridge.ts`, installed on `window` only under `vite dev`) and the Stable Audio endpoint (`apps/web/plugins/stable-audio.ts`, `apply: 'serve'`). The latter drives an already-provisioned Python venv — see [test/stable-audio/README.md](test/stable-audio/README.md) — and provisions nothing itself.
