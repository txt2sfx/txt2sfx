/**
 * `txt2sfx-bridge claude` — the CLI as the playground's model.
 *
 * Everything here runs against a scripted `CommandRunner`, never the real
 * binary: what is worth pinning is the *shape* of the exchange — what reaches
 * argv, what reaches stdin, what a refusal does to the parked job — and none of
 * that should need a model, a network or somebody's subscription to check. The
 * one thing a fake cannot cover is whether the flags exist, which is why they
 * are named in one function a human can read against `claude --help`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeError,
  claudeArgs,
  claudeCompleter,
  conversationText,
  parseClaudeJson,
  runClaudeWorker,
  runCommand,
  silentLog,
  type CommandResult,
  type CommandRunner,
  type ParkedRequest,
  type ToolHub,
} from '../src/index.js';

const request = (overrides: Partial<ParkedRequest> = {}): ParkedRequest => ({
  id: 'job-1',
  turn: 1,
  messages: [{ role: 'user', content: 'a wet bubble pop' }],
  system: 'You write soundline.',
  systemBytes: 20,
  ...overrides,
});

/** A runner that answers like the CLI does, and remembers how it was called. */
function scriptedRunner(result: string | CommandResult): {
  readonly run: CommandRunner;
  readonly calls: { bin: string; args: readonly string[]; stdin: string }[];
} {
  const calls: { bin: string; args: readonly string[]; stdin: string }[] = [];
  const run: CommandRunner = (bin, args, stdin) => {
    calls.push({ bin, args, stdin });
    return Promise.resolve(
      typeof result === 'string'
        ? { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result }), stderr: '' }
        : result,
    );
  };
  return { run, calls };
}

/** Enough of a {@link ToolHub} to drive the worker: a queue in, a log out. */
function fakeHub(queue: (ParkedRequest | 'none')[]): ToolHub & {
  readonly answered: { id: string; text: string }[];
  readonly failed: { id: string; message: string }[];
} {
  const answered: { id: string; text: string }[] = [];
  const failed: { id: string; message: string }[] = [];
  return {
    answered,
    failed,
    callPlayground: () => Promise.reject(new Error('not used')),
    nextRequest: () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('the daemon went away');
      return Promise.resolve(next === 'none' ? { none: true } : { request: next });
    },
    answer: (id, text) => {
      answered.push({ id, text });
      return Promise.resolve(true);
    },
    fail: (id, message) => {
      failed.push({ id, message });
      return Promise.resolve(true);
    },
    agentStatus: () => Promise.resolve({ connected: true, client: 'Claude Code (CLI)', sampling: false }),
    playgroundConnected: () => Promise.resolve(true),
  };
}

