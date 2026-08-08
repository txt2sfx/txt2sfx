/**
 * The executable: `txt2sfx-bridge [doctor|claude] [--stdio] [--port N]
 * [--bank URL] [--allow-origin O]... [--allow-write DIR]...`
 *
 * Four shapes of the same process:
 *
 * - **serve** (default) — the daemon: HTTP + WS on loopback, token persisted.
 * - **`--stdio`** — an MCP server for a client's config file. If a daemon is
 *   already on the port it is used over loopback HTTP; if not, an in-process
 *   hub starts *and opens the port*, so an agent that only wants to design and
 *   measure sounds needs one process, not two — and a tab opened later still
 *   finds someone to talk to.
 * - **claude** — the other direction, standing on its own: the local Claude
 *   Code CLI answers the playground's Generate. Same hub, same parked jobs,
 *   except the thing collecting them is this process rather than an agent that
 *   has to remember to poll. Starts a bridge when none is running, for the same
 *   reason `--stdio` does — one command has to be enough.
 * - **doctor** — what is listening, what can render, what is paired, and both
 *   ways to attach an agent: the MCP config to paste into a client, and the
 *   prompt to paste into the agent itself. Doctor prints to stdout because
 *   doctor's output is for a human at a terminal; the other two log to stderr
 *   only, because in `--stdio` mode stdout belongs to JSON-RPC.
 *
 * Occupied port: `npx txt2sfx-bridge` twice must not look like a crash, so a
 * taken port is probed with `GET /health` — another bridge means "already
 * running", message, exit 0; anything else is a real conflict and exits 1.
 *
 * @packageDocumentation
 */

import { realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { bridgeOnboardingPrompt } from '@txt2sfx/agent';
import {
  CLAUDE_DEFAULT_BIN,
  ClaudeError,
  claudeCompleter,
  runClaudeWorker,
  runCommand,
} from './claude.js';
import { Hub, localToolHub, type ToolHub } from './hub.js';
import { PLAYGROUND_ORIGIN, createBridgeServer, remoteToolHub } from './http.js';
import { log } from './log.js';
import { createMcpServer } from './mcp.js';
import { PROTOCOL_VERSION, looksLikeBridge, type HealthPayload } from './protocol.js';
import {
  childEntryPath,
  createChildRenderer,
  createNativeRenderer,
  resolveRenderer,
  type ChildRenderer,
  type NativeRenderer,
} from './render.js';
import { StableAudio, formatBytes } from './stable-audio.js';
import { describeMode, ensureState, loadState, saveState, stateFilePath } from './state.js';
import { TOOL_NAMES, type ToolContext } from './tools.js';
import { VERSION } from './version.js';

/** Everything the flags can say. */
export interface CliOptions {
  readonly command: 'serve' | 'stdio' | 'claude' | 'doctor' | 'help';
  readonly port: number;
  readonly bankUrl: string;
  readonly allowOrigins: readonly string[];
  readonly allowWrite: readonly string[];
  /** `claude` mode: the executable to drive. */
  readonly claudeBin: string;
  /** `claude` mode: `--model`, or undefined to let the CLI pick its own. */
  readonly model: string | undefined;
}

const DEFAULT_PORT = 4455;
const DEFAULT_BANK = 'http://127.0.0.1:8787';

const USAGE = `txt2sfx-bridge — the local switchboard between an MCP agent and the txt2sfx playground

usage:
  txt2sfx-bridge                 start the daemon on 127.0.0.1:${String(DEFAULT_PORT)}
  txt2sfx-bridge --stdio         MCP server over stdio, for a client's config file
  txt2sfx-bridge claude          answer the playground's Generate with the local Claude Code CLI
  txt2sfx-bridge doctor          what is listening, what can render, what is paired

options:
  --port <n>            port to serve or probe (default ${String(DEFAULT_PORT)})
  --bank <url>          recipe bank origin (default ${DEFAULT_BANK}; also TXT2SFX_BANK)
  --allow-origin <o>    extra Origin allowed to pair, matched verbatim; repeatable
                        (localhost and ${PLAYGROUND_ORIGIN} already pair)
  --allow-write <dir>   extra directory sfx_export may write into; repeatable
  --claude-bin <path>   claude mode: the executable (default ${CLAUDE_DEFAULT_BIN}; also TXT2SFX_CLAUDE_BIN)
  --model <id>          claude mode: model for those completions (default: the CLI's own)
  --help                this text
`;

/** Parse argv. Exits nowhere — the caller decides what a bad flag costs. */
export function parseCliOptions(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let command: CliOptions['command'] = 'serve';
  let port = DEFAULT_PORT;
  let bankUrl = env['TXT2SFX_BANK'] ?? DEFAULT_BANK;
  let claudeBin = env['TXT2SFX_CLAUDE_BIN'] ?? CLAUDE_DEFAULT_BIN;
  let model: string | undefined;
  const allowOrigins: string[] = [];
  const allowWrite: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    switch (arg) {
      case 'doctor':
        command = 'doctor';
        break;
      case 'claude':
        command = 'claude';
        break;
      case '--stdio':
        command = 'stdio';
        break;
      case '--help':
      case '-h':
        command = 'help';
        break;
      case '--port': {
        const value = Number(argv[++i]);
        if (Number.isInteger(value) && value > 0 && value < 65536) port = value;
        else throw new Error(`--port needs a port number, got "${argv[i] ?? ''}"`);
        break;
      }
      case '--bank': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--bank needs a URL');
        bankUrl = value.replace(/\/$/, '');
        break;
      }
      case '--allow-origin': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--allow-origin needs an origin');
        allowOrigins.push(value);
        break;
      }
      case '--allow-write': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--allow-write needs a directory');
        allowWrite.push(value);
        break;
      }
      case '--claude-bin': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--claude-bin needs a path');
        claudeBin = value;
        break;
      }
      case '--model': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--model needs a model id');
        model = value;
        break;
      }
      default:
        throw new Error(`unknown argument "${arg}" — run with --help`);
    }
  }

  return { command, port, bankUrl, allowOrigins, allowWrite, claudeBin, model };
}

