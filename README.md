# txt2sfx

**Text-to-SFX as code. Sounds that weigh bytes, not megabytes.**

Describe a sound effect in words, get back a compact procedural Web Audio
function — 300–1000 bytes, zero dependencies — instead of an audio file.

```
# Bubble wrap pop: a soft low body plus a bright noise snap.
sound "bubble pop" 35ms pop
  thud: tone sine 480Hz -> 80Hz in 12ms | gain 0.9 decay 30ms
  snap: noise white >> bp ~3200Hz[500..8000] Q6 | gain 0.7 decay 18ms
```

That text — the `soundline` DSL — is the source of truth. Everything else
(the live audio graph, the exported vanilla-JS function, the WAV) is compiled
from it, and every number the model is unsure about is written as an
optimizable slot `~value[min..max]` for a numerical optimizer to nail down.

> **Status: early work in progress.** Phase 1 of the v0 prototype is done —
> the DSL lexer, parser, serializer and the ten reference recipes. Synthesis,
> validation, the acoustic analyzer, the optimizer, the recipe bank, the web
> playground and the agent loop are next. The full plan lives in
> [`.plans/txt2sfx-v0.md`](.plans/txt2sfx-v0.md); this README is replaced by
> the real one in the last phase.

## Quick start

```bash
pnpm install
pnpm test     # 90 tests: round-trip, lexer, parse errors, suggestions
pnpm build
```

```ts
import { parse, serialize } from '@txt2sfx/core';

const ast = parse('sound "pop" 35ms pop\n  body: tone sine 480Hz | gain 0.9 decay 30ms\n');
console.log(serialize(ast)); // canonical, byte-stable soundline
```

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/shared` | Types and physical limits per sound category. Zero deps. |
| `packages/core` | The soundline DSL: lexer, parser, serializer, signatures. Zero deps. |
| `examples/` | Ten reference recipes, also used to seed the recipe bank. |
| `.plans/` | The v0 build plan, phase by phase. |

## Honesty about limits

Procedural synthesis is strong at SFX — impacts, clicks, zaps, UI feedback,
sci-fi — and weak at organic sound: voice, believable animals, complex
real-world textures. txt2sfx aims squarely at the first group and will keep
saying so.

## License

[Apache-2.0](LICENSE)
