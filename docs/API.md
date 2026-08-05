# The recipe bank API

A small REST service over SQLite: store solved sounds, search them, and hand an outside
agent everything it needs in one request.

```powershell
pnpm --filter @txt2sfx/server seed      # load examples/*.soundline into the bank
pnpm --filter @txt2sfx/server dev       # http://127.0.0.1:8787
```

Loopback by default — a recipe bank on a laptop should not appear on the office network
because someone ran `pnpm dev`. `PORT`, `HOST` and `TXT2SFX_DB` override it.

CORS is open (`origin: true`) and no endpoint takes a key: the bank is public data with no
secrets in it, and locking it to one origin would block the single scenario it exists for.

## Endpoints

| method | path | what it does |
| --- | --- | --- |
| `GET` | `/api/health` | liveness, recipe count, and `grammar: "soundline/v0"` — the version of the *contract*, so a client that cached `llms.txt` knows when what it learned has moved |
| `GET` | `/api/llms.txt` | the whole contract as `text/plain`: grammar, parameter tables, category limits, invariants, few-shot examples, this API |
| `GET` | `/api/recipes?q=&category=&limit=` | search (FTS5) with filters |
| `GET` | `/api/recipes/:id` | one recipe |
| `POST` | `/api/recipes` | store a solved sound — **validated before it is written** |
| `POST` | `/api/recipes/:id/vote` | `{ "delta": 1 }` or `{ "delta": -1 }` |
| `GET` | `/api/retrieve?prompt=&k=3` | top-k for few-shot prompting |

A 404 on an unknown route points the caller at `/api/llms.txt`.

## `GET /api/llms.txt`

The entry point for someone else's agent, and the reason it exists: an agent that has to
be told the grammar over several round trips, or worse has to guess it from an OpenAPI
schema, will write soundline that does not parse and spend its budget discovering the
rules one error at a time.

About 12 KB, **generated from the same tables the parser and validator use**. It cannot
describe a primitive that does not exist or omit a parameter that does, and the tests
check that all eight primitives, all six effects and all nine categories with their
numbers appear.

The embedded examples are filtered to recipes that pass validation — see the few-shot rule
in [AGENT_LOOP.md](AGENT_LOOP.md).

## `POST /api/recipes`

Body: `{ name, prompt, soundline, profile, tags }`.

- The **soundline is parsed and validated** before anything is written. A syntax error is
  a 400 with the parser's message; a broken invariant is a 422 with every issue and its
  `hint` intact. The caller here is usually a model in a loop: a 400 that says "invalid
  request" costs it an iteration to discover what was wrong, while one that says
  `pop.max-freq-ramp … shorten the frequency ramp to 20 ms or less` is a fix it can apply
  immediately.
- **`category` and `duration_ms` are read from the soundline**, not from the body, even if
  the body supplies them. A recipe whose stored category disagrees with its own header
  would be found by the wrong searches forever, and the text is the one field that cannot
  be wrong about itself.
- **`profile` arrives on trust** — the server has no audio stack and cannot recompute it.
  It is shape-checked, because a recipe stored with a half-populated profile poisons every
  distance computed against it later and nothing downstream could explain why.
- **The write is idempotent.** An identical `(name, soundline)` returns `200` with
  `created: false` instead of inserting a twin. An agent whose request timed out sends the
  same bytes again, and two identical rows are worse than a dropped write: both are
  retrievable, both become few-shot examples, and votes split between them. A *different*
  soundline under the same name is still a new recipe.
- Warnings do not block a write and are returned in `warnings` — dropping them would lose
  the one chance to tell the author.

## `GET /api/retrieve`

FTS5 with bm25 and per-column weights (`name` 5, `tags` 3, `prompt` 1). Two details that
are load-bearing:

- The prompt is turned into an **`OR`** expression, not FTS5's default implicit `AND`. No
  recipe contains "coin", "pickup" *and* "sound" at once.
- Every token is **quoted**, because the prompt is user text and `NEAR`, `OR` and `*` are
  FTS5 operators — without quoting, searching for `near miss` is a 500.

An empty result falls back to the highest-rated recipes with `fallback: true`. The caller
needs examples of the language and has nowhere else to get them, but it must not mistake a
fallback for a match.

Retrieved recipes are **matches, not endorsements**: the bank stores what it was given, so
one may break an invariant. Filter before using them as examples.

## Schema

`recipes` (id, name, prompt, soundline, profile_json, category, tags, duration_ms, rating,
created_at) plus a `recipes_fts` FTS5 index with `content=recipes`.

`duration_ms` is the **declared** duration from the header; the **measured** one lives in
`profile_json`. Both facts are kept and neither is lost — for `helicopter` they are 1500
and 3892, which is exactly the discrepancy the validator reports.

## SQLite: `node:sqlite`, and the flag that moves

The bank uses Node's built-in `node:sqlite` rather than `better-sqlite3`. The development
machine is Windows on ARM64, where a native addon hurts most: prebuilt binaries for
win32-arm64 historically arrive last, and without them installation falls back to node-gyp
and Visual Studio. `node:sqlite` is part of the Node binary — nothing to build.

**The catch, and it is the sharp one:** the JS API being stable says nothing about whether
its SQLite was compiled with FTS5. The flag is absent in Node 22.5–22.15, present from
22.16, absent again in **all** of 23.x, and on unconditionally from 24.0. So "`node:sqlite`
exists" does not mean "this schema will start", and the failure looks like a bare
`no such module: fts5` from a `CREATE VIRTUAL TABLE` deep in startup — which reads as a
broken schema rather than a missing build flag.

Hence: `engines` is `>=22.16.0 <23 || >=24.0.0`, and `openBank` **probes FTS5 in a temp
table before applying the schema** and fails with a message naming the version and the
range. A runtime check is more reliable than any string in `engines`, which is advisory.

One tooling workaround lives in `db.ts`: `process.getBuiltinModule('node:sqlite')` instead
of a plain import. `import { DatabaseSync } from 'node:sqlite'` is correct and works under
Node, but breaks under Vite — that is, in tests — because Vite strips the `node:` prefix
before looking the name up in `module.builtinModules`, and while `sqlite` is experimental
it appears in that list *only with* the prefix. Vite then concludes there is an npm package
called `sqlite`. Upstream fixed this in vitest 3; this workspace is on vitest 2, and
`getBuiltinModule` is the documented API for exactly this situation anyway.

Escape hatch, if `node:sqlite` ever regresses: better-sqlite3 v13+ ships N-API prebuilds
in its tarball, including `prebuilds/win32-arm64.node`, with no install script — so the
"needs a toolchain" objection no longer applies to it. The decision stands (zero
dependencies against one at 17 MB), but the path back is recorded.
