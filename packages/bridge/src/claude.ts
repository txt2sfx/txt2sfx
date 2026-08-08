/**
 * `txt2sfx-bridge claude` — the Claude Code CLI answering the playground.
 *
 * Direction B already existed: pressing Generate with the `agent` provider parks
 * a job at the hub until somebody answers it. "Somebody" meant a human's MCP
 * session calling `sfx_next_request`, or a client implementing `sampling`, which
 * today is almost none of them. This module makes the bridge itself the
 * answerer — one command, and every Generate in the tab is completed by the
 * `claude` binary already installed on the machine. No key, no provider, no
 * second model: the same "you already hold the model" argument as the MCP path,
 * with the polling done by a process instead of by an agent that has to remember
 * to poll.
 *
 * ## Why a subprocess and not the Agent SDK
 *
 * `@anthropic-ai/claude-agent-sdk` would be a runtime dependency, and this
 * package has none on purpose — the single-file bundle is what makes `npx
 * txt2sfx-bridge` work at all (see the README). The CLI is already on the
 * machine of anyone who would want this mode, it is the same binary the MCP path
 * would have driven, and `-p --output-format json` is a documented contract with
 * a stable `result` field. So: spawn it, and keep the dependency count at zero.
 *
 * ## Why the system prompt travels as a file and the conversation as stdin
 *
 * The contract alone is about 12 KB and the few-shot examples add more, while
 * Windows caps an entire command line at 32767 characters. A prompt passed in
 * argv would fit on the author's machine and truncate on a user's, which is the
 * worst shape a bug can take. `--system-prompt-file` and stdin have no such
 * limit and no quoting to get wrong: nothing the model is asked to read ever
 * reaches argv, so the only things there are flags this file wrote.
 *
 * ## Why `--tools ""`
 *
 * This is a completion, not an agent session. The model is asked for one fenced
 * soundline block; a Read or a Bash call could only mean it wandered off, and a
 * permission prompt has nobody to answer it at the end of a pipe. Disabling the
 * tools is also what makes the run cheap enough to sit behind a Generate button.
 *
 * ## Why one job at a time
 *
 * The hub issues one outstanding job by construction, so the worker is a serial
 * loop and not a pool. It is also what stops a second `claude` from being
 * launched for a job the poll legitimately hands out twice — `nextRequest` is
 * idempotent by design, so the guard has to live on this side.
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type { ToolHub } from './hub.js';
import type { Log } from './log.js';
import { NEXT_DEFAULT_TIMEOUT_MS, type ChatMessage, type ParkedRequest } from './protocol.js';

/** The executable, when `--claude-bin` says nothing. Resolved on `PATH`. */
export const CLAUDE_DEFAULT_BIN = 'claude';

/**
 * How long one completion may take.
 *
 * Generous on purpose: the request carries the whole contract plus few-shot
 * examples, a cold `claude` start costs seconds before the first token, and the
 * playground has already told the human it is waiting. Five minutes is long
 * enough that a timeout means something is actually wrong — a login prompt, a
 * hung update — rather than a large prompt on a slow link.
 */
export const CLAUDE_TIMEOUT_MS = 300_000;

/** What {@link CommandRunner} reports back. A non-zero `code` is not thrown. */
export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a command with `stdin` on its standard input.
 *
 * A seam rather than a direct `spawn` call so the tests can drive the worker
 * with a scripted CLI: everything interesting here — how a refusal is reported,
 * what happens to a job whose completion fails — is about the *shape* of the
 * answer, and none of it should need a real model, a network or an API key.
 */
export type CommandRunner = (
  bin: string,
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
) => Promise<CommandResult>;

/** Thrown when the binary is missing, times out, or answers something unusable. */
export class ClaudeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeError';
  }
}

/** What a bare command name resolves to on this machine. */
interface Executable {
  readonly command: string;
  /** Prepended to the arguments — `cmd.exe /d /s /c <shim>` and nothing else. */
  readonly prefix: readonly string[];
}

/**
 * Find the executable, because Windows cannot be asked to.
 *
 * `CreateProcess` appends `.exe` on its own, so a native install would spawn
 * fine — but an npm-installed Claude Code is `claude.cmd`, a batch file, and
 * `CreateProcess` cannot start one of those at all. The usual fix is
 * `shell: true`, which is not used here on purpose: it hands the arguments to
 * the shell unquoted, and the temp directory this passes in
 * `--system-prompt-file` contains a space on any machine whose user name does.
 *
 * So `PATH` × `PATHEXT` is walked here, once, and the answer decides the shape
 * of the spawn: an `.exe` directly, a shim through `cmd.exe /d /s /c` with Node
 * doing the quoting. Finding nothing is its own answer — "no claude on PATH" is
 * the message this mode most needs to be able to give, and it must not depend
 * on parsing what cmd.exe prints when it fails.
 */
