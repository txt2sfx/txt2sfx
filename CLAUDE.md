# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Text → **compact procedural Web Audio code** (300–1000 B typical, zero deps), not an audio file. The unit of exchange is `soundline`, a text DSL: an LLM writes it, a deterministic validator checks it against the physics of the category it claims, a renderer measures it, and a numerical optimizer fits every number marked `~value[min..max]`.

Four principles that are valid arguments in review (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)): scripts enforce and the model judges; spec-first, fail fast (never repair generated JS — repair the soundline and regenerate); structure and numbers are separate; the output is readable, diffable text.

## Environment

`pnpm` **is** on PATH on this machine — 10.11.0, installed globally with npm. Run every command
below as plain `pnpm …`. This paragraph used to say the opposite and to require `corepack pnpm`;
that stopped being true when this machine went to Node 25, which no longer ships Corepack at all,
so `corepack pnpm test` now fails with "corepack is not recognized".

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
| add a NeurosLoop lane | a row in `LANES` (`apps/web/src/lib/loop.ts`), a family in `loop-voice.ts` if it is new, a row in `LANE_MESSAGE` for the seeded path with its `loop.msg.<lane>` string in `locales/en.ts`, a role in `LANE_ROLE` (`lib/loop-agent.ts`), and a General MIDI program in `PROGRAM` (`lib/loop-export.ts`) — a lane with no program exports as a piano. `test/loop.test.ts` fails on a missing caption or program. The model's lane table is *generated* from `LANES` — never write one into the prompt. |
| add a scoreline rule | append to `SCORE_RULES` (`apps/web/src/lib/score.ts`) and enforce it in `validateScore`. Stable `rule` id, `hint` phrased as an imperative — same contract as `INVARIANTS`, same reason. |
| reach a new host from the playground | nothing, and that is the point: `plugins/pwa.ts` intercepts same-origin `GET`s and the two font origins, so a new endpoint is on the network by default. Never widen it to a host that answers with anything user-specific. A **new lazily loaded chunk** likewise needs nothing — it lands in the runtime cache on first use rather than in the 800 KB install. |
| add a NeurosLoop prompt fragment | a row in `LOOP_TAGS` (`apps/web/src/lib/loop.ts`). Its `phrase` must be words the keyword table in the same file already reads, or add a row to `WORDS` — a fragment that only changes the seed is a chip that looks broken with no model attached, and `test/loop.test.ts` fails on one. The palette numbers beside it are hints, never settings. |

`test/docs.test.ts` also pins README wording (the honest size claim, the honesty-about-limits section) and checks every relative doc link resolves. If a change moves a measured number in `docs/`, update it in the same commit.

## Conventions specific to this repo

- **Explain the number.** A threshold, weight or default range says where it came from and what was measured. `0.08` is a mystery in six months.
- **Errors have two readers**, a human and a model in a repair loop: rule id, what was written, what is required, an imperative fix. Never "invalid input".
- **Comment *why*, not *what*.** When you reject the obvious approach, write down what you rejected — several files carry that as a header block.
- TypeScript strict, no `any` in public APIs, exported types carry TSDoc. Each package has exactly one public entry point (`src/index.ts`).
- **`localStorage` in the playground holds preferences and unsaved work, never a secret.** State lives in React state and a recipe someone decided to keep goes through `examples/` or the bank's API — but the recipes a tab generated and has not saved yet are persisted (`apps/web/src/lib/session.ts`), because they exist nowhere else and a reload used to cost a model call plus a whole fit per recipe. A pasted key never goes there: it lives in tab memory, travels only in requests the user started, and once it has answered a run it is encrypted under a non-extractable `CryptoKey` in IndexedDB (`apps/web/src/lib/keystore.ts` documents what that does and does not protect against). That happens without a checkbox, so every surface holding a key prints where it is kept and offers **forget it** beside the field. The Stable Audio repo id is stored openly because it is not a credential.
- Secrets come from the environment or the caller, never a checked-in file. See `.env.example`. The playground does **not** read env keys.
- `.plans/txt2sfx-v0.md` (Russian) is the project's memory: phase status, deviations from the original design, open questions. Substantive changes belong there.

## Known, deliberate exceptions

