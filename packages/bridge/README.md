# txt2sfx-bridge

Your agent already has a language model. What it lacked was a validator, a renderer and
an ear. This daemon hands it all three and pays for none: no key, no provider, no second
LLM in the loop — the coding agent you already run **is** the model, and
[txt2sfx](https://github.com/txt2sfx) is the toolchain it drives.

```powershell
npx txt2sfx-bridge            # daemon on 127.0.0.1:4455
npx txt2sfx-bridge --stdio    # MCP server, for a client's config file
npx txt2sfx-bridge claude     # the local Claude Code CLI answers the playground's Generate
npx txt2sfx-bridge doctor     # what is listening, what can render, what is paired
```

Nothing is hosted by anyone. The bridge binds loopback, and the one non-loopback thing it
can reach — the recipe bank — is a URL you typed.

## What it is for

txt2sfx turns a description of a sound effect into a few hundred bytes of procedural Web
Audio code, via a text format called `soundline`: a model designs the structure, a
validator checks it against the physics of the category it claims to be, a renderer
measures it, and a numerical optimizer fits every number the model was unsure about.

The bridge puts an MCP client — Claude Code, Codex, Cursor, anything that speaks the
protocol — into that loop. Point your agent at it and say "make me a coin pickup sound":
it reads the grammar with one call, writes soundline, is told exactly what parses, what
breaks which physical invariant and what the render actually measured, and plays the
result out loud in a browser tab for the human to judge.

## Setup

### The short way: paste a prompt at your agent

`npx txt2sfx-bridge doctor` prints a prompt written for Claude Code, Codex, opencode or
Cursor — the playground's bridge dialog has the same text behind **Copy agent prompt**.
Paste it in and the agent registers the MCP server itself, reads the contract and makes
you a sound. It also carries the no-restart fallback below, because no prompt can restart
the client that is running it.

### The direct way: register the server

Two clients install it with one command:

```powershell
claude mcp add txt2sfx -- npx -y txt2sfx-bridge --stdio     # add -s user for every project
codex mcp add txt2sfx -- npx -y txt2sfx-bridge --stdio      # writes ~/.codex/config.toml
```

opencode wants the file, under `mcp` and with `type: "local"` — `opencode.json` in the
project, or `~/.config/opencode/`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "txt2sfx": { "type": "local", "command": ["npx", "-y", "txt2sfx-bridge", "--stdio"], "enabled": true }
  }
}
```

Cursor (`~/.cursor/mcp.json`, or `.cursor/mcp.json` for one project) and most other
clients take the canonical shape:

```json
{
  "mcpServers": {
    "txt2sfx": {
      "command": "npx",
      "args": ["-y", "txt2sfx-bridge", "--stdio"]
    }
  }
}
```

Registering is the whole install: `--stdio` with no daemon running starts an in-process
hub **and opens the port**, so the client launches the bridge itself and a playground tab
opened later still finds it. Running `npx txt2sfx-bridge` first is only for a bridge that
should outlive the client — if one is already listening, `--stdio` uses it, and its
playground tabs and parked jobs are the ones you want. Every client needs a restart
afterwards; none of them re-read their server list while running.

### Claude Code the other way round: the CLI as this playground's model

Everything above points an agent at the tools. This points the playground at the agent:

```powershell
npx txt2sfx-bridge claude                 # add --model opus to choose the model
```

The bridge collects its own parked jobs and answers them by running the `claude` binary
already on your machine: `claude -p`, tools disabled, the request's own system prompt in
a file, the completion handed straight back to the tab. Pick the **agent** provider in
the playground, press Generate, and the recipe appears — everything downstream is
untouched, so extraction, the validator, the render, the optimizer and the repair turn
all run exactly as they do for a hosted model. There is still no API key here: whatever
the CLI is already logged in with answers.

It starts a bridge when none is running, so this is the entire setup — no MCP client, no
config file, no restart. Leave it running; `Ctrl+C` stops answering. This is direction B
without a polling agent, which matters because sampling is rare and pressing Generate
otherwise meant an agent that remembered to call `sfx_next_request`.

### No restart: the same tools over loopback HTTP

For an agent that can run `curl` but cannot restart itself, every tool is also a route.
The token is in `~/.txt2sfx/bridge.json` (`%USERPROFILE%\.txt2sfx\bridge.json`).

```bash
npx txt2sfx-bridge &                                    # or let --stdio open the port
TOKEN=$(node -p "require(require('os').homedir()+'/.txt2sfx/bridge.json').token")

curl -s -H "x-txt2sfx-token: $TOKEN" 127.0.0.1:4455/tools          # names + schemas
curl -s -X POST -H "x-txt2sfx-token: $TOKEN" -H 'content-type: application/json' \
     -d '{"soundline":"sound \"tick\" 45ms ui\n  body: tone sine 1800Hz | gain 0.6 decay 25ms\n"}' \
     127.0.0.1:4455/tools/sfx_validate
