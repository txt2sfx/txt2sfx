/**
 * The paste-in prompts: how a model that has never met this toolchain teaches
 * itself to drive it, in one message a human copies somewhere.
 *
 * There are two, for two clients that share nothing.
 * {@link bridgeOnboardingPrompt} is spoken to a *coding agent* — something that
 * can run `npx`, hold twelve tools and be restarted. {@link chatOnboardingPrompt}
 * is spoken to an ordinary chat with a web-fetch button and nothing else: no
 * shell, no install, no tools but `GET`. They are separate functions rather than
 * one with a flag because almost every sentence differs, including which of them
 * is allowed to write soundline at all.
 *
 * Every other prompt in this package is spoken to a model that has already
 * been handed the contract. These two are spoken to a model that has nothing —
 * no tools, no grammar, possibly no bridge on the machine yet — so both are
 * written to survive being read once, cold, by a client we do not control.
 * For the bridge prompt that has three consequences:
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
 * copied them from. The chat prompt is not copied at all: it is *served*, at
 * `/chat.txt` on the published playground, and the thing a human pastes into
 * their chat is one line telling the model to go and read it. See
 * {@link chatOnboardingPrompt} for why that indirection is the whole point.
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

/** Options of {@link chatOnboardingPrompt}. */
export interface ChatOnboardingOptions {
  /** Origin of the recipe bank to search. Default the public one. */
  readonly bankUrl?: string;
  /** Where the playground is published — the links this model hands back. */
  readonly playgroundUrl?: string;
}

const DEFAULT_BANK = 'https://txt2sfx.pix3.dev';
const DEFAULT_SITE = 'https://txt2sfx.github.io/';

/**
 * How this channel is counted.
 *
 * The bank's handlers read named query keys and ignore everything else, so this
 * parameter costs no server code and changes no answer — it exists to make one
 * line of the access log say "a chat asked this", which is the only way to find
 * out whether this door is used at all. Deliberately not a header: the fetch
 * tools this prompt is written for cannot set one.
 */
const VIA = 'via=chat';

/**
 * The prompt for a chat that can fetch a URL and do nothing else.
 *
 * ## Why it is served rather than pasted
 *
 * The bridge prompt is copied into an agent and spent. This one is *fetched*: the
 * human pastes a single line naming a URL, and the model reads the current text
 * from it. That indirection buys the two properties this channel lives or dies by
 * — the paste is short enough that nobody weighs it against writing the sound by
 * hand, and a chat opened in six months follows today's instructions rather than
 * a snapshot frozen in somebody's message history.
 *
 * ## Why this model is told not to design
 *
 * A coding agent gets the validator, the renderer and an ear, and is asked to
 * write soundline. A chat gets none of those: it cannot hear, cannot measure and
 * cannot be told which invariant it broke. Asking it to design would produce
 * exactly what it already produces unaided — plausible Web Audio nobody has
 * listened to — and put our name on it. So its job is search and hand over, the
 * grammar is a footnote for when the bank has nothing, and the sentence that
 * matters most is the one forbidding it to claim a sound is right.
 *
 * ## The return path is text, not a link
 *
 * A playground link carries the recipe in the fragment, which never reaches a
 * server (`apps/web/src/lib/share.ts` says why that is worth having). So a model
 * handed one back cannot fetch it and will either hallucinate the contents or
 * apologise. The prompt says this outright and asks for the soundline instead —
 * which is the whole argument for the format being text in the first place.
 */
export function chatOnboardingPrompt(options: ChatOnboardingOptions = {}): string {
  const bank = (options.bankUrl ?? DEFAULT_BANK).replace(/\/+$/, '');
  const site = `${(options.playgroundUrl ?? DEFAULT_SITE).replace(/\/+$/, '')}/`;

  return `You can fetch URLs, so you can use txt2sfx to get me a real sound effect.

txt2sfx is a bank of sound effects kept as text — a few hundred bytes of a format called
soundline, which compiles to procedural Web Audio with no audio file and no dependency.
Reading it needs no key and no account, so never ask me for one.

1. Search it with my description:
     ${bank}/api/retrieve?prompt=<what+I+asked+for>&k=3&${VIA}
   Each result carries an id, a name, the prompt it was written to answer, and soundline
   — the sound itself, as text. If the answer says "fallback": true then nothing matched;
   tell me that plainly instead of offering the results as though they fit.

2. Give me the candidates as a short list — name, what it was made for, how long it is —
   and a link for each:
     ${site}#recipe=<id>
   That page plays the sound, lets me change it, and shows the Web Audio function to
   paste into what I am building. You cannot hear, so never tell me a sound is right or
   that it matches: the link is there because I am the one who can judge that.

3. When I have picked one, repeat its soundline back to me verbatim in a code block. It
   is the sound; keep it exactly, and do not tidy the numbers.

If I paste an edited soundline back at you, take it as written. If I paste a link with
#recipe= or #play= in it, do not fetch it — everything after # is a fragment and never
reaches any server — ask me for the soundline text instead.

If the bank has nothing close, say so first. Only then, and only if I ask you to write
one, fetch ${bank}/api/llms.txt — about 12 KB, one call, the whole grammar with parameter
tables and worked examples. Read it before writing a single line and do not guess the
syntax. Say plainly that a sound you wrote has been heard by nobody, including you.`;
}
