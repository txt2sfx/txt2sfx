# @txt2sfx/core

The soundline DSL from [txt2sfx](https://github.com/txt2sfx/txt2sfx): lexer, parser, serializer, physical-invariant validator, the compiler to an audio IR, and the IR's two players — live Web Audio nodes and exported self-contained JavaScript. Zero runtime dependencies.

```ts
import { codegen, parse, serialize } from '@txt2sfx/core';

const ast = parse('sound "pop" 35ms pop\n  body: tone sine 480Hz | gain 0.9 decay 30ms\n');
serialize(ast);          // canonical text, byte-for-byte round-trip
codegen(ast).code;       // a self-contained (ctx, when) => void
```

No audio stack is bundled or assumed: offline rendering takes an `OfflineAudioContext` factory you provide (the browser's, or `node-web-audio-api` in Node). The DSL, its invariants and the export contract are documented in the repository's [docs/](https://github.com/txt2sfx/txt2sfx/tree/main/docs).

All `@txt2sfx/*` packages are published in lockstep from one commit — install them at one version.

Apache-2.0.
