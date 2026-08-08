# The agent bridge

`txt2sfx-bridge` is a local daemon that puts an outside coding agent — Claude Code, Codex,
Cursor, anything that speaks MCP — into the same room as the playground. It publishes to
npm and needs no install:

```powershell
npx txt2sfx-bridge            # daemon on 127.0.0.1:4455
npx txt2sfx-bridge --stdio    # MCP server, for a client's config file
npx txt2sfx-bridge claude     # the local Claude Code CLI answers the playground's Generate
npx txt2sfx-bridge doctor     # what is listening, what can render, what is paired
```

Nothing about it is hosted by us and nothing leaves the machine. It binds loopback, and
the one non-loopback thing it can reach — the recipe bank — is a URL the user typed.

It is also how the playground gets a **reference render**: the daemon carries the
installer for Stable Audio Open Small and drives it, so the Model tab works for someone
who has never cloned this repository. See [the reference model](#the-reference-model).

## Getting an agent attached, in one paste

`bridgeOnboardingPrompt` (in `@txt2sfx/agent`) is the text a human copies from the
playground's bridge dialog or from `doctor`, and pastes into their agent. It tells the
agent to register the MCP server itself — one command for Claude Code and Codex, the
config file for opencode (key `mcp`, `type: "local"`) and Cursor (key `mcpServers`),
because an agent handed only the generic JSON has to guess where its own client keeps
servers, and a guess at a config path fails silently. Then, because **no prompt can
restart the client that is running it**, it gives the second door as the fallback: read
the token, `POST /tools/<name>`, work in the same turn. Both consumers import the one
function, so the instructions cannot differ by where they were copied from.

Registering is the whole install, in every one of those recipes: `--stdio` opens the
port itself, so there is no daemon to start first and no second step to forget. `npx
txt2sfx-bridge` by hand is for a bridge that should outlive the client.

That restart is the whole reason the HTTP tool routes exist. MCP is the better door —
the client gets names, descriptions and schemas in its own tool list — but "paste this
and go" is the only onboarding most people will ever attempt, and it cannot include a
restart.

## Why a daemon and not just an MCP server

Three participants, and no two of them can address each other directly:

| | has | cannot |
| --- | --- | --- |
| the **playground** (a browser tab) | `AudioContext`, the pictures, a human's ears | be listened to on a port |
| the **agent** (an MCP client) | a language model, the user's intent | make a sound |
| the **bridge** (a Node process) | a port, the filesystem, `@txt2sfx/core` | hear anything, or write soundline |

An MCP server speaks stdio to exactly one client and cannot be reached by a page. A page
cannot be dialled by a stdio process. So the daemon is the switchboard: the tab connects
out to it over a WebSocket, the MCP process connects out to it over loopback HTTP, and
every call is relayed. `--stdio` with no daemon running starts an in-process hub, so an
agent that only wants to design and measure sounds needs one process, not two.

## The two directions, and why both exist

**Agent → playground.** The agent writes soundline and calls `sfx_render` to be told what
it measured, `sfx_audition` to make the tab play it out loud, `sfx_compare` to be given
the same numbers the optimizer minimizes. This is the direction that matters most, and
the reason is that *the agent is the model*. There is no key, no provider, no second
LLM in the loop: a coding agent already holds a language model, and what it lacked was
the validator, the renderer and the ear. It gets all three and pays for none.

**Playground → agent.** The provider picker in the playground has an `agent` entry. Choose
it, press Generate, and the request — the full contract as the system prompt, the
conversation so far, the few-shot examples — is parked in the daemon. The agent picks it
up with `sfx_next_request` and answers with `sfx_answer`. Everything downstream is
untouched: extraction, validator, render, optimizer, the repair message on failure. It is
the same `Bridge` provider that used to be answered by hand in devtools, answered over a
socket instead.

Where the MCP client advertises the `sampling` capability, direction B needs no polling:
the daemon fulfils the request with `sampling/createMessage` and the human sees the recipe
appear. Where it does not — which today is most clients — the two polling tools are the
path, and the playground says so plainly instead of hanging.

### `txt2sfx-bridge claude`: the third answerer

Both of those need an agent on the other end — one that remembers to poll, or one whose
client implements a capability almost none of them do. `txt2sfx-bridge claude` removes the
agent from direction B entirely: the process collects its own parked jobs and answers each
by running the Claude Code CLI already installed on the machine. One command, no MCP
client, no config file, no restart, and it opens a bridge itself when none is listening.

The job's system prompt goes to `--system-prompt-file` and the conversation to stdin,
never to argv: the contract alone is about 12 KB and Windows caps a whole command line at
32767 characters, so a prompt in argv is a bug that only appears on someone else's
machine. Tools are disabled (`--tools ""`) because this is a completion, not an agent
session — the model is being asked for one fenced soundline block, and a permission prompt
would have nobody to answer it at the end of a pipe. What comes back is the `result` field
of `--output-format json`, checked for `is_error` as well as for the exit code, because a
refusal or a spent budget is reported as a *successful* run with the explanation in
`result` — and handing that to the playground to parse as soundline is precisely the
failure worth spending a check on.

`@anthropic-ai/claude-agent-sdk` would have been the obvious way to do this and is
deliberately not used: `packages/bridge` ships as one bundled file with zero runtime
dependencies, which is what makes `npx txt2sfx-bridge` work at all. The binary is spawned,
never imported, and everything about the exchange is tested against a scripted runner
rather than a real model.

## The tools

Twelve, in four groups. Names are prefixed because a client with six servers attached
should not have to guess whose `render` this is.

| tool | what it does |
| --- | --- |
| `sfx_contract` | the whole grammar, parameter tables, category limits and examples — about 12 KB, generated from the parser's own tables. **Call this first.** |
| `sfx_validate` | parse and validate soundline; every issue carries a `hint` phrased as an instruction |
| `sfx_render` | render and measure: peak, clipping, duration, acoustic profile, export size |
| `sfx_audition` | play it in the playground tab, out loud, and select it there |
| `sfx_compare` | metrics table and spectral distance against a reference |
| `sfx_fit` | run the differential-evolution optimizer over the recipe's `~slots` |
| `sfx_export` | write JS, WAV or soundline to a path |
| `sfx_open` | load a recipe into the Studio so a human can take over |
| `sfx_bank_search` | search the recipe bank (FTS5) |
| `sfx_bank_publish` | store a solved recipe |
| `sfx_next_request` | direction B: long-poll for a generation the playground is asking for |
| `sfx_answer` | direction B: answer it, or `fail` it |

Resources: `txt2sfx://contract` (same bytes as `sfx_contract`) and
`txt2sfx://recipe/{name}` for anything in the bank or in `examples/`.

All twelve are reachable two ways: over MCP, and over loopback HTTP at `POST
/tools/<name>` — the same `runTool` dispatch, the same `ToolContext`, the same prose
back. What the HTTP door loses is the client-side tool list: a model driving it through
`curl` must read `GET /tools` to learn the schemas, and must decide to call them from
the prompt rather than from its own tool menu.

## Rendering without a browser

`sfx_render` needs an audio stack, and `@txt2sfx/core` deliberately has none — the
offline context is a parameter (see `packages/core/src/render/offline.ts`). Three
resolutions, tried in order and reported by `/health` as `renderer`:

1. **`playground`** — a tab is connected, so the render happens there, in the same
   `OfflineAudioContext` that produced the picture the human is looking at. Preferred:
   the number the agent is told and the number on screen cannot disagree.
2. **`native`** — `node-web-audio-api` is installed (an **optional** dependency, because
   it is a native module and a `npx` that fails to install on a platform with no prebuilt
   binary would be worse than one that renders a little less).
3. **`none`** — `sfx_validate`, `sfx_contract` and the bank tools still work. Anything
   that needs samples fails with one sentence saying which of the two to fix.

## Wire protocol v1

### Playground ↔ daemon: WebSocket

`ws://127.0.0.1:4455/ws?token=<token>&role=playground`. One JSON object per text frame.

```ts
type Frame =
  | { t: 'hello';   role: 'playground'; version: 1; app: string }
  | { t: 'welcome'; version: 1; bridge: string; renderer: Renderer; agent: AgentStatus }
  | { t: 'call';    id: string; method: string; params: unknown }
  | { t: 'result';  id: string; result: unknown }
  | { t: 'error';   id: string; error: { message: string; code?: string } }
  | { t: 'event';   event: string; data: unknown }
  | { t: 'ping' } | { t: 'pong' };
```

`call` travels in both directions and `id` is unique per originator. The daemon calls
these on the playground:

| method | params | result |
| --- | --- | --- |
| `playground.state` | `{}` | `{ name, soundline, prompt, issues, peak, clipped, durationMs, bytes, seed, reference, names }` |
| `playground.audition` | `{ soundline, seed?, loop?, select? }` | `{ durationMs, peak, clipped }` |
| `playground.render` | `{ soundline, seed? }` | `{ peak, clipped, durationMs, profile, bytes, withinBudget }` |
| `playground.open` | `{ soundline, name, prompt? }` | `{ name }` |
| `playground.compare` | `{ soundline?, seed? }` | `{ metrics, reference, distance, directives }` |
| `playground.fit` | `{ soundline?, generations?, seed? }` | `{ soundline, initialDistance, distance, stopped }` |

And the playground calls these on the daemon:

| method | params | result |
| --- | --- | --- |
| `agent.complete` | `{ turn, messages, system }` | `{ text }` — parked until the agent answers |
| `agent.status` | `{}` | `{ connected, client, sampling }` |
| `model.status` | `{ repo? }` | `ModelStatus` — see below |
| `model.provision` | `{ repo?, token? }` | `{ status, torch?, device? }` — minutes, streams `model.log` |
| `model.render` | `{ prompt, seconds?, steps?, seed?, repo?, token? }` | `{ name, mime, bytes, ms, audio }` — audio is base64 |
| `model.cancel` | `{}` | `{ stopped }` — kills whichever child is running |

Events, fire and forget: `agent.attached`, `agent.detached`, `job.parked`, `job.answered`
from the daemon; `catalog` (`{ names }`) and `selection` (`{ name }`) from the playground.
`model.log` is the exception that is *not* broadcast — it goes to the socket that asked,
because an install scrolling past in a window nobody started it from is noise.

### The reference model

`model.*` is the odd one out: the only work the daemon does itself rather than passing
between two participants. It is here because the argument for the bridge is exactly the
argument for this feature — code that must run on the human's machine, reached from a
page that may be served from anywhere. Stable Audio Open Small renders the *target* a
recipe is fitted to, and the alternative to putting it behind this socket was a feature
only a repository checkout could have.

The daemon carries its own copy of the installer (`run.py` and `requirements.txt`, packed
into the published tarball), so `npx txt2sfx-bridge` needs nothing else. It writes them
to `~/.txt2sfx/stable-audio/` and works there; run from a checkout it uses
`test/stable-audio/` instead, so a venv provisioned from a terminal and one provisioned
from the Model tab are the same venv. `TXT2SFX_STABLE_AUDIO_DIR` overrides both.

```ts
type ModelStage = 'unavailable' | 'needs-python' | 'needs-venv' | 'needs-weights' | 'ready';

interface ModelStatus {
  stage: ModelStage; ready: boolean; busy: boolean; running: 'render' | 'provision' | null;
  reason?: string;                                   // phrased as the thing that fixes it
  workDir: string; script: string | null;            // where run.py and the venv live
  venv:    { path: string; present: boolean; bytes: number; torch: string | null };
  weights: { repo: string; dir: string; present: boolean; bytes: number };
  cacheDir: string;                                  // the shared Hugging Face cache
  gated: boolean; licenceUrl: string; tokensUrl: string;
  hasToken: boolean; tokenSource: 'env' | 'file' | null;
  launcher: string | null; uv: string | null; python: string | null;
  defaults: { seconds: number; steps: number; repo: string };
  renders: { file: string; bytes: number; modifiedMs: number }[];
}
```

The byte counts are **measured**, by walking those directories without following
symlinks — the Hugging Face cache hard-links each blob into a snapshot, and a walk that
followed them would report 3.4 GB for a 1.7 GB checkpoint. They are in the payload
because the Model tab is asked to show them: an install that quietly takes six gigabytes
is something people discover when a disk fills.

A `token` is used for the one call it arrives on and is never written down. It travels in
the child's environment rather than in its argv, which is echoed back in a `start` event
and is visible to every other user on the machine in the process list.

`model.render`'s `prompt` is **the caption the checkpoint reads, not the human's
request**. It conditions on t5-base with a 64-token window: English only, about 200
characters, and any other script tokenizes into `<unk>` holes — measured, in
`packages/agent/src/caption.ts`, which is where the playground turns a request in any
language into one. The daemon does not translate on the caller's behalf; it would need a
language model of its own to do it, and the caller already has one. It passes the string
through and echoes it back, so what was sent is never in doubt. `defaults.seconds` is 2,
not the model's 11 — a reference target is one sound effect, and the decode is linear in
length and is the longer half on a CPU.

There is no deadline on these calls at the hub. The child owns its own — ten minutes for
a render, two hours for an install — and a second, shorter one here would turn a slow
download into a mystery abort.

A `call` the other side does not implement comes back as an `error` with code
`unsupported`, never a dropped frame — a bridge that silently ignores a method makes a
timeout look like a hang.

### MCP side ↔ daemon: loopback HTTP

Token in `x-txt2sfx-token`. The token lives in `~/.txt2sfx/bridge.json`, mode `600`,
written by whichever process opened the port.

| method | path | body / result |
| --- | --- | --- |
| `GET` | `/health` | no token, CORS `*`, no secrets: `{ ok, version, protocol, renderer, tools, playgrounds, agent }` |
| `GET` | `/pair` | origin-checked: `{ token, protocol }` |
| `GET` | `/tools` | `{ tools: [{ name, description, inputSchema }] }` — the schemas an MCP client would have been handed |
| `POST` | `/tools/<name>` | body is the tool's arguments → `{ ok, text }` |
| `POST` | `/agent/call` | `{ method, params }` → whatever the playground returned |
| `GET` | `/agent/next?timeout=25000` | long-poll → `{ request: { id, turn, messages, system, systemBytes } }` or `{ none: true }` |
| `POST` | `/agent/answer` | `{ id, text }` → `{ ok: true }` |
| `POST` | `/agent/fail` | `{ id, message }` → `{ ok: true }` |

`GET /health` answering `{"ok":true,…}` is the one thing worth curling, and the badge in
the playground header is that request on a timer.

`POST /tools/<name>` answers `200` even when the tool fails, with `ok: false` and the
failure as `text`. This is the `isError` rule from `tools.ts` carried onto HTTP: "your
soundline does not parse" is an answer the model must read and act on, and a caller
taught that non-2xx means plumbing will retry it or discard the paragraph explaining the
fix. Status codes on this route describe the route — `401` no token, `404` no such tool,
`400` a body that is not a JSON object — never the sound.

## What this does and does not protect against

Honest, because the alternative is a security claim nobody checked:

- **Loopback only.** The listener binds `127.0.0.1`. A bridge on a laptop does not appear
  on the office network because someone ran `npx`.
- **A token, because loopback is not a boundary in a browser.** Same-origin policy does
  not apply to WebSockets, so any page you visit could open `ws://127.0.0.1:4455` if the
  socket took anonymous clients. The upgrade requires a token, and the token is only
  served by `GET /pair`, which checks `Origin` against localhost and whatever
  `--allow-origin` adds.
- **The tool routes widen nothing.** `POST /tools/<name>` takes the same token as
  `/agent/*` and answers without CORS headers, so a page cannot read a result even if it
  guessed the token; and what it can reach is what `--stdio` could already reach — the
  same dispatch, with `sfx_export`'s write boundary still `--allow-write`.
- **Any process running as you can read the token file.** That is the same trust boundary
  as your SSH keys and your npm token, and pretending otherwise would be theatre. The
  bridge does nothing a process with your uid could not already do.
- **The agent gets no key and needs none.** There is no credential in this path at all,
  which is the strongest property here: a compromised agent can make noises and write
  files you told it to write, not spend your quota.