/** `GET /health`, briefly. `undefined` when nothing answers. */
async function probeHealth(port: number, timeoutMs = 1500): Promise<HealthPayload | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return looksLikeBridge(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/** Is anything at all listening on the port? Distinct from "is it a bridge". */
function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe: Server = createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '127.0.0.1');
  });
}

interface RunningBridge {
  readonly hub: Hub;
  readonly server: Server;
  /** The context both doors run tools through — HTTP here, stdio in {@link stdio}. */
  readonly ctx: ToolContext;
  close(): Promise<void>;
}

/**
 * The renderer a long-lived process should use.
 *
 * A daemon renders thousands of times — `sfx_fit` alone is a population per
 * generation — and `node-web-audio-api` never frees an `OfflineAudioContext`,
 * so in-process rendering costs a daemon roughly 100 MB per search that it
 * never gives back (`render-child.ts` has the measurements). The subprocess
 * gives that memory back on every recycle.
 *
 * When the child's entry point is not on disk the bridge keeps rendering
 * in-process and *says so*, rather than losing tier 2 altogether. That is the
 * same judgement `renderSound` makes about clipping: an unusual install should
 * degrade to something that works and reports what it cost, not to silence.
 */
function daemonRenderer(): { native: NativeRenderer; child: ChildRenderer | undefined } {
  if (childEntryPath() === undefined) {
    log('render subprocess not found next to the bridge — rendering in-process, so memory grows with each render.');
    return { native: createNativeRenderer(), child: undefined };
  }
  const child = createChildRenderer({ log });
  return { native: child, child };
}

/** Bind the daemon. Rejects with the listen error (EADDRINUSE included). */
function startBridge(options: CliOptions, token: string): Promise<RunningBridge> {
  const { native, child } = daemonRenderer();
  /* One instance for the process: the lock inside it is what stops two renders from
     each taking twice as long, and torch takes every core a machine has. */
  const hub = new Hub({ version: VERSION, native, log, model: new StableAudio({ log }) });
  /* One context for both doors: the HTTP `/tools/<name>` route and, when this
     process is also the MCP server, stdio. Two would mean two native-module
     imports and two chances for them to disagree about what can render. */
  const ctx = toolContext(options, localToolHub(hub), native);
  const server = createBridgeServer({
    hub,
    token,
    version: VERSION,
    toolNames: TOOL_NAMES,
    toolContext: ctx,
    allowOrigins: options.allowOrigins,
    log,
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        hub,
        server,
        ctx,
        close: () =>
          new Promise<void>((resolveClose) => {
            /* The render subprocess is not a child of the socket — nothing else
               would ever reap it. */
            child?.close();
            server.close(() => resolveClose());
            /* Keep-alive sockets would hold the close for minutes. */
            server.closeAllConnections();
          }),
      });
    });
  });
}