```

Every answer is `{ "ok": <boolean>, "text": "<what the tool said>" }`, and a tool that
fails still answers `200` — `text` is the repair instruction, not an error page. What
this door loses is the client-side tool list: the model has to be told the tools exist,
which is exactly what the pasted prompt does.

## The tools

| tool | what it does |
| --- | --- |
| `sfx_contract` | the whole grammar, parameter tables, category limits and examples — **call this first** |
| `sfx_validate` | parse and validate soundline; every issue carries a hint phrased as an instruction |
| `sfx_render` | render and measure: peak, clipping, duration, acoustic profile, export size |
| `sfx_audition` | play it in the playground tab, out loud, and select it there |
| `sfx_compare` | metrics table and spectral distance against a reference |
| `sfx_fit` | run the differential-evolution optimizer over the recipe's `~slots` |
| `sfx_export` | write JS, WAV or soundline to a path |
| `sfx_open` | load a recipe into the Studio so a human can take over |
| `sfx_bank_search` | search the recipe bank (FTS5) |
| `sfx_bank_publish` | store a solved recipe |
| `sfx_next_request` | direction B: long-poll for a generation the playground is asking for |
| `sfx_answer` | direction B: answer it, or fail it |

Resources: `txt2sfx://contract` (same bytes as `sfx_contract`) and
`txt2sfx://recipe/{name}` for anything in the bank or in `examples/`.

## The two directions

**Agent → playground.** The agent writes soundline and calls the tools. Rendering
resolves in three tiers, re-evaluated per call: a connected playground tab (preferred —
the number the agent is told and the number on the human's screen come from the same
render), then `node-web-audio-api` if it installed, then none — in which case
`sfx_validate`, `sfx_contract` and the bank tools still work and everything else fails
with one sentence naming the fix.

**Playground → agent.** The playground's provider picker has an `agent` entry. Choose it,
press Generate, and the request parks at the bridge until the agent collects it with
`sfx_next_request` and answers with `sfx_answer`. If your MCP client supports the
`sampling` capability, no polling happens at all: the bridge asks the client directly and
the human watches the recipe appear. `txt2sfx-bridge claude` is the third way to answer
those jobs and the only one that needs no agent at all — the daemon runs the `claude` CLI
itself, once per Generate.

## Honesty about limits

- **The native renderer is optional.** It is a native module; on platforms without a
  prebuilt binary it quietly fails to install and the bridge degrades rather than
  breaking `npx`. A connected playground tab always renders.
- **Sampling is rare.** Most MCP clients today do not implement `sampling/createMessage`,
  which is why the two polling tools exist. Sampling also only works when the MCP server
  owns the hub (`--stdio` with no separate daemon).
- **`claude` mode is a subprocess, and inherits everything that implies.** It drives the
  CLI you already have — its login, its rate limits, its model default, its version. The
  flags it is launched with (`--print`, `--output-format json`, `--system-prompt-file`,
  `--tools ""`) are checked against `claude --help` by a human and not by a test, so a CLI
  old enough to lack one of them fails on the first Generate with its own message about
  the flag. No dependency is added for it: the binary is spawned, never imported.
- **The threat model is loopback plus a token.** The listener binds `127.0.0.1`. The
  WebSocket requires a token because same-origin policy does not protect loopback sockets
  from hostile pages; the token is served only by `GET /pair`, which checks `Origin`
  against localhost (plus `--allow-origin`). Any process running as you can read the
  token file — the same trust boundary as your SSH keys, and pretending otherwise would
  be theatre.
- **`sfx_export` writes where you let it.** Relative paths land under the bridge's
  working directory; anything outside it is refused unless you started the bridge with
  `--allow-write <dir>`.

## Two builds, on purpose

`pnpm build` (`tsc -b`) emits `dist/*.js` and `.d.ts` for the workspace and the tests —
the modular form other packages and vitest consume. `pnpm bundle` (esbuild) emits the
single `dist/txt2sfx-bridge.mjs` that ships to npm, with the `@txt2sfx/*` workspace
packages inlined: those packages are `private: true` and unpublishable, so the bundle is
what makes `npx txt2sfx-bridge` work with **zero runtime dependencies** — the WebSocket
server and the MCP server are hand-rolled on `node:*` builtins, and the only entry in
`optionalDependencies` is the native renderer that is allowed to be absent.

Only the bundle ships. `files` names that one file, and the package advertises no `main`
or `exports`, because the modular build imports the private packages and would throw
`ERR_MODULE_NOT_FOUND` on the first import for anyone outside this repository — a
library entry that cannot be honoured is worse than none. Embedders build from source;
in-repo consumers import `../src/index.js`. Releases are cut by tagging `bridge-v<version>`,
which runs [`publish-bridge.yml`](../../.github/workflows/publish-bridge.yml): it packs,
installs the tarball into a directory that has never seen this repository, runs `doctor`
there, and only then publishes. There is no npm token anywhere — the workflow authenticates
by trusted publishing, so npm trusts *this file in this repository* rather than a secret
that could be copied out of it, and every release carries a provenance attestation linking
the published bytes to the commit that produced them. The filename is part of that trust:
rename the workflow and the release fails until npm's package settings are updated to match.

## Flags

| flag | default | what it does |
| --- | --- | --- |
| `--port <n>` | `4455` | port to serve or probe |
| `--bank <url>` | `http://127.0.0.1:8787` | recipe bank origin (also `TXT2SFX_BANK`) |
| `--allow-origin <o>` | — | extra `Origin` allowed to pair; repeatable |
| `--allow-write <dir>` | — | extra directory `sfx_export` may write into; repeatable |
| `--claude-bin <path>` | `claude` | `claude` mode: the executable (also `TXT2SFX_CLAUDE_BIN`) |
| `--model <id>` | the CLI's own | `claude` mode: model for those completions |

## License

Apache-2.0