- `examples/helicopter.soundline` knowingly breaks a duration invariant — its rotor *is* a delay line with high feedback. It is seeded with the error reported rather than hidden, and few-shot selection prefers recipes that validate. This is why the CI seed step is not `--strict`.
- `codegen`'s 1 KB `withinBudget` is a **report, not a gate**. Three- and four-layer recipes exceed it because procedural buffer generators are a fixed cost; the compiler always emits working code and says what it cost.
- `renderSound` reports clipping and never normalizes — normalization would hide the problem where it can still be fixed in the spec.
- Dev-only instruments that must not reach a static build: the devtools `bridge` provider (`apps/web/src/lib/bridge.ts`, installed on `window` only under `vite dev`), the Stable Audio endpoint (`apps/web/plugins/stable-audio.ts`, `apply: 'serve'`) and the General MIDI bank preview (`apps/web/plugins/gm-bank.ts` + `apps/web/src/lib/gm.ts`, behind `import.meta.env.DEV`). The Stable Audio one drives an already-provisioned Python venv — see [test/stable-audio/README.md](test/stable-audio/README.md) — and provisions nothing itself; the GM one reads a bank already on the machine (`gm.dls` on Windows, or `TXT2SFX_GM_BANK`) and must never have one committed beside it. **A sample bank can never be what plays or exports** — that would make "a loop ships as code, no sample data" false. Where a bank legitimately belongs is the program changes of the exported MIDI (`PROGRAM` in `lib/loop-export.ts`); the preview exists only so the synthesized instruments can be A/B'd against one by ear.

## The public bank

`apps/server` is deployed to **https://txt2sfx.pix3.dev** by
[`.github/workflows/deploy-server.yml`](.github/workflows/deploy-server.yml), which fires
only on a push to `main` touching the server or a package it links against (`shared`,
`core`, `analyzer`, `agent`). It repeats the whole gate, SSHes in, runs
`/srv/txt2sfx/deploy.sh <sha>` and polls `/api/health`. There is no manual step, and
[`apps/server/deploy/README.md`](apps/server/deploy/README.md) is the host preparation and
the backup and moderation procedures.

Three things about that server are easy to undo by accident:

- **It renders what it stores.** `node-web-audio-api` is a *dependency* of `apps/server`,
  not a devDependency, and `POST /api/recipes` measures the profile rather than believing
  the body. That is the anti-spam mechanism, not a detail — `render.ts` says why.
- **Reading is anonymous; writing needs a session**, carried as a bearer token and never a
  cookie. That is what lets CORS stay `origin: true`, which is the property the whole bank
  exists for.
- **Solo mode refuses a non-loopback bind.** With no GitHub app configured every write is
  attributed to a built-in `local` account, and serving that publicly is not a state
  anybody chooses on purpose.

## Releasing `txt2sfx-bridge`

Triggered by any request to publish, release or ship an update to the bridge — "опубликуй
обновление", "выпусти новую версию", "release the bridge". `packages/bridge` is the only
package in this repository that reaches a registry.

There is no manual publish step. Pushing a `bridge-v*` tag is what publishes, via
[`.github/workflows/publish-bridge.yml`](.github/workflows/publish-bridge.yml), which
authenticates with npm trusted publishing — no token exists to publish with by hand, and
a hand publish would land without a provenance attestation. `0.1.0` is already on the
registry that way; do not add to it.

### The procedure

1. **Pick the bump.** If the user did not say patch, minor or major, infer it from what
   changed since the last release and state the choice — do not ask unless the change
   genuinely reads both ways.

2. **Edit the version in two places.** They must agree or `test/hygiene.test.ts` fails:

   - `packages/bridge/package.json` → `version`
   - `packages/bridge/src/version.ts` → `VERSION`

   The constant exists because the shipped bundle is one file with no `package.json`
   beside it, so the version cannot be read from disk at runtime. This is the step that
   gets forgotten.

3. **Check the version is free.** `npm view txt2sfx-bridge@<version> version` must 404.
   Published versions are immutable; a wrong tag cannot be taken back, only superseded.

4. **Run the gates locally**: `corepack pnpm typecheck` and `corepack pnpm test`. The
   workflow runs them too, but a failure there leaves a tag pointing at a commit that can
   never be released under that version.

5. **Commit only the release.** The working tree usually carries unrelated work in
   progress — stage `packages/bridge/package.json` and `packages/bridge/src/version.ts`
   by name. Never `git add -A` for a release.

6. **Push the commit to `main`, then the tag.** The tag must name the same version as the
   manifest, prefixed exactly `bridge-v`, and must point at a commit that is already on
   the remote:

   ```
   git commit -m "release: txt2sfx-bridge <version>" packages/bridge/package.json packages/bridge/src/version.ts
   git push origin main
   git tag bridge-v<version>
   git push origin bridge-v<version>
   ```

7. **Report, do not assume.** Publishing happens in CI and takes minutes. Give the user
   the run URL (`gh run list --workflow publish-bridge.yml`) and say the release is in
   flight. Only call it published after the workflow's own attestation check has passed.

### If it fails

A failed run before the publish step can be fixed and the tag moved. A failed run *after*
the publish step cannot: that version is spent. Bump again and tag again rather than
retrying the same number.

### What not to touch without updating npm

The trusted publisher on npm is configured against this repository **and the filename**
`publish-bridge.yml`. Renaming or moving that workflow, or publishing from a different
one, breaks releases until the package's npm settings are changed to match.
