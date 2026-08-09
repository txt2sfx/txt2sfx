# The recipe bank API

A small REST service over SQLite: store solved sounds, search them, and hand an outside
agent everything it needs in one request.

```powershell
pnpm --filter @txt2sfx/server seed      # load examples/*.soundline into the bank
pnpm --filter @txt2sfx/server dev       # http://127.0.0.1:8787
```

Loopback by default — a recipe bank on a laptop should not appear on the office network
because someone ran `pnpm dev`. `PORT`, `HOST` and `TXT2SFX_DB` override it. The public
instance is <https://txt2sfx.pix3.dev>; [`apps/server/deploy/`](../apps/server/deploy/)
is how it runs.

**Reading needs nothing. Writing needs an account.** Every `GET` here is open to anybody
with no key, no cookie and no sign-in — that is the scenario the bank exists for, and CORS
stays `origin: true` so somebody else's agent on somebody else's page can reach it without
arrangements. Publishing, liking and commenting need a session, carried as
`Authorization: Bearer …` and never as a cookie: the browser then cannot attach a
credential to a request another page made, which is what makes open CORS safe here.

With no identity provider configured the bank runs **solo** — one built-in `local` account,
no sign-in — and refuses to bind anything but loopback in that state. That is the mode a
laptop and the test suite run in.

## Endpoints

| method | path | auth | what it does |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | liveness, recipe count, `grammar: "soundline/v0"`, schema version, auth mode, render-queue depth |
| `GET` | `/api/llms.txt` | — | the whole contract as `text/plain`: grammar, parameter tables, category limits, invariants, few-shot examples, this API |
| `GET` | `/api/recipes?q=&category=&author=&sort=&limit=` | — | search (FTS5) with filters; answers `liked` for the caller in the same request |
| `GET` | `/api/recipes/:id` | — | one recipe |
| `POST` | `/api/recipes` | session | store a solved sound — **parsed, validated and rendered before it is written** |
| `PUT` `DELETE` | `/api/recipes/:id/like` | session | like / unlike, idempotent both ways |
| `GET` | `/api/recipes/:id/comments` | — | the thread |
| `POST` | `/api/recipes/:id/comments` | session | reply, optionally with a soundline of your own |
| `POST` | `/api/reports` | session | `{ target, id, reason }` — puts something in front of a person |
| `GET` | `/api/retrieve?prompt=&k=3` | — | top-k for few-shot prompting |
| `GET` | `/api/auth/config` | — | whether this bank has a sign-in at all |
| `GET` | `/api/auth/github/start?return=` | — | begins the sign-in redirect |
| `POST` | `/api/auth/exchange` | — | trades the one-time hand-off code for a session token |
| `GET` | `/api/auth/me` | session | who you are, and what is left of today's allowances |
| `POST` | `/api/auth/signout` | session | forgets the session |
| `GET` | `/api/freesound/config` | — | whether this bank can connect a freesound.org account |
| `GET` | `/api/freesound/start?return=` | — | begins the OAuth2 redirect to freesound.org |
| `POST` | `/api/freesound/exchange` | — | trades the one-time hand-off code for the caller's own Freesound tokens |
| `POST` | `/api/freesound/refresh` | — | renews them, adding the client secret the browser cannot hold |

`/api/freesound/*` is the one place this bank acts for another service, and it is worth
being precise about how little it does. It signs two requests with a client secret and
**keeps nothing**: no row, no session, and no account is needed to use it. The tokens it
hands back belong to the person who logged in to freesound.org, and they are held in
their browser (`apps/web/src/lib/freesound-auth.ts`). That is not a stylistic choice —
Freesound's API terms forbid answering for end users who are not logged in to the
platform themselves, so a bank-held key serving visitors is not an option. Unconfigured,
`config` answers `{ enabled: false }` and the other three routes do not exist.

`/api/moderation/*` exists only when `TXT2SFX_ADMIN_TOKEN` is set, and answers 404 — not
401 — to anybody without it. An endpoint that says "unauthorized" has confirmed it exists.

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

## The chat door, and the one thing it is measured by