describe('what reaches the CLI', () => {
  it('keeps every prompt out of argv — Windows caps a command line at 32767 chars', async () => {
    /* The contract alone is ~12 KB. A prompt in argv fits on one machine and
       truncates on another, which is the worst shape a bug can take. */
    const { run, calls } = scriptedRunner('```\nsound "pop" 120ms\n```');
    const big = 'x'.repeat(40_000);
    await claudeCompleter({ run, log: silentLog })(request({ system: big, messages: [{ role: 'user', content: big }] }));
    const argv = calls[0]!.args.join(' ');
    expect(argv.length).toBeLessThan(500);
    expect(argv).not.toContain('xxxx');
    expect(calls[0]!.stdin).toBe(big);
  });

  it('hands the system prompt over as a file, and deletes it afterwards', async () => {
    const { run, calls } = scriptedRunner('ok');
    let seen: string | undefined;
    let path: string | undefined;
    const spy: CommandRunner = async (bin, args, stdin, timeoutMs) => {
      path = args[args.indexOf('--system-prompt-file') + 1];
      seen = (await import('node:fs')).readFileSync(path!, 'utf8');
      return run(bin, args, stdin, timeoutMs);
    };
    await claudeCompleter({ run: spy, log: silentLog })(request({ system: 'You write soundline.' }));
    expect(seen).toBe('You write soundline.');
    expect((await import('node:fs')).existsSync(path!)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('asks for a completion and not an agent session', () => {
    const args = claudeArgs('/tmp/system.txt');
    expect(args).toContain('--print');
    /* No tools: a Read or a Bash call here could only mean it wandered off, and
       a permission prompt has nobody to answer it at the end of a pipe. */
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args).not.toContain('--model');
    expect(claudeArgs('/tmp/system.txt', 'opus')[claudeArgs('/tmp/system.txt', 'opus').indexOf('--model') + 1]).toBe('opus');
  });
});

describe('the conversation as one prompt', () => {
  it('sends a first ask unadorned — role markers would be furniture', () => {
    expect(conversationText([{ role: 'user', content: 'a wet bubble pop' }])).toBe('a wet bubble pop');
  });

  it('marks the roles on a repair turn, where the last attempt is half the content', () => {
    const text = conversationText([
      { role: 'user', content: 'a wet bubble pop' },
      { role: 'assistant', content: 'sound "pop" 120ms ui' },
      { role: 'user', content: 'that does not parse' },
    ]);
    expect(text).toContain('--- user ---\na wet bubble pop');
    expect(text).toContain('--- assistant ---\nsound "pop" 120ms ui');
    expect(text.indexOf('assistant')).toBeLessThan(text.lastIndexOf('user'));
  });
});

describe('reading what the CLI answered', () => {
  it('takes the result field of --output-format json', () => {
    expect(parseClaudeJson(JSON.stringify({ type: 'result', is_error: false, result: '```\nx\n```' }))).toBe('```\nx\n```');
  });

  it('treats is_error as a failure even though the process exited 0', () => {
    /* A refusal, a spent budget and an auth failure are all *successful* runs
       with the explanation in `result`. Trusting the exit code would hand the
       playground an error message to parse as soundline. */
    const json = JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_turns', result: 'ran out of turns' });
    expect(() => parseClaudeJson(json)).toThrow(/ran out of turns/);
  });

  it('says what it got when the answer is not JSON at all', () => {
    expect(() => parseClaudeJson('error: unknown option --output-format')).toThrow(/unknown option/);
  });

  it('refuses an empty completion rather than passing silence downstream', () => {
    expect(() => parseClaudeJson(JSON.stringify({ result: '   ' }))).toThrow(/empty/);
  });

  it('reports a crash with the stderr, since that is the only description anyone gets', async () => {
    const { run } = scriptedRunner({ code: 1, stdout: '', stderr: 'Invalid API key' });
    await expect(claudeCompleter({ run, log: silentLog })(request())).rejects.toThrow(/Invalid API key/);
  });
});

describe('the worker loop', () => {
  it('answers a parked job with what the model wrote', async () => {
    const hub = fakeHub(['none', request(), 'none']);
    const { run } = scriptedRunner('```\nsound "pop" 120ms ui\n```');
    await runClaudeWorker({ hub, complete: claudeCompleter({ run, log: silentLog }), log: silentLog });
    expect(hub.answered).toEqual([{ id: 'job-1', text: '```\nsound "pop" 120ms ui\n```' }]);
    expect(hub.failed).toHaveLength(0);
  });

  it('fails the job when the CLI does, so the human is told instead of left waiting', async () => {
    /* The playground is sitting on `agent.complete`. Dropping the job would
       look exactly like the bridge hanging. */
    const hub = fakeHub([request()]);
    const complete = (): Promise<string> => Promise.reject(new ClaudeError('claude returned an empty completion'));
    await runClaudeWorker({ hub, complete, log: silentLog });
    expect(hub.answered).toHaveLength(0);
    expect(hub.failed).toEqual([{ id: 'job-1', message: 'claude returned an empty completion' }]);
  });

  it('gives up after three failed polls rather than spinning against a dead daemon', async () => {
    const hub = fakeHub([]); // every poll throws
    const log = vi.fn();
    await runClaudeWorker({ hub, complete: () => Promise.resolve('x'), log });
    expect(log.mock.calls.flat().join('\n')).toMatch(/giving up after 3 failed polls/);
  });

  it('stops when the signal is aborted, without touching the hub', async () => {
    const hub = fakeHub([request()]);
    await runClaudeWorker({ hub, complete: () => Promise.resolve('x'), log: silentLog, signal: { aborted: true } });
    expect(hub.answered).toHaveLength(0);
  });
});

describe('the real runner', () => {
  it('names the fix when the binary is not there', async () => {
    /* The one failure this mode really has. "spawn ENOENT" is not an answer. */
    await expect(runCommand('txt2sfx-no-such-binary', ['--version'], '', 5000)).rejects.toThrow(
      /install Claude Code|--claude-bin/,
    );
  });

  it('pipes stdin through to a real child and reads its stdout back', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdin.on("data", (d) => process.stdout.write(d))'],
      'hello',
      10_000,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hello');
  });
});