function toolContext(options: CliOptions, hub: ToolHub, native: NativeRenderer): ToolContext {
  return {
    hub,
    native,
    bankUrl: options.bankUrl,
    cwd: process.cwd(),
    allowWrite: options.allowWrite,
    log,
  };
}

/* --- serve --------------------------------------------------------------------- */

async function serve(options: CliOptions): Promise<number> {
  const state = ensureState(options.port);
  let running: RunningBridge;
  try {
    running = await startBridge(options, state.token);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') throw error;
    const occupant = await probeHealth(options.port);
    if (occupant !== undefined) {
      log(
        `a txt2sfx bridge is already listening on 127.0.0.1:${String(options.port)} (version ${occupant.version}) — nothing to do.`,
      );
      return 0;
    }
    log(
      `port ${String(options.port)} is taken by something that is not a txt2sfx bridge — stop it or pass --port.`,
    );
    return 1;
  }

  const path = saveState({ token: state.token, port: options.port });
  log(`txt2sfx bridge ${VERSION} listening on http://127.0.0.1:${String(options.port)}`);
  log(`token in ${path}; playgrounds pair via GET /pair, agents read the file.`);
  log(`tools: MCP over --stdio, or POST /tools/<name> with the token — see doctor for a prompt to paste.`);
  log(`renderer: ${(await running.hub.renderer()).why}`);

  const stop = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  /* The daemon runs until a signal; the promise never settles on purpose. */
  return new Promise<number>(() => {});
}

/* --- stdio ---------------------------------------------------------------------- */

async function stdio(options: CliOptions): Promise<number> {
  const running = await probeHealth(options.port);

  if (running !== undefined) {
    /* A daemon owns the port; speak to it over loopback so its playground
       connections and its parked jobs are the ones we see. */
    const state = loadState();
    if (state === undefined) {
      log(
        `a bridge is on port ${String(options.port)} but ${stateFilePath()} is missing — restart that bridge so it writes its token, then retry.`,
      );
      return 1;
    }
    const hub = remoteToolHub(`http://127.0.0.1:${String(options.port)}`, state.token);
    log(`mcp: using the daemon on 127.0.0.1:${String(options.port)} (sampling needs an in-process hub and is off)`);
    /* The daemon owns the tabs and the parked jobs, but the tools still *run*
       here — `sfx_fit` against a `reference` renders in this process, not in the
       daemon. So this session needs the recycling renderer just as much; an
       agent that fits a few recipes over an afternoon is exactly the case. */
    const { native, child } = daemonRenderer();
    const server = createMcpServer({
      input: process.stdin,
      output: process.stdout,
      ctx: toolContext(options, hub, native),
      version: VERSION,
      log,
    });
    await server.done;
    child?.close();
    return 0;
  }

  /* No daemon: start the hub in-process and open the port, so a tab opened
     later still finds the switchboard. One process, both jobs. */
  const state = ensureState(options.port);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge(options, state.token);
    saveState({ token: state.token, port: options.port });
    log(`mcp: in-process hub on 127.0.0.1:${String(options.port)}`);
  } catch (error) {
    /* Lost the race to another process between probe and listen — use it. */
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') throw error;
    return stdio(options);
  }

  const server = createMcpServer({
    input: process.stdin,
    output: process.stdout,
    ctx: bridge.ctx,
    hub: bridge.hub,
    version: VERSION,
    log,
  });
  await server.done;
  await bridge.close();
  return 0;
}

/* --- claude ---------------------------------------------------------------------- */

/**
 * Attach to a bridge, however one has to be found.
 *
 * The same three-way choice `stdio` makes, for the same reason: a daemon on the
 * port owns the playground tabs and the parked jobs, so it must be used rather
 * than shadowed; with nothing on the port, opening one here is what keeps this a
 * single command. The recursion is the lost-race path — another process bound
 * the port between the probe and the listen — and it terminates because the
 * retry finds that process with `probeHealth`.
 */
async function attachHub(options: CliOptions): Promise<
  { readonly hub: ToolHub; readonly bridge?: RunningBridge; readonly where: string } | undefined
