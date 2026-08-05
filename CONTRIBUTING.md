# Contributing

## Setting up

```powershell
npm install -g pnpm@10     # corepack was removed from Node 25; this needs no admin rights
pnpm install
pnpm test                  # 540 tests, ~18 s (the optimizer's end-to-end tests are thousands of renders)
pnpm typecheck             # sources, tests, and the playground
```

Node 22.16+ or 24+. The lower bound is not about JavaScript features: the recipe bank uses
Node's built-in `node:sqlite`, and the FTS5 build flag is missing from 22.5–22.15 and from
all of 23.x. The server checks at startup and tells you.

Tests run straight off TypeScript sources — no build step, no stale `dist/`. `pnpm build`
exists for the server and the export, not for the tests.

## What a good change looks like here

This project keeps an unusual amount of *reasoning* in the repository, and that is the part
worth preserving. Concretely:

- **Explain the number.** A threshold, a weight, a default range: say where it came from. If
  it was measured, say what was measured. "0.08" is a mystery in six months; "0.08 — below
  this the directive is noise, measured against the ten reference recipes" is a decision
  someone can revisit.
- **Prefer a comment about *why* to a comment about *what*.** The code says what it does.
- **When you reject the obvious approach, write down what you rejected.** `docs/PRIMITIVES.md`
  has a table of four such decisions; each one saved a later reader from re-deriving it.
- **Errors are written for two readers.** Every validator issue and parser error is read by
  a human *and* by a language model in a repair loop. That means a rule id, what was
  written, what is required, and an imperative fix — not "invalid input".
- **Contested decisions get made, not deferred.** Pick, implement, and justify in a comment
  or in `docs/`. A blocked phase is worse than a decision someone later disagrees with.

## Invariants that are not negotiable without a discussion

- `shared`, `core`, `analyzer`, `optimizer` and `agent` have **zero runtime dependencies**.
  The FFT, the WAV encoder, the DE and the HTTP providers are local on purpose. Dependencies
  belong in `apps/` or in devDependencies.
- **No audio stack below `apps/`.** `core` takes an `OfflineAudioContext` factory; the
  optimizer and the agent take a render function. This is what lets the same code run in
  Node, in a browser and in a test.
- **One DSP.** Primitives emit `AudioIR`; the live graph and the code generator are dumb
  players of it. A second implementation of any primitive breaks the exact-parity test, and
  that test is the reason the export can be trusted.
- **Numbers are stored as written.** Conversions happen at the point of use. This is what
  makes `serialize(parse(src)) === src` hold byte for byte.
- **Anything holding samples longer than its `OfflineAudioContext` copies them.**
  `getChannelData` returns a view into memory the native context owns; hold it across a few
  hundred renders and the samples turn to NaN, then the process dies with no JavaScript
  stack. `Float32Array.from(...)` on the way out.
- **TypeScript strict**, no `any` in public APIs, exported types carry TSDoc.
- **`.gitattributes` forces LF.** Without it the byte-exact round-trip tests fail on Windows.
- **No `localStorage` in the playground.** State lives in React state; persistence goes
  through the bank's API. A pasted API key lives in tab memory and travels only in requests
  the user started.
- **Secrets come from the environment or from the caller**, never from a checked-in file.
  See `.env.example`.

## Adding things

| You want to | Where to start |
| --- | --- |
| add a primitive or effect | a `Signature` in `core/src/grammar/signatures.ts`, then a def that emits IR. The parser, serializer, contract document and generated tables all follow from the signature — do not hand-write a table. |
| add an invariant | append a rule to `INVARIANTS`; it is an array so that new phases can extend it. Give the issue a stable `rule` id and a `hint` phrased as an instruction. |
| add a reference recipe | a file in `examples/`, in canonical form (`serialize` decides what that is), plus a prompt and tags in the seeder's table — retrieval ranks against the prompt, so write what a person would type. Several tests count the examples; update them deliberately. |
| support another model vendor | implement `LLMProvider` in `packages/agent`: one method. Document the API version you wrote the request shape against, and add a test that pins that shape with an injected `fetch`. |
| add a bench target | see [bench/README.md](bench/README.md). A single-attempt target must contain `~` slots and a multi-attempt one must actually differ between attempts; both rules are enforced by tests. |

## Tests

- Every phase ends with a green suite. `pnpm test` is the gate.
- Prefer a test that pins a *property* over one that pins an output: "the export renders
  byte-identically to the live graph" survives a refactor that "the export is 876 bytes"
  does not. Where a magic number is worth pinning (export sizes, measured profiles), pin it
  as a regression ceiling and say so in a comment.
- A test whose only witness is a lucky seed is not a test. The optimizer's tests run several
  seeds for this reason.
- When you fix a bug, add the test that would have caught it, and describe the symptom in a
  comment — several of the nastiest ones here (a zeroed profile from an onset detector, a
  false "stalled" verdict, samples turning to NaN) look like something else entirely from the
  outside.

## Commit and review

Small commits with a reason in the message. If a change moves a measured number in `docs/`
or in the plan, update it in the same commit — a stale table is worse than no table.

The build plan in `.plans/txt2sfx-v0.md` is the project's memory: phase status, deviations
from the original design, and open questions with their deadlines. Substantive changes
belong there too.

By contributing you agree your work is licensed under [Apache-2.0](LICENSE).
