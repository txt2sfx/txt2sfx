/**
 * The paste-in prompt: how a coding agent teaches itself to drive this
 * toolchain, in one message a human copies out of the playground or out of
 * `txt2sfx-bridge doctor`.
 *
 * Every other prompt in this package is spoken to a model that has already
 * been handed the contract. This one is spoken to a model that has nothing —
 * no tools, no grammar, possibly no bridge on the machine yet — so it is
 * written to survive being read once, cold, by a client we do not control.
 * Three consequences:
 *
 * 1. **Both doors are shown, in order of preference.** MCP is better (twelve
 *    tools with schemas, in the client's own tool list) but costs a restart no
 *    prompt can perform; the HTTP door costs nothing and works in the same
 *    turn. An agent that cannot restart itself must not read this and stop.
 *    Within the first door, the two clients that install a server with one
 *    shell command get that command, and the two that want a file get the file
 *    — an agent handed only the generic JSON has to guess where its own client
 *    keeps it, and guesses at config paths are silent failures.
 * 2. **It says what not to do.** "Call `sfx_contract` first" and "never ask me
 *    for an API key" are the two failure modes worth spending words on: a model
 *    that guesses at soundline writes plausible nonsense, and a model that has
 *    met other audio tools will ask for a key that does not exist here.
 * 3. **The shell is not assumed.** Both the POSIX and the Windows form of the
 *    token path appear, because the agent reading this is as likely to be in
 *    PowerShell as in bash and guessing wrong wastes its first tool call.
 *
 * One source, two consumers — the playground's bridge dialog and the CLI's
 * doctor — so the instructions a user copies cannot depend on where they
 * copied them from.
 *
 * @packageDocumentation
 */

/** Options of {@link bridgeOnboardingPrompt}. */
export interface BridgeOnboardingOptions {
  /** Port the bridge listens on. Default 4455. */
  readonly port?: number;
  /** Where the playground is served, for the "I am listening here" line. */
  readonly playgroundUrl?: string;
  /**
   * What the human wants made, woven into step 2 so the agent has a task and
   * not just a setup. Omitted, the prompt asks for a sound that exercises every
   * stage without being anyone's real requirement.
   */
  readonly task?: string;
}

const DEFAULT_PORT = 4455;
const DEFAULT_PLAYGROUND = 'http://localhost:5173';
const DEFAULT_TASK = 'a short, wet bubble pop';

/**
 * The prompt, ready to paste into Claude Code, Codex, Cursor or anything else
 * that can run a shell command.
 *
 * Deliberately plain text: it is going into a chat box, and a fenced block
 * pasted into a fenced block is how instructions arrive mangled.
 */
export function bridgeOnboardingPrompt(options: BridgeOnboardingOptions = {}): string {
  const port = options.port ?? DEFAULT_PORT;
  const playground = options.playgroundUrl ?? DEFAULT_PLAYGROUND;
  const task = options.task ?? DEFAULT_TASK;
  const base = `http://127.0.0.1:${String(port)}`;
  /* `--port` only when it is not the default: an argument that restates a
     default is one more thing for the agent to mistype. */
  const args = ['-y', 'txt2sfx-bridge', '--stdio', ...(port === DEFAULT_PORT ? [] : ['--port', String(port)])];
  const argv = `npx ${args.join(' ')}`;

  return `Set up txt2sfx and use it to make me a sound.

txt2sfx turns a description into a few hundred bytes of procedural Web Audio code, via a
text format called soundline. A local daemon — txt2sfx-bridge, published to npm, nothing
hosted by anyone — gives you a validator, a renderer and a browser tab that plays the
result out loud for me. There is no API key anywhere in this: you already hold the model,
so never ask me for a key.

Get access one of these two ways. Prefer the first; use the second if you cannot be restarted.

A. MCP — twelve tools with schemas, in your own tool list.
   Claude Code:  claude mcp add txt2sfx -- ${argv}
   Codex:        codex mcp add txt2sfx -- ${argv}
   opencode:     no add command; put this in opencode.json (project, or ~/.config/opencode/)
                 "mcp": { "txt2sfx": { "type": "local", "command": ${JSON.stringify(['npx', ...args])}, "enabled": true } }
   Cursor, and anything else that speaks MCP: ~/.cursor/mcp.json, or wherever your
                 client keeps its servers —
                 "mcpServers": { "txt2sfx": { "command": "npx", "args": ${JSON.stringify(args)} } }
   Registering is the whole install: the client launches the bridge itself, so there is
   nothing to start first. Then tell me to restart you — no client re-reads its MCP
   config while running.

B. HTTP — no restart, works this turn.
   Start the daemon in the background:  npx -y txt2sfx-bridge${port === DEFAULT_PORT ? '' : ` --port ${String(port)}`}
   Read the token from ~/.txt2sfx/bridge.json (Windows: %USERPROFILE%\\.txt2sfx\\bridge.json).
   Every tool is a route, and both need the header \`x-txt2sfx-token: <token>\`:
     GET  ${base}/tools             the same twelve, with their JSON schemas
     POST ${base}/tools/<name>      body is the tool's arguments as JSON
   The answer is always {"ok": <boolean>, "text": "<what the tool told you>"}. Read the
   text — it is written for you, and on ok:false it names the fix. ${base}/health
   needs no token and says what is listening and what can render.

Then, whichever door you came through:

1. Call sfx_contract first, before writing a single line of soundline. It returns the
   whole grammar, every parameter table and worked examples in one call. Do not guess
   the syntax — the validator is strict and the contract is why it can be.
2. Design ${task}. Run sfx_validate after every edit (it is free and offline), then
   sfx_render to measure what the text cannot predict: peak, clipping, real duration,
   export size.
3. Call sfx_audition so I hear it — I have the playground open at ${playground} — and
   sfx_open to hand it to me when it is worth my time. If a number is one you were
   unsure of, write it as ~value[min..max] and let sfx_fit search it.

Report what the renderer resolved to before you start designing: a connected playground
tab, the optional native module, or nothing. It changes what you can do.`;
}