> {
  const running = await probeHealth(options.port);
  if (running !== undefined) {
    const state = loadState();
    if (state === undefined) {
      log(
        `a bridge is on port ${String(options.port)} but ${stateFilePath()} is missing — restart that bridge so it writes its token, then retry.`,
      );
      return undefined;
    }
    return {
      hub: remoteToolHub(`http://127.0.0.1:${String(options.port)}`, state.token),
      where: `the daemon on 127.0.0.1:${String(options.port)}`,
    };
  }

  const state = ensureState(options.port);
  try {
    const bridge = await startBridge(options, state.token);
    saveState({ token: state.token, port: options.port });
    return { hub: bridge.ctx.hub, bridge, where: `an in-process bridge on 127.0.0.1:${String(options.port)}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    return attachHub(options);
  }
}

/**
 * `txt2sfx-bridge claude` — Claude Code as the playground's model.
 *
 * The binary is probed with `--version` before anything is promised, because
 * the failure this mode has is a missing or unauthenticated CLI and finding
 * that out on the human's first Generate — after they have typed a prompt and
 * pressed a button — is the wrong moment. What it costs is one process launch
 * at startup.
 */
async function claudeMode(options: CliOptions): Promise<number> {
  const attached = await attachHub(options);
  if (attached === undefined) return 1;

  try {
    const probe = await runCommand(options.claudeBin, ['--version'], '', 30_000);
    if (probe.code !== 0) {
      log(`${options.claudeBin} --version exited ${String(probe.code)}: ${probe.stderr.trim() || 'no output'}`);
      return 1;
    }
    log(`claude: ${probe.stdout.trim() || options.claudeBin}${options.model === undefined ? '' : ` (--model ${options.model})`}`);
  } catch (error) {
    log(error instanceof ClaudeError ? error.message : `could not run ${options.claudeBin}: ${String(error)}`);
    return 1;
  }

  /* Only an in-process hub can be told who is answering. Behind a daemon the
     open long-poll is the evidence, and the badge says "via polling" — which is
     true, and better than this process claiming an identity the daemon has no
     way to verify. */
  attached.bridge?.hub.setAgent('Claude Code (CLI)', false);

  log(`claude: answering generation requests through ${attached.where}`);
  log(`pick the "agent" provider in the playground and press Generate; Ctrl+C stops answering.`);

  const stop = (): void => {
    void (attached.bridge?.close() ?? Promise.resolve()).then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await runClaudeWorker({
    hub: attached.hub,
    complete: claudeCompleter({ bin: options.claudeBin, model: options.model, log }),
    log,
  });
  await attached.bridge?.close();
  return 1; // the worker only returns when it has given up on the daemon
}

/* --- doctor --------------------------------------------------------------------- */

/** Doctor is for a human at a terminal, so stdout — the one non-JSON use it has. */
function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function doctor(options: CliOptions): Promise<number> {
  let broken = false;
  print(`txt2sfx-bridge ${VERSION} — doctor\n`);

  const health = await probeHealth(options.port);
  if (health !== undefined) {
    print(`  port ${String(options.port)}     a bridge is listening (version ${health.version}, protocol ${String(health.protocol)})`);
    print(`  renderer      ${health.renderer}`);
    print(`  playgrounds   ${String(health.playgrounds)} connected`);
    print(
      `  agent         ${
        health.agent.connected
          ? `connected (${health.agent.client ?? 'via polling'}${health.agent.sampling ? ', sampling' : ''})`
          : 'not connected'
      }`,
    );
    print(`  tools         ${String(health.tools.length)}: ${health.tools.join(', ')}`);
  } else if (await portTaken(options.port)) {
    print(`  port ${String(options.port)}     TAKEN by something that is not a txt2sfx bridge — stop it or pass --port`);
    broken = true;
  } else {
    print(`  port ${String(options.port)}     free — no bridge is running (npx txt2sfx-bridge starts one)`);
    const native = createNativeRenderer();
    const resolution = await resolveRenderer(false, native);
    print(`  renderer      ${resolution.renderer} (once started) — ${resolution.why}`);
  }

  print(`  protocol      v${String(PROTOCOL_VERSION)}`);

  try {
    const state = loadState();
    if (state === undefined) {
      print(`  token file    ${stateFilePath()} — not written yet (created on first start)`);
    } else {
      print(`  token file    ${stateFilePath()} (${describeMode(stateFilePath())}, port ${String(state.port)})`);
    }
  } catch (error) {
    print(`  token file    BROKEN: ${error instanceof Error ? error.message : String(error)}`);
    broken = true;
  }

  /* The reference model is the one part of the bridge that can occupy several
     gigabytes of somebody's disk, so doctor names the directories and the sizes
     rather than reporting a word. */
  const model = await new StableAudio({ log }).status();
  print(`  model         ${model.stage}${model.ready ? '' : ` — ${model.reason ?? 'run the Model tab’s install button'}`}`);
  if (model.workDir !== '') {
    print(`  model files   ${model.weights.dir} (${formatBytes(model.weights.bytes)})`);
    print(`  model venv    ${model.venv.path} (${formatBytes(model.venv.bytes)}${model.venv.torch === null || model.venv.torch === '' ? '' : `, torch/${model.venv.torch}`})`);
  }

  try {
    const response = await fetch(`${options.bankUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await response.json()) as { recipes?: number };
    print(`  bank          ${options.bankUrl} — reachable, ${String(body.recipes ?? '?')} recipes`);
  } catch {
    print(`  bank          ${options.bankUrl} — not reachable (bank tools will say so; the rest works)`);
  }

  print('');
  print('  MCP client config (paste into your client\'s mcp settings):');
  print('  {');
  print('    "mcpServers": {');
  print('      "txt2sfx": {');
  print('        "command": "npx",');
  print('        "args": ["-y", "txt2sfx-bridge", "--stdio"]');
  print('      }');
  print('    }');
  print('  }');

  /* The third door, one line: the config and the prompt both assume a human
     with an agent to point at this. Someone who only wants to type prompts in
     the playground needs neither, and would never find the mode from a flag
     list. */
  print('');
  print('  Claude Code installed? `npx txt2sfx-bridge claude` makes it the model behind');
  print('  the playground\'s "agent" provider — no MCP client, no key, no restart.');

  /* Doctor's other half: the config is for a human who knows where their
     client keeps it, and the prompt below is for everyone else — paste it into
     the agent and let it do both the registering and the first sound. */
  print('');
  print('  ── or paste this at your agent (Claude Code, Codex, opencode, Cursor) ──');
  print('');
  for (const line of bridgeOnboardingPrompt({ port: options.port }).split('\n')) {
    print(line === '' ? '' : `  ${line}`);
  }

  return broken ? 1 : 0;
}

/* --- entry ---------------------------------------------------------------------- */

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliOptions(process.argv.slice(2));
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  switch (options.command) {
    case 'help':
      print(USAGE);
      process.exit(0);
      break;
    case 'doctor':
      process.exit(await doctor(options));
      break;
    case 'stdio':
      process.exit(await stdio(options));
      break;
    case 'claude':
      process.exit(await claudeMode(options));
      break;
    case 'serve':
      process.exit(await serve(options));
  }
}

