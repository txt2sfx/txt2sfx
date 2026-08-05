# txt2sfx

**Text-to-SFX as code. Sounds that weigh bytes, not megabytes.**

Describe a sound effect in words, get back a compact procedural Web Audio
function — 300–1000 bytes for a typical SFX, zero dependencies — instead of an
audio file.

```
# Game bubble pop, matched against a reference recording: a ~25 ms burst that
# peaks near 1.1 kHz and decays about 1.2 dB per millisecond.
# The pitch RISES — a collapsing cavity's resonance climbs as it shrinks, and
# sweeping it downwards instead is what turns a pop into a dull thud.
sound "bubble pop" 55ms pop
  body: tone tri ~700Hz[500..1400] -> 1120Hz in 14ms >> lp ~2200Hz[900..4000] Q1 | gain 0.8 hold 3ms decay 38ms
  edge: click 1ms >> bp ~2800Hz[1200..6000] Q1 | gain 0.38 attack 0ms decay 6ms
```

That text — the `soundline` DSL — is the source of truth. Everything else
(the live audio graph, the exported vanilla-JS function, the WAV) is compiled
from it, and every number the model is unsure about is written as an
optimizable slot `~value[min..max]` for a numerical optimizer to nail down.

> **Status: early work in progress.** Done so far: the DSL (lexer, parser,
> byte-stable serializer), the synthesis engine (8 primitives, 6 effects,
> offline render, JS export that renders sample-identically to the live graph),
> the physical-invariant validator, the acoustic analyzer (own FFT, profiles,
> distance metrics, human-readable diffs), the differential-evolution optimizer
> that fits `~` slots to a target sound, the recipe bank server, and a local web
> playground — editor, slot sliders, spectrogram, WAV/JS export, and a
> compare-against-reference panel. Still ahead: the LLM agent loop.
> The full plan lives in
> [`.plans/txt2sfx-v0.md`](.plans/txt2sfx-v0.md); this README is replaced by
> the real one in the last phase.

## Quick start

```bash
npm install -g pnpm@10   # corepack is gone from Node 25
pnpm install
pnpm test                # 462 tests: DSL, synthesis, codegen parity, validator, analyzer, optimizer, bank
pnpm build
pnpm dev                 # playground on http://localhost:5173
```

The recipe bank is a separate process, and an outside agent can use it without
cloning anything:

```bash
pnpm --filter @txt2sfx/server seed    # renders examples/ into a SQLite bank
pnpm --filter @txt2sfx/server start   # http://127.0.0.1:8787
curl http://127.0.0.1:8787/api/llms.txt
```

`GET /api/llms.txt` is the whole contract in one request — grammar, primitive and
effect tables, per-category physical limits, and few-shot recipes — generated from
the same tables the parser and validator use, so it cannot drift from what they
accept. There is no native dependency to compile — the bank uses Node's built-in
`node:sqlite`. It needs a Node whose SQLite was built with FTS5, which means
22.16+, none of 23.x, or 24+; the server checks on startup and says so.

```ts
import { codegen, parse, renderSound, serialize, validate } from '@txt2sfx/core';

const ast = parse('sound "pop" 35ms pop\n  body: tone sine 480Hz | gain 0.9 decay 30ms\n');
serialize(ast);        // canonical, byte-stable soundline
validate(ast);         // physical invariants, each with a fix phrased for a model
codegen(ast).code;     // a self-contained (ctx, when) => void
await renderSound(ast, { context });   // { buffer, ir, peak, clipped, durationMs }
```

`renderSound` needs an `OfflineAudioContext` factory: the browser provides one,
and in Node it is injected from `node-web-audio-api` (a workspace
devDependency — the core packages themselves stay dependency-free).

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/shared` | Types and physical limits per sound category. Zero deps. |
| `packages/core` | DSL (lexer, parser, serializer), validator, primitives, compiler, IR, render, JS codegen. Zero deps. |
| `packages/analyzer` | FFT, acoustic profiles, distance metrics, human-readable diffs. Zero deps. |
| `packages/optimizer` | Differential evolution over a recipe's `~value[min..max]` slots. Zero deps. |
| `apps/web` | Vite + React playground: edit, hear, measure, compare, export. |
| `apps/server` | Recipe bank: SQLite + FTS5 behind a small REST API, plus `/api/llms.txt`. |
| `examples/` | Ten reference recipes, also used to seed the recipe bank. |
| `.plans/` | The v0 build plan, phase by phase. |

## Export size

Both DSP backends — the live graph and the exported JS — are printed from one
intermediate representation, so the export is not a reimplementation and
renders byte-identically to what you hear. The price is a fixed prelude: the
procedural buffer generators that let the project ship no assets at all. Two
layer recipes land at 531–824 bytes; three- and four-layer ones run 1.1–1.7 KB.
The compiler always emits complete working code and reports what it cost
instead of silently truncating.

## Honesty about limits

Procedural synthesis is strong at SFX — impacts, clicks, zaps, UI feedback,
sci-fi — and weak at organic sound: voice, believable animals, complex
real-world textures. txt2sfx aims squarely at the first group and will keep
saying so.

## License

[Apache-2.0](LICENSE)
