/**
 * Dev-only endpoint that drives `test/stable-audio/run.py` from the playground.
 *
 * ## Why this is a *reference* generator and not a provider
 *
 * The diffusion model does not write soundlines — it writes 44.1 kHz WAV. So it
 * cannot sit in the provider picker next to Gemini; what it can do is answer the
 * same prompt with the sound you are trying to approximate. That is exactly the
 * shape the playground already has a slot for: the Compare panel's reference, the
 * optimizer's fit target, and the `match reference` box on a generate run. This
 * endpoint fills that slot from a prompt instead of from a file picker, which is
 * the whole difference between "find a WAV somewhere" and "hear the target".
 *
 * The non-goal in `ROADMAP.md` still holds: no cloud text-to-audio model in the
 * core, and nothing here is in the shipped bundle. `apply: 'serve'` keeps it out
 * of a build, and the model runs on the developer's own machine.
 *
 * ## The render never touches the disk
 *
 * `run.py --stdout` hands the encoded audio back on stdout and writes nothing, so a
 * session of clicking the button leaves no pile of files behind. A render here is a
 * *target*: it is consumed once, by the reference slot, and a spent one is litter.
 * The bytes travel as base64 in the stream's last NDJSON line, which is ~130 KB for
 * a three-second MP3 — cheaper than the WAV it replaces was to write down.
 *
 * `out/` still exists and is still listed, because a `run.py` run from a terminal
 * does keep its renders and those are worth reloading without re-rendering.
 *
 * ## Deliberately narrow
 *
 * The endpoint drives an installation that is *already provisioned* and refuses to
 * provision one: the first run of `run.py` fetches a CPython 3.10 interpreter and
 * ~1.7 GB of gated weights, and an HTTP request from a page is the wrong place to
 * start that — it would hold a connection for many minutes and hide a licence gate
 * behind a spinner. Run it once from a terminal, then the button works.
 *
 * Everything reachable is bounded: one render at a time (torch takes every core), a
 * wall-clock ceiling, a cap on how much stdout is buffered, an argv built from
 * validated numbers, and reads limited to `out/` by a name pattern. The prompt is
 * passed as a single argv element to a `shell: false` spawn, so it is text to Python
 * and never to a shell.
 *
 * @packageDocumentation
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

/** Files we are willing to serve out of `out/`. Written by `run.py`'s slugify. */
const RENDER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,95}\.(mp3|wav)$/;

/** Longest prompt we hand to the model. Longer is a paste accident, not a prompt. */
const MAX_PROMPT = 400;

/** Hard ceiling on one render. A CPU render is ~20–60 s; ten minutes is a hang. */
const TIMEOUT_MS = 10 * 60 * 1000;

/** Largest request body. The body is a prompt and four numbers. */
const MAX_BODY = 8 * 1024;

/**
 * Most audio we will hold from the child, in bytes.
 *
 * The model's ceiling is 11 s of 44.1 kHz stereo: ~2 MB of WAV, ~450 KB of MP3. 16 MB
 * is far above anything `run.py` can produce and still bounded, so a child that turns
 * out to be writing something else to stdout is a killed process rather than a dev
 * server eating memory until it dies.
 */
const MAX_AUDIO = 16 * 1024 * 1024;

/** The line `run.py --stdout` writes to stderr to name what it just wrote to stdout. */
const RESULT_PREFIX = 'txt2sfx-result ';

/** What the browser may ask for. Everything is optional but the prompt. */
export interface RenderRequest {
  readonly prompt?: unknown;
  readonly seconds?: unknown;
  readonly steps?: unknown;
  readonly seed?: unknown;
  readonly model?: unknown;
  readonly repo?: unknown;
}

/** A render sitting in `test/stable-audio/out/`, left there by a terminal run. */
export interface RenderFile {
  readonly file: string;
  readonly bytes: number;
  readonly modifiedMs: number;
}

/** What `run.py --stdout` says about the bytes it wrote. */
export interface RenderResult {
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
}

/** What `GET /__stable-audio` answers. */
export interface StableAudioStatus {
  /** True when a render can be started right now. */
  readonly ready: boolean;
  /** Why not, when `ready` is false — phrased as the command that fixes it. */
  readonly reason?: string;
  /** True while a render is in flight; a second one is refused. */
  readonly busy: boolean;
  /**
   * Renders left in `out/` by a terminal run, newest first. Loading one costs nothing.
   *
   * Nothing the playground renders appears here: those are streamed and never written.
   */
  readonly renders: readonly RenderFile[];
  /** Defaults the UI shows, taken from `run.py`'s own preset. */
  readonly defaults: { readonly seconds: number; readonly steps: number; readonly repo: string };
  /**
   * Whether the dev server can see an `HF_TOKEN`.
   *
   * Worth saying out loud: the default checkpoint is gated, the token has to be in
   * the environment *of the dev server* (exported before `pnpm dev`, not in the
   * terminal where `run.py` was first run), and without it a gated repo fails after
   * seven seconds for a reason that has nothing to do with the prompt.
   */
  readonly hasToken: boolean;
}