/**
 * Is this module the program, rather than something a test imported?
 *
 * The guard exists because `parseCliOptions` is imported by a test, which must not
 * seize stdin or a port by doing so. `pathToFileURL` rather than string surgery, for
 * the same Windows drive-letter reason as the server.
 *
 * `realpathSync` is the load-bearing part, and its absence was a real bug: on POSIX
 * npm installs a bin as a **symlink** in `node_modules/.bin`, so `process.argv[1]` is
 * that link while `import.meta.url` is the file it points at — Node's ESM loader
 * resolves symlinks before it hands a module its own URL. Compared raw, the two never
 * matched, `main()` never ran, and `npx txt2sfx-bridge` exited 0 having printed
 * nothing. It worked on Windows only because npm writes a `.cmd` shim there that
 * carries the real path, which is exactly the kind of platform difference a
 * developer's machine hides. A silent no-op has no message to search for, so this is
 * checked by a test that installs through a symlink rather than left to review.
 *
 * @param moduleUrl `import.meta.url` of the module asking.
 * @param argv1 `process.argv[1]`, or undefined when there is none.
 */
export function runningAsScript(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  const target = resolve(argv1);
  /* A path that does not exist cannot be this module, but it also must not throw:
     `node --eval` and some launchers put something unopenable in argv[1]. */
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    real = target;
  }
  return moduleUrl === pathToFileURL(real).href;
}

if (runningAsScript(import.meta.url, process.argv[1])) {
  await main();
}