function resolveExecutable(bin: string): Executable | undefined {
  if (process.platform !== 'win32' || bin.includes('/') || bin.includes('\\')) return { command: bin, prefix: [] };

  const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '');
  const dirs = (process.env['PATH'] ?? '').split(';').filter((dir) => dir !== '');
  const named = exts.some((ext) => bin.toLowerCase().endsWith(ext.toLowerCase()));

  for (const dir of dirs) {
    for (const candidate of named ? [join(dir, bin)] : exts.map((ext) => join(dir, bin + ext))) {
      if (!existsSync(candidate)) continue;
      const lower = candidate.toLowerCase();
      return lower.endsWith('.cmd') || lower.endsWith('.bat')
        ? { command: process.env['ComSpec'] ?? 'cmd.exe', prefix: ['/d', '/s', '/c', candidate] }
        : { command: candidate, prefix: [] };
    }
  }
  return undefined;
}

/** The sentence a missing binary earns. One place, because two would drift. */
function missing(bin: string): ClaudeError {
  return new ClaudeError(
    `no "${bin}" on PATH — install Claude Code (npm i -g @anthropic-ai/claude-code) or point --claude-bin at it`,
  );
}

/** {@link CommandRunner} over `node:child_process`. */
export const runCommand: CommandRunner = (bin, args, stdin, timeoutMs) =>
  new Promise<CommandResult>((resolve, reject) => {
    const executable = resolveExecutable(bin);
    if (executable === undefined) {
      reject(missing(bin));
      return;
    }

    const child = spawn(executable.command, [...executable.prefix, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new ClaudeError(`${bin} did not answer within ${String(Math.round(timeoutMs / 1000))}s — killed it`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    /* `error` and `close` both fire when a spawn fails, in that order, so the
       flag has to be set here or the failure is overwritten by an exit code
       nobody can read (-4058 is libuv's ENOENT, not something the CLI said). */
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error.code === 'ENOENT' ? missing(bin) : new ClaudeError(`could not run ${bin}: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    });

    /* A closed stdin is how `claude -p` knows the prompt is complete. EPIPE
       here means the child died first, and its `close` carries the real
       reason — swallowing it keeps that reason readable. */
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });

/** Options of {@link claudeCompleter} and {@link runClaudeWorker}. */
export interface ClaudeOptions {
  /** The executable. Default {@link CLAUDE_DEFAULT_BIN}. */
  readonly bin?: string;
  /** `--model`. Omitted, the CLI's own default model answers. */
  readonly model?: string | undefined;
  /** Per-completion deadline. Default {@link CLAUDE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Test seam — see {@link CommandRunner}. */
  readonly run?: CommandRunner;
  /** Where the system-prompt file is written. Default the OS temp directory. */
  readonly tempDir?: string;
  readonly log: Log;
}

/**
 * The conversation as one prompt.
 *
 * A first ask reaches the model unadorned, because that is what it is: one
 * human sentence, and role markers around it would be furniture the model has
 * to look past. A repair turn is the opposite case — the previous attempt and
 * the failure it produced are the whole content, and `-p` takes a single string,
 * so the roles have to be marked or the model cannot tell its own last answer
 * from the instruction to fix it. Same labels as `sfx_next_request` prints, so
 * a human comparing the two doors sees the same conversation.
 */
export function conversationText(messages: readonly ChatMessage[]): string {
  const first = messages[0];
  if (messages.length === 1 && first !== undefined && first.role === 'user') return first.content;
  return messages.map((message) => `--- ${message.role} ---\n${message.content}`).join('\n\n');
}

/**
 * Pull the completion out of `--output-format json`.
 *
 * The CLI reports a refusal, a hit budget or an auth failure as a *successful*
 * run with `is_error: true` and the explanation in `result`, so the exit code
 * alone would call those a completion and hand the playground an error message
 * to parse as soundline. Both are checked, and whatever the CLI said is carried
 * into the thrown message — it is the only description of what went wrong that
 * anyone will ever see.
 */
export function parseClaudeJson(stdout: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    const head = stdout.trim().slice(0, 400);
    throw new ClaudeError(
      `claude did not answer JSON — is it the Claude Code CLI, and does it support --output-format json? It said: ${head || '(nothing)'}`,
    );
  }
  const body = payload as { result?: unknown; is_error?: unknown; subtype?: unknown };
  const text = typeof body.result === 'string' ? body.result : '';
  if (body.is_error === true) {
    throw new ClaudeError(`claude reported an error (${String(body.subtype ?? 'unknown')}): ${text || '(no message)'}`);
  }
  if (text.trim() === '') throw new ClaudeError('claude returned an empty completion');
  return text;
}

/** The argv one completion runs with. Exported because a test reads it. */
export function claudeArgs(systemPromptPath: string, model?: string): readonly string[] {
  return [
    '--print',
    '--output-format',
    'json',
    /* The request carries its own system prompt — this is a completion, not a
       session in a repository, so Claude Code's own coding-agent prompt (and
       the cwd, git state and CLAUDE.md it drags in) would be noise the model
       has to read past. */
    '--system-prompt-file',
    systemPromptPath,
    /* No tools: see the module note. */
    '--tools',
    '',
    /* Each Generate is independent — the playground owns the conversation and
       resends it whole — so persisting these would only fill the human's
       /resume picker with turns they never typed. */
    '--no-session-persistence',
    ...(model === undefined ? [] : ['--model', model]),
  ];
}

/**
 * One completion, by way of the CLI.
 *
 * The system-prompt file lives in a directory of its own and is removed whatever
 * happens: it holds the contract, not a secret, but a temp file per Generate
 * that nobody deletes is still litter on somebody's disk.
 */
export function claudeCompleter(options: ClaudeOptions): (request: ParkedRequest) => Promise<string> {
  const bin = options.bin ?? CLAUDE_DEFAULT_BIN;
  const timeoutMs = options.timeoutMs ?? CLAUDE_TIMEOUT_MS;
  const run = options.run ?? runCommand;

  return async (request: ParkedRequest): Promise<string> => {
    const dir = mkdtempSync(join(options.tempDir ?? tmpdir(), 'txt2sfx-claude-'));
    const systemPath = join(dir, 'system.txt');
    try {
      writeFileSync(systemPath, request.system, 'utf8');
      const result = await run(bin, claudeArgs(systemPath, options.model), conversationText(request.messages), timeoutMs);
      if (result.code !== 0 && result.stdout.trim() === '') {
        const why = result.stderr.trim().slice(0, 400) || `exit code ${String(result.code)}`;
        throw new ClaudeError(`claude exited without answering: ${why}`);
      }
      return parseClaudeJson(result.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Options of {@link runClaudeWorker}. */
export interface ClaudeWorkerOptions {
  readonly hub: ToolHub;
  /** Usually {@link claudeCompleter}; injected whole so a test needs no CLI. */
  readonly complete: (request: ParkedRequest) => Promise<string>;
  readonly log: Log;
  /** How long each poll waits. Default {@link NEXT_DEFAULT_TIMEOUT_MS}. */
  readonly pollTimeoutMs?: number;
  /** Checked before every poll; the loop returns once it is aborted. */
  readonly signal?: { readonly aborted: boolean };
}

/**
 * How many polls in a row may fail before the loop gives up.
 *
 * Only reached when the daemon this worker talks to over loopback has gone
 * away, and a worker spinning against a dead port would fill a terminal with
 * the same line forever. Three, because a single failed poll during a daemon
 * restart is not a reason to make the human retype the command.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/**
 * Poll for parked jobs and answer them with Claude Code, until aborted.
 *
 * A completion that throws *fails* the job rather than dropping it: the
 * playground is sitting on `agent.complete` and shows the message to the human,
 * where silence would look like the bridge hanging. A stale answer — the tab
 * closed, or an MCP agent got there first — is logged and forgotten, because
 * `nextRequest` is idempotent and handing the same job to two answerers is a
 * shape the hub already tolerates.
 */
export async function runClaudeWorker(options: ClaudeWorkerOptions): Promise<void> {
  const { hub, complete, log } = options;
  const pollTimeoutMs = options.pollTimeoutMs ?? NEXT_DEFAULT_TIMEOUT_MS;
  let failures = 0;

  while (options.signal?.aborted !== true) {
    let next;
    try {
      next = await hub.nextRequest(pollTimeoutMs);
      failures = 0;
    } catch (error) {
      failures++;
      log(`could not reach the bridge: ${error instanceof Error ? error.message : String(error)}`);
      if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        log(`giving up after ${String(failures)} failed polls — is the daemon still running?`);
        return;
      }
      continue;
    }

    if ('none' in next) continue;
    const { request } = next;
    log(`${request.id} (turn ${String(request.turn)}) → claude, ${String(request.systemBytes)} B of system prompt`);

    const started = Date.now();
    let text: string;
    try {
      text = await complete(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`${request.id} failed: ${message}`);
      await hub.fail(request.id, message);
      continue;
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const delivered = await hub.answer(request.id, text);
    log(
      delivered
        ? `${request.id} answered in ${seconds}s, ${String(text.length)} chars — the playground is validating it now`
        : `${request.id} was no longer waiting after ${seconds}s (the tab left, or another agent answered first)`,
    );
  }
}