/**
 * One line of the render's progress, or its outcome.
 *
 * `done` carries the audio itself, base64 in JSON, because the render was never written
 * anywhere to be fetched from. The alternative — a temp file and a second request — is a
 * file to clean up and a window in which it can be read by anything on the machine, in
 * exchange for saving a third of ~130 KB.
 */
export type RenderEvent =
  | { readonly type: 'start'; readonly argv: readonly string[] }
  | { readonly type: 'log'; readonly line: string }
  | {
      readonly type: 'done';
      /** `<slug>-<seed>.mp3` — named by `run.py`, so the naming rule has one home. */
      readonly name: string;
      readonly mime: string;
      readonly bytes: number;
      readonly ms: number;
      /** The encoded audio, base64. */
      readonly audio: string;
    }
  | { readonly type: 'error'; readonly message: string };

/** The presets `run.py` accepts, so a typo is a 400 rather than a Python traceback. */
const MODELS = new Set(['small', 'sfx3']);

/** The repo `run.py`'s `small` preset uses when nothing overrides it. */
const DEFAULT_REPO = 'stabilityai/stable-audio-open-small';

/** A Hugging Face repo id: `owner/name`, and nothing that could be a path or a flag. */
const REPO_RE = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;

/** True when a string carries a C0 control character or DEL. */
function hasControlChars(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Build the argv for `run.py` from an untrusted body.
 *
 * Every number is range-checked here rather than left to Python: `--steps 1e9` is
 * a hang somebody has to notice and kill, and a hang started from a browser tab is
 * the worst kind. The ranges are wide enough to be worth playing with and narrow
 * enough that the worst case is still a render.
 *
 * @throws When the body cannot be turned into a run.
 */
export function renderArgs(body: RenderRequest): string[] {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt === '') throw new Error('expected { prompt: string }');
  if (prompt.length > MAX_PROMPT) throw new Error(`prompt is longer than ${String(MAX_PROMPT)} characters`);
  /* Control characters would land in a filename via slugify and in a terminal via
     the echoed log line. Neither is worth allowing for a sentence of English. */
  if (hasControlChars(prompt)) throw new Error('prompt contains control characters');

  /* `--stdout` is not a knob: a render started from the page is streamed to it and
     leaves nothing in `out/`. The encoding is left to run.py's own default so there is
     one place that decides it, and the `done` event repeats whatever it chose. */
  const argv = [prompt, '--stdout'];

  const number = (value: unknown, name: string, min: number, max: number): number => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new Error(`${name} must be a number between ${String(min)} and ${String(max)}`);
    }
    return n;
  };

  if (body.seconds !== undefined && body.seconds !== null && body.seconds !== '') {
    argv.push('--seconds', String(number(body.seconds, 'seconds', 0.25, 11)));
  }
  if (body.steps !== undefined && body.steps !== null && body.steps !== '') {
    argv.push('--steps', String(Math.round(number(body.steps, 'steps', 1, 200))));
  }
  if (body.seed !== undefined && body.seed !== null && body.seed !== '') {
    argv.push('--seed', String(Math.round(number(body.seed, 'seed', 0, 0xffffffff))));
  }
  if (body.model !== undefined && body.model !== null && body.model !== '') {
    if (typeof body.model !== 'string' || !MODELS.has(body.model)) {
      throw new Error(`model must be one of ${[...MODELS].join(', ')}`);
    }
    argv.push('--model', body.model);
  }
  /* The default checkpoint is gated, and `run.py --repo` exists precisely because
     byte-identical community mirrors of it are not. Whichever one a machine has in
     its Hugging Face cache is the one that renders without a download, so the
     playground has to be able to name it. */
  if (body.repo !== undefined && body.repo !== null && body.repo !== '') {
    if (typeof body.repo !== 'string' || !REPO_RE.test(body.repo)) {
      throw new Error('repo must be a Hugging Face id of the form owner/name');
    }
    argv.push('--repo', body.repo);
  }
  return argv;
}

/**
 * Cut a chunk of child output into whole lines.
 *
 * `\r` is a line here as much as `\n` is: tqdm redraws its bar with a carriage
 * return, and treating that as "no line yet" means the progress bar arrives as one
 * enormous line after the step it was reporting has finished.
 *
 * @returns The complete lines, and the remainder to prepend to the next chunk.
 */