A chat with a web-fetch button is a client of this API and of nothing else: no shell, no
MCP, no bridge, `GET` and nothing more. It is served by two routes that already existed —
`/api/retrieve` to search and `/api/recipes/:id` to resolve a link — plus a file the
*playground* emits, `https://txt2sfx.github.io/chat.txt`, which is the instructions
(`chatOnboardingPrompt` in `packages/agent`, the same place the bridge's paste lives).

Nothing was added to this server for it, and that is the design rather than an accident.
The endpoint such a client would actually want is a `GET` that validates and renders — the
one thing a chat cannot do for itself — and it is exactly the endpoint that would hand
anonymous callers the CPU this bank spends as its anti-spam cost (see *Why the server
renders*). So the chat is told to search and to link, not to design, and it says so in the
prompt.

What it does add is a marker: the prompt asks for `&via=chat`, and the playground repeats
it when it resolves `#recipe=<id>`. Handlers read named keys and ignore the rest, so this
is zero code and changes no answer — it exists to make one line of the access log
distinguish a chat's visitor from the gallery's own reads. That number, and not an opinion,
is what should decide whether this door ever gets a `/api/check`.

## `POST /api/recipes`

Body: `{ name, prompt, soundline, tags, parentId? }`.

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
- **The profile is measured here.** The server renders the soundline and analyses the
  result; a `profile` in the body is accepted and ignored, so an older client still works.
  This is the single most load-bearing change in the whole endpoint — see below.
- **A render to silence is refused** (`422 silence`, peak below −60 dBFS). A recipe that
  makes no sound is not a recipe.
- **The write is idempotent, keyed on the canonical form.** The identity of a recipe is
  `sha256(serialize(parse(source)))`, so reformatting is not a new recipe: a repost
  returns `200` with `created: false` and costs the author nothing. A *different* sound
  under the same name is still a new recipe.
- Warnings do not block a write and are returned in `warnings`, alongside `measured`
  (peak, clipping, duration) — dropping either would lose the one chance to tell the author.

### Why the server renders

Three things at once, and only the first is about correctness:

1. **The profile cannot be forged.** It was the one field arriving on trust, and a recipe
   stored with an invented one poisons every distance computed against it later.
2. **Nothing that is not a sound can be posted.** There is no free-text field here for a
   spammer to write a message into: the name and prompt are short and searchable, and the
   body is a DSL that either compiles or is refused.
3. **A write costs real work** — not a captcha, but the thing the service is for. An honest
   author pays it once per sound; a flood pays it per attempt, behind a rate limiter that
   already said no.

The DoS surface is small by construction: the compiler caps a render at 5 s and the
validator caps layers at six, so the work per request is bounded before it starts. What is
left is pile-up, so renders queue two wide and the rate limit is spent *before* the queue.

## Likes, comments and what stops the spam

**A like is a vote in the retrieval ranking.** `recipes.rating` is not a display counter:
`/api/retrieve` orders by it and few-shot selection prefers it, so a like is the community
pointing somebody else's model at better examples. That is why it is worth defending with
an account, and why it is a `PUT`/`DELETE` on a resource rather than the old
`POST /vote {delta}` any script could loop.

**A comment carries no links.** Comment spam is an economic activity and the payload is
always a link; refusing links removes the payoff entirely and costs nothing, because the
only thing anybody here needs to point at is another recipe — `#12`, which the playground
renders as something you can press and hear. Refused with a reason rather than silently
stripped.

**A comment may be a sound.** `{ body, soundline }` — and an attached soundline is held to
exactly what a published recipe is held to: parsed, validated, rendered, refused with the
rule that refused it. The most valuable move in the system is the one a bot cannot make.

**The allowance is earned.** A token bucket per account and kind of write, refilled
continuously — "twenty a day" has to mean "not twenty at once". A new account gets a small
burst; an account whose recipes have collected likes gets two or three times that, and no
more. A 429 carries `Retry-After` and says what the allowance grows with.

**The age gate is the whole defence against industrial spam, and it is one line.** A GitHub
account must be at least 30 days old at first sign-in. Spam needs accounts in bulk and now;
an account that has to have existed for a month is not something a bulk supplier can
conjure. Everything above handles the dedicated nuisance — this handles the industry.

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
created_at, fingerprint, author_id, parent_id, hidden) plus a `recipes_fts` FTS5 index with
`content=recipes`, and `actors`, `sessions`, `likes`, `comments`, `reports`, `buckets`.

`duration_ms` is the **declared** duration from the header; the **measured** one lives in
`profile_json`. Both facts are kept and neither is lost — for `helicopter` they are 1500
and 3892, which is exactly the discrepancy the validator reports.

Four decisions worth their columns:

- **`fingerprint` is unique.** It is the canonical form's hash, so a thousand reposts under
  a thousand names are one row. The index is partial (`WHERE fingerprint <> ''`) because a
  recipe stored before the column existed, or one the parser no longer accepts, has no
  canonical form — and those must not all collide on the empty string.
- **`author_id` is nullable and stays that way.** The reference recipes have no author, and
  inventing one so the column could be `NOT NULL` would put a fictional person's name under
  ten sounds in the gallery.
- **`likes` is a table of rows and `rating` is derived from it**, recomputed inside the same
  transaction as every change. A counter incremented in place eventually disagrees with
  reality and nothing notices.
- **`hidden`, never `DELETE`.** Moderation that destroys the evidence cannot be reviewed.
  Hidden rows leave every listing, every search, `/api/retrieve` and the corpus dump.

The version lives in `PRAGMA user_version` and each migration step runs once, in a
transaction. Step 1 is the pre-social schema written with `IF NOT EXISTS` throughout, so a
database that predates all of this reports version 0 and is brought forward without losing
a recipe or a rating — which is what `schema.test.ts` asserts against a database with rows
in it, because an empty file migrating proves nothing.

## The corpus outlives the service

`pnpm --filter @txt2sfx/server dump <dir>` writes every visible recipe as a canonical
`.soundline` file plus a `bank.jsonl` index with the measured profiles, the like counts and
the attribution. Run on a timer into a public repository, it means the sounds survive this
host, the history of the bank is a git log rather than a promise, and nobody has to trust
an uptime figure. No comment, session, token or report is in it: the corpus is the sounds
and who made them.

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