export function splitLines(chunk: string, carry: string): { lines: string[]; carry: string } {
  const parts = (carry + chunk).split(/\r\n|\r|\n/);
  const rest = parts.pop() ?? '';
  return { lines: parts.map((line) => line.trimEnd()).filter((line) => line !== ''), carry: rest };
}

/**
 * Read the `txt2sfx-result {…}` line, or null for any other line.
 *
 * What the endpoint needs from it is the name and the media type, and both are decided
 * in `run.py`: the filename rule is its `slugify` and the encoding is its `--format`
 * default. Deriving either here would be a second definition of the same thing, wrong
 * the first time one side moves. Anything malformed is treated as ordinary output — a
 * line the child wrote is worth showing, never worth crashing on.
 */
export function parseResult(line: string): RenderResult | null {
  if (!line.startsWith(RESULT_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(RESULT_PREFIX.length)) as Partial<RenderResult>;
    if (typeof value.name !== 'string' || !RENDER_NAME_RE.test(value.name)) return null;
    if (typeof value.mime !== 'string' || !/^audio\/[\w.+-]{1,32}$/.test(value.mime)) return null;
    return { name: value.name, mime: value.mime, bytes: Number(value.bytes) || 0 };
  } catch {
    return null;
  }
}

/** The renders on disk, newest first. */
async function listRenders(outDir: string): Promise<RenderFile[]> {
  if (!existsSync(outDir)) return [];
  const names = (await readdir(outDir)).filter((name) => RENDER_NAME_RE.test(name));
  const files = await Promise.all(
    names.map(async (file) => {
      const info = await stat(join(outDir, file));
      return { file, bytes: info.size, modifiedMs: info.mtimeMs };
    }),
  );
  return files.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/** Read a request body with a hard size ceiling. */
async function readBody(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.byteLength;
    if (total > MAX_BODY) throw new Error(`body exceeds ${String(MAX_BODY)} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Serve `/__stable-audio` — status, render, and the resulting WAV.
 *
 * @param stableAudioDir Absolute path of `test/stable-audio`.
 */
export function stableAudio(stableAudioDir: string): Plugin {
  const dir = resolve(stableAudioDir);
  const outDir = join(dir, 'out');
  const script = join(dir, 'run.py');
  const venvPython = join(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const stamp = join(dir, '.venv', '.deps-installed');

  /** One render at a time: the model saturates every core, and two would crawl. */
  let running: ChildProcessWithoutNullStreams | null = null;

  /**
   * Why a render cannot start, or null.
   *
   * Checked per request rather than once at startup, because "I provisioned it in
   * a terminal just now" is the expected way to fix it and restarting the dev
   * server to be believed would be a poor answer.
   */
  const blocker = (): string | null => {
    if (!existsSync(script)) return `test/stable-audio/run.py is missing`;
    if (!existsSync(venvPython) || !existsSync(stamp)) {
      return 'not provisioned yet — run `python test/stable-audio/run.py "a test sound"` once in a terminal (it fetches CPython 3.10 and ~1.7 GB of gated weights), then this button works';
    }
    return null;
  };

  return {
    name: 'txt2sfx:stable-audio',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__stable-audio', (req, res, next) => {
        const send = (status: number, body: unknown): void => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };
        /* `use('/prefix')` strips the prefix, so this is '/', '/out/x.wav', … */
        const path = (req.url ?? '/').split('?')[0] ?? '/';

        if (req.method === 'GET' && path === '/') {
          void (async () => {
            const reason = blocker();
            const status: StableAudioStatus = {
              ready: reason === null,
              ...(reason === null ? {} : { reason }),
              busy: running !== null,
              renders: await listRenders(outDir),
              /* Mirrors the `small` preset in run.py. Kept here because the UI has
                 to show *something* before any request, and duplicating two
                 numbers beats parsing a Python file. `STABLE_AUDIO_REPO` is for the
                 machine whose cache holds a mirror rather than the gated original:
                 set it once next to `HF_TOKEN` instead of retyping it. */
              defaults: {
                seconds: 11,
                steps: 8,
                repo: process.env['STABLE_AUDIO_REPO'] ?? DEFAULT_REPO,
              },
              hasToken:
                (process.env['HF_TOKEN'] ?? process.env['HUGGINGFACE_HUB_TOKEN'] ?? '') !== '',
            };
            send(200, status);
          })().catch((error: unknown) => send(500, { error: String(error) }));
          return;
        }

        if (req.method === 'GET' && path.startsWith('/out/')) {
          void (async () => {
            const name = decodeURIComponent(path.slice('/out/'.length));
            if (!RENDER_NAME_RE.test(name)) {
              send(400, { error: `not a render name: ${name}` });
              return;
            }
            const target = join(outDir, name);
            // Belt and braces: RENDER_NAME_RE already excludes separators and dots.
            if (!target.startsWith(outDir + sep)) {
              send(400, { error: 'refusing to read outside out/' });
              return;
            }
            const bytes = await readFile(target);
            res.statusCode = 200;
            res.setHeader('content-type', name.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
            res.setHeader('content-length', String(bytes.byteLength));
            /* The file is named after its seed and never rewritten with different
               audio, so the browser may keep it for the session. */
            res.setHeader('cache-control', 'no-cache');
            res.end(bytes);
          })().catch((error: unknown) => send(404, { error: String(error) }));
          return;
        }

        if (req.method === 'POST' && path === '/') {
          void (async () => {
            const reason = blocker();
            if (reason !== null) {
              send(409, { error: reason });
              return;
            }
            if (running !== null) {
              send(409, { error: 'a render is already running — one at a time' });
              return;
            }

            let argv: string[];
            try {
              const asked = JSON.parse(await readBody(req)) as RenderRequest;
              /* A caller that says nothing about the repo gets the machine's own
                 default, so `window.txt2sfx.target('…')` works on a box whose cache
                 holds a mirror without every caller having to know that. */
              const fallback = process.env['STABLE_AUDIO_REPO'];
              const repo =
                asked.repo === undefined || asked.repo === null || asked.repo === ''
                  ? fallback
                  : asked.repo;
              argv = renderArgs({ ...asked, ...(repo === undefined ? {} : { repo }) });
            } catch (error: unknown) {
              send(400, { error: error instanceof Error ? error.message : String(error) });
              return;
            }

            /* NDJSON rather than one JSON at the end: a CPU render is tens of
               seconds of silence otherwise, and run.py's own lines ("loaded in
               10.1s on cpu", "sampled in 8.1s, decoding 3s") are the only honest
               progress there is. */
            res.statusCode = 200;
            res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            const emit = (event: RenderEvent): void => {
              res.write(`${JSON.stringify(event)}\n`);
            };

            const startedMs = Date.now();

            const child = spawn(venvPython, [script, ...argv], {
              cwd: dir,
              shell: false,
              env: { ...process.env, PYTHONUNBUFFERED: '1' },
            });
            running = child;
            emit({ type: 'start', argv });
            server.config.logger.info(`  stable-audio: ${argv.join(' ')}`);

            /* stdout is the audio and stderr is everything a human reads — that split is
               what `--stdout` buys, and it is why the two handlers are not the same. */
            const chunks: Buffer[] = [];
            let audioBytes = 0;
            let overflowed = false;
            child.stdout.on('data', (chunk: Buffer) => {
              audioBytes += chunk.byteLength;
              if (audioBytes > MAX_AUDIO) {
                if (!overflowed) {
                  overflowed = true;
                  emit({ type: 'error', message: `run.py wrote more than ${String(MAX_AUDIO)} bytes of audio — killed` });
                  child.kill();
                }
                return;
              }
              chunks.push(chunk);
            });

            let result: RenderResult | null = null;
            let carry = '';
            child.stderr.on('data', (chunk: Buffer) => {
              const split = splitLines(chunk.toString('utf8'), carry);
              carry = split.carry;
              for (const line of split.lines) {
                const parsed = parseResult(line);
                if (parsed === null) emit({ type: 'log', line });
                else result = parsed;
              }
            });

            const timer = setTimeout(() => {
              emit({ type: 'error', message: `no result after ${String(TIMEOUT_MS / 60000)} minutes — killed` });
              child.kill();
            }, TIMEOUT_MS);

            /* The Stop button has to work, and so does closing the tab: a render
               nobody is waiting for is 8 cores of nothing. */
            const onClose = (): void => {
              if (running === child) child.kill();
            };
            res.on('close', onClose);

            child.on('error', (error) => {
              emit({ type: 'error', message: `could not start ${venvPython}: ${error.message}` });
            });

            child.on('close', (code, signal) => {
              clearTimeout(timer);
              res.off('close', onClose);
              running = null;
              if (carry !== '') {
                const parsed = parseResult(carry);
                if (parsed === null) emit({ type: 'log', line: carry });
                else result = parsed;
              }

              if (code !== 0) {
                emit({
                  type: 'error',
                  message:
                    signal === null
                      ? `run.py exited with ${String(code)} — see the lines above`
                      : `run.py was stopped (${signal})`,
                });
              } else if (result === null || chunks.length === 0) {
                emit({ type: 'error', message: 'run.py finished without writing audio to stdout' });
              } else {
                const audio = Buffer.concat(chunks);
                emit({
                  type: 'done',
                  name: result.name,
                  mime: result.mime,
                  bytes: audio.byteLength,
                  ms: Date.now() - startedMs,
                  audio: audio.toString('base64'),
                });
              }
              res.end();
            });
          })().catch((error: unknown) => send(500, { error: String(error) }));
          return;
        }

        next();
      });
    },
  };
}
