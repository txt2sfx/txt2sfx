/**
 * The reference generator: Stable Audio Open Small, driven from this process.
 *
 * ## Why the bridge owns this
 *
 * The diffusion render is the *target* a recipe is fitted to, and finding a recording
 * of "a rusty gate opening slowly, then a heavy latch" by hand is the slow step in
 * every session. It used to be reachable only from `vite dev`, through a plugin that
 * spawned `test/stable-audio/run.py` out of a repository checkout — which meant the
 * one feature that needs a local machine was the one feature the hosted playground
 * could not have. The bridge is *already* the answer to "code that must run on your
 * machine, reached from a page that is not hosted by us": it is a local daemon the
 * tab dials, it is installed with one `npx`, and it is where the renderer, the
 * optimizer and the agent's tools already live. So this module is the single
 * implementation, and the Vite plugin is now a thin HTTP shim over it — a second
 * spawn path would be a second definition of the argv, the licence gate and the
 * result line, wrong the first time either moved.
 *
 * ## Why it will now provision, when the plugin refused to
 *
 * The old endpoint deliberately refused: a 1.7 GB download and a licence gate behind
 * a spinner in a browser tab is the wrong shape. That argument was about the
 * *spinner*, not about the download. What the Model tab asks for now is the opposite
 * shape — an explicit button that says what it is about to fetch and where it will
 * land, the licence link and the three steps next to it, and every line the child
 * prints while it works. Nothing is hidden behind a progress bar, so the reason to
 * refuse is gone. `run.py --provision` is the one owner of what provisioning *means*;
 * this module only decides when to offer it and reports what it found.
 *
 * ## Where things land
 *
 * Two directories, and the panel names both because their sizes surprise people:
 *
 * - the **workspace** — `run.py`, its venv (~1 GB of CPU wheels, ~6 GB with CUDA
 *   torch) and any renders a terminal run left in `out/`. In a checkout that is
 *   `test/stable-audio/`, so a developer's existing venv is reused rather than
 *   duplicated; from a published bridge it is `~/.txt2sfx/stable-audio/`, into which
 *   the shipped copy of the script is written.
 * - the **weights** — the shared Hugging Face cache, because that is where anything
 *   else on the machine using this checkpoint will look for it. ~1.7 GB.
 *
 * Sizes are measured by walking those directories, not guessed from a table: a
 * number that says "about 1.7 GB" while the disk holds a half-finished download is
 * worse than no number.
 *
 * Node built-ins only, like the rest of this package — and nothing here imports the
 * other workspace packages, because the Vite config bundles this module while
 * building its own plugin list.
 *
 * @packageDocumentation
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Log } from './log.js';
import type {
  ModelEvent,
  ModelProvisionParams,
  ModelProvisionResult,
  ModelRenderParams,
  ModelRenderResult,
  ModelStatus,
  RenderFile,
} from './protocol.js';

/** Files we are willing to serve out of `out/`. Written by `run.py`'s slugify. */
const RENDER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,95}\.(mp3|wav)$/;

/** Longest prompt we hand to the model. Longer is a paste accident, not a prompt. */
const MAX_PROMPT = 400;

/** Hard ceiling on one render. A CPU render is ~20–60 s; ten minutes is a hang. */
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Hard ceiling on one provisioning run.
 *
 * Deliberately huge, because the honest worst case is huge: CPython, ~1 GB of CPU
 * wheels or ~3 GB of CUDA ones, and 1.7 GB of weights, on whatever line the machine
 * has. Two hours is not a promise that it will take that long — it is the point at
 * which a *stalled* download stops being distinguishable from a slow one, and the
 * Stop button is the answer to every case before it.
 */
const PROVISION_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Most audio we will hold from the child, in bytes.
 *
 * The model's ceiling is 11 s of 44.1 kHz stereo: ~2 MB of WAV, ~450 KB of MP3. 16 MB
 * is far above anything `run.py` can produce and still bounded, so a child that turns
 * out to be writing something else to stdout is a killed process rather than a daemon
 * eating memory until it dies.
 */
const MAX_AUDIO = 16 * 1024 * 1024;

/** The line `run.py --stdout` writes to name what it just wrote to stdout. */
const RESULT_PREFIX = 'txt2sfx-result ';

/** The line `run.py --provision` writes to say where the weights landed. */
const PROVISIONED_PREFIX = 'txt2sfx-provisioned ';

/** The presets `run.py` accepts, so a typo is a refusal rather than a traceback. */
const MODELS = new Set(['small', 'sfx3']);

/** The repo `run.py`'s `small` preset uses when nothing overrides it. */
export const DEFAULT_REPO = 'stabilityai/stable-audio-open-small';

/** Where the licence is accepted, and where the token that proves it is made. */
export const LICENCE_URL = `https://huggingface.co/${DEFAULT_REPO}`;
export const TOKENS_URL = 'https://huggingface.co/settings/tokens';

/** A Hugging Face repo id: `owner/name`, and nothing that could be a path or a flag. */
const REPO_RE = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;

/** An `hf_…` read token, loosely — enough to refuse a pasted URL or a whole curl line. */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,200}$/;

/**
 * Mirrors `run.py`'s `small` preset. Two numbers, so the panel can draw a form.
 *
 * Two seconds, not the model's eleven. A reference target here is one sound effect —
 * an impact, a click, a whoosh — and eleven seconds of it is ten seconds of whatever
 * the model decided to do next, which the distance metric then has to be told to
 * ignore. It is also the cheaper number twice over: `seconds_total` conditioning makes
 * the model compose a short event rather than a loop, and the decode is linear in
 * length and is the longer half on a CPU (measured: 11.8 s of sampling against 18.8 s
 * of decode for an 11 s render). Anything longer is one field away.
 */
const DEFAULTS = { seconds: 2, steps: 8 } as const;

/** The two files a workspace is made of. Copied out of the package when packed. */
const ASSETS = ['run.py', 'requirements.txt'] as const;

/* --- where everything is ---------------------------------------------------- */

/** A resolved place to run from. */
export interface Workspace {
  /** Directory holding `run.py`, `.venv/` and `out/`. */
  readonly dir: string;
  /** `run.py` inside it, whether or not it exists yet. */
  readonly script: string;
  /** The venv interpreter `run.py` builds and then re-execs into. */
  readonly venvPython: string;
  /** The venv directory itself — reported because its size surprises people. */
  readonly venv: string;
  readonly outDir: string;
  /**
   * True when the scripts came out of the published bundle rather than a checkout.
   *
   * The distinction decides where work happens: in a checkout the workspace *is* the
   * repository's `test/stable-audio`, so a venv provisioned from a terminal and one
   * provisioned from the Model tab are the same venv. From a published bridge the
   * scripts sit in an npx cache that may be deleted between runs, so they are copied
   * into the user's home instead and the venv lives there.
   */
  readonly packed: boolean;
}

/** Where the shipped copies of `run.py` and `requirements.txt` are, if anywhere. */
function assetDir(): { dir: string; packed: boolean } | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates: readonly { dir: string; packed: boolean }[] = [
    /* Packed beside the bundle by `pnpm bundle` — the published shape. */
    { dir: join(here, 'stable-audio'), packed: true },
    /* A source checkout: this file is `packages/bridge/src/stable-audio.ts`. */
    { dir: resolve(here, '..', '..', '..', 'test', 'stable-audio'), packed: false },
    /* A bridge started from the repository root by someone who cloned it. */
    { dir: resolve(process.cwd(), 'test', 'stable-audio'), packed: false },
  ];
  return candidates.find((candidate) => existsSync(join(candidate.dir, 'run.py'))) ?? null;
}

/**
 * Decide where to run.
 *
 * `TXT2SFX_STABLE_AUDIO_DIR` wins outright: someone who pointed it at a disk with
 * room on it meant exactly that, and the alternative is a 6 GB venv on whichever
 * partition happens to hold `$HOME`.
 */
export function workspace(env: NodeJS.ProcessEnv = process.env, override?: string): Workspace | null {
  const assets = assetDir();
  const configured = override ?? env['TXT2SFX_STABLE_AUDIO_DIR'];
  const packed = assets?.packed ?? true;
  const dir =
    configured !== undefined && configured !== ''
      ? resolve(configured)
      : assets === null
        ? null
        : assets.packed
          ? join(homedir(), '.txt2sfx', 'stable-audio')
          : assets.dir;
  if (dir === null) return null;
  return {
    dir,
    script: join(dir, 'run.py'),
    venv: join(dir, '.venv'),
    venvPython: join(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    outDir: join(dir, 'out'),
    packed,
  };
}

/**
 * Put `run.py` and `requirements.txt` where the workspace expects them.
 *
 * Copied rather than run in place because `run.py` builds its venv next to itself,
 * and "next to itself" inside an npx cache is a directory that can vanish between
 * two invocations of the same command. Rewritten whenever the bytes differ, so a
 * bridge upgrade updates the script — the venv survives that, because `run.py`'s own
 * stamp holds a fingerprint of `requirements.txt` and syncs when it moves.
 */
export async function ensureWorkspace(place: Workspace): Promise<void> {
  const assets = assetDir();
  /* The condition is "the workspace is not where the scripts already are", not "this
     is a published build": `TXT2SFX_STABLE_AUDIO_DIR` pointed at a disk with room on
     it is a checkout whose workspace is somewhere else, and it needs the copy just as
     much as an npx install does. */
  if (assets === null || resolve(assets.dir) === resolve(place.dir)) return;
  await mkdir(place.dir, { recursive: true });
  for (const name of ASSETS) {
    const from = join(assets.dir, name);
    const to = join(place.dir, name);
    if (!existsSync(from)) continue;
    if (existsSync(to)) {
      const [a, b] = await Promise.all([readFile(from), readFile(to)]);
      if (a.equals(b)) continue;
    }
    await copyFile(from, to);
  }
}

/** The Hugging Face cache root, following the same variables the Python side does. */
export function hfCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['HF_HUB_CACHE'];
  if (explicit !== undefined && explicit !== '') return resolve(explicit);
  const home = env['HF_HOME'];
  if (home !== undefined && home !== '') return join(resolve(home), 'hub');
  return join(homedir(), '.cache', 'huggingface', 'hub');
}

/** The cache directory a repo id gets: `owner/name` → `models--owner--name`. */
export function modelCacheDir(cacheDir: string, repo: string): string {
  return join(cacheDir, `models--${repo.replace(/\//g, '--')}`);
}

/* --- measuring ---------------------------------------------------------------- */

/**
 * Bytes under a directory, not following symlinks.
 *
 * Not following them is the whole reason this is not one line: the Hugging Face cache
 * stores each file once under `blobs/` and links it into `snapshots/<revision>/`, so a
 * walk that followed links would report 3.4 GB for a 1.7 GB checkpoint on Linux and
 * 1.7 GB on a Windows box that copied instead — the same model, two different answers.
 * Counting only what the entries themselves occupy gives the number the disk agrees with.
 */
export async function dirSize(path: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await dirSize(full);
      continue;
    }
    try {
      total += (await stat(full)).size;
    } catch {
      /* A file that vanished mid-walk (a download finishing) is worth zero, not a throw. */
    }
  }
  return total;
}

/**
 * A directory size, remembered for a minute.
 *
 * Walking a provisioned venv is forty thousand `stat` calls, which is a second or two
 * on Windows — cheap once, rude every time a panel re-renders. A minute is short
 * enough that the number is still true after a download and long enough that the
 * status call is free while somebody reads the page.
 */
const SIZE_TTL_MS = 60_000;
const sizes = new Map<string, { bytes: number; at: number }>();

async function cachedSize(path: string): Promise<number> {
  const hit = sizes.get(path);
  const now = Date.now();
  if (hit !== undefined && now - hit.at < SIZE_TTL_MS) return hit.bytes;
  const bytes = await dirSize(path);
  sizes.set(path, { bytes, at: now });
  return bytes;
}

/**
 * Bytes as a human reads them, in the units the download pages use.
 *
 * Powers of 1024 with the shorter names, matching `run.py`'s own `human_bytes` and
 * what Hugging Face prints while fetching — one number in two places that disagree by
 * 7% is a support question nobody needs.
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(Math.round(value)) : value.toFixed(2)} ${units[unit] ?? 'B'}`;
}

/** Forget the cached sizes — after a provisioning run they are all wrong at once. */
function forgetSizes(): void {
  sizes.clear();
}

/* --- what can launch python ---------------------------------------------------- */

/** How the workspace's `run.py` can be started before a venv exists. */
export interface Launcher {
  readonly command: string;
  /** Arguments that go *before* the script path. */
  readonly prefix: readonly string[];
  /** What to show a human: `python3`, or `uv run --python 3.10`. */
  readonly label: string;
}

/** Run a `--version` probe. Null unless it exits 0 and says something. */
async function probe(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((done) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [...args], { shell: false, windowsHide: true });
    } catch {
      done(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 && out.trim() !== '' ? out.trim().split(/\r?\n/)[0] ?? null : null);
    });
  });
}

/**
 * Find something that can run `run.py` from cold.
 *
 * A real interpreter is preferred over `uv run` even when both are present, because
 * `run.py`'s own bootstrap already looks for `uv` and will use it to build the 3.10
 * venv — going through `uv run` first would create a second, throwaway environment on
 * the way to the same place. `uv` alone is still enough, and that case matters: a
 * machine can have uv and no system python at all, and refusing there would be
 * refusing over an interpreter uv is about to download anyway.
 *
 * The Windows Store stub called `python` fails this probe, which is the intent — it
 * exits non-zero and prints an advert rather than a version.
 */
export async function findLauncher(): Promise<{ launcher: Launcher | null; uv: string | null; python: string | null }> {
  /* Four process launches, and `status()` is answered every time the panel opens. The
     window is short on purpose: installing uv and pressing the button again is the
     documented fix for `needs-python`, and a cache that outlived that would answer the
     retry with the reason the user just removed. */
  const now = Date.now();
  if (launcherCache !== null && now - launcherCache.at < LAUNCHER_TTL_MS) return launcherCache.value;
  const value = await probeLaunchers();
  launcherCache = { value, at: now };
  return value;
}

const LAUNCHER_TTL_MS = 30_000;
let launcherCache: { value: Awaited<ReturnType<typeof probeLaunchers>>; at: number } | null = null;

async function probeLaunchers(): Promise<{ launcher: Launcher | null; uv: string | null; python: string | null }> {
  const [uv, ...pythons] = await Promise.all([
    probe('uv', ['--version']),
    probe('python3', ['--version']),
    probe('python', ['--version']),
    probe('py', ['-3', '--version']),
  ]);
  const found = ([['python3', []], ['python', []], ['py', ['-3']]] as const).map(
    ([command, prefix], index) => ({ command, prefix, version: pythons[index] ?? null }),
  );
  const python = found.find((entry) => entry.version !== null && /Python 3\.\d+/.test(entry.version));

  if (python !== undefined) {
    return {
      launcher: { command: python.command, prefix: python.prefix, label: `${python.command} (${python.version ?? ''})` },
      uv,
      python: python.version,
    };
  }
  if (uv !== null) {
    /* `--no-project` so a pyproject.toml in whatever directory the daemon was started
       from cannot drag its own dependencies into the launch. */
    return {
      launcher: { command: 'uv', prefix: ['run', '--no-project', '--python', '3.10'], label: `uv run (${uv})` },
      uv,
      python: null,
    };
  }
  return { launcher: null, uv, python: null };
}

/* --- building the argv ----------------------------------------------------------- */

/** True when a string carries a C0 control character or DEL. */
function hasControlChars(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Check a repo id, or throw the sentence that says what one looks like. */
function checkRepo(value: unknown): string {
  if (typeof value !== 'string' || !REPO_RE.test(value)) {
    throw new Error('repo must be a Hugging Face id of the form owner/name');
  }
  return value;
}

/**
 * Build the argv for a `run.py` render from an untrusted body.
 *
 * Every number is range-checked here rather than left to Python: `--steps 1e9` is
 * a hang somebody has to notice and kill, and a hang started from a browser tab is
 * the worst kind. The ranges are wide enough to be worth playing with and narrow
 * enough that the worst case is still a render.
 *
 * @throws When the body cannot be turned into a run.
 */
export function renderArgs(body: ModelRenderParams): string[] {
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
    argv.push('--repo', checkRepo(body.repo));
  }
  return argv;
}

/** Build the argv for a provisioning run. Same validation, far fewer knobs. */
export function provisionArgs(body: ModelProvisionParams = {}): string[] {
  const argv = ['--provision'];
  if (body.model !== undefined && body.model !== null && body.model !== '') {
    if (typeof body.model !== 'string' || !MODELS.has(body.model)) {
      throw new Error(`model must be one of ${[...MODELS].join(', ')}`);
    }
    argv.push('--model', body.model);
  }
  if (body.repo !== undefined && body.repo !== null && body.repo !== '') {
    argv.push('--repo', checkRepo(body.repo));
  }
  /* Not a knob the panel offers, but the one flag that saves a 3 GB download on a
     machine whose GPU is busy with something else. */
  if (body.cpuTorch === true) argv.push('--cpu-torch');
  return argv;
}

/* --- reading what the child says --------------------------------------------------- */

/**
 * Cut a chunk of child output into whole lines.
 *
 * `\r` is a line here as much as `\n` is: tqdm redraws its bar with a carriage
 * return, and treating that as "no line yet" means the progress bar arrives as one
 * enormous line after the step it was reporting has finished — and a 1.7 GB download
 * reports itself entirely through that bar.
 *
 * @returns The complete lines, and the remainder to prepend to the next chunk.
 */
export function splitLines(chunk: string, carry: string): { lines: string[]; carry: string } {
  const parts = (carry + chunk).split(/\r\n|\r|\n/);
  const rest = parts.pop() ?? '';
  return { lines: parts.map((line) => line.trimEnd()).filter((line) => line !== ''), carry: rest };
}

/** What `run.py --stdout` says about the bytes it wrote. */
export interface RenderResultLine {
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
}

/**
 * Read the `txt2sfx-result {…}` line, or null for any other line.
 *
 * What this needs from it is the name and the media type, and both are decided in
 * `run.py`: the filename rule is its `slugify` and the encoding is its `--format`
 * default. Deriving either here would be a second definition of the same thing, wrong
 * the first time one side moves. Anything malformed is treated as ordinary output — a
 * line the child wrote is worth showing, never worth crashing on.
 */
export function parseResult(line: string): RenderResultLine | null {
  if (!line.startsWith(RESULT_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(RESULT_PREFIX.length)) as Partial<RenderResultLine>;
    if (typeof value.name !== 'string' || !RENDER_NAME_RE.test(value.name)) return null;
    if (typeof value.mime !== 'string' || !/^audio\/[\w.+-]{1,32}$/.test(value.mime)) return null;
    return { name: value.name, mime: value.mime, bytes: Number(value.bytes) || 0 };
  } catch {
    return null;
  }
}

/** What `run.py --provision` reports about what it downloaded, or null. */
export function parseProvisioned(
  line: string,
): { repo: string; modelDir: string; modelBytes: number; torch: string; device: string } | null {
  if (!line.startsWith(PROVISIONED_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(PROVISIONED_PREFIX.length)) as Record<string, unknown>;
    const repo = value['repo'];
    const dir = value['model_dir'];
    if (typeof repo !== 'string' || typeof dir !== 'string') return null;
    return {
      repo,
      modelDir: dir,
      modelBytes: Number(value['model_bytes']) || 0,
      torch: typeof value['torch'] === 'string' ? value['torch'] : '',
      device: typeof value['device'] === 'string' ? value['device'] : '',
    };
  } catch {
    return null;
  }
}

/**
 * The torch variant `run.py` recorded when it built the venv.
 *
 * `cpu` or a CUDA tag, `''` for anything else, null when there is no stamp at all.
 * Venvs built before that stamp meant anything wrote a bare `ok`, and reporting
 * "torch/ok" at a reader would be worse than reporting nothing — the same reason
 * `run.py`'s own `read_stamp` refuses to trust an unrecognised tag.
 */
async function stampedTorch(venv: string): Promise<string | null> {
  try {
    const text = await readFile(join(venv, '.deps-installed'), 'utf8');
    const tag = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('reqs='));
    return tag === undefined || !/^(cpu|cu\d+)$/.test(tag) ? '' : tag;
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

/** Is the checkpoint actually in the cache, or is the directory a failed attempt? */
async function weightsPresent(dir: string): Promise<boolean> {
  const snapshots = join(dir, 'snapshots');
  let revisions;
  try {
    revisions = await readdir(snapshots, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const revision of revisions) {
    if (!revision.isDirectory()) continue;
    const at = join(snapshots, revision.name);
    if (existsSync(join(at, 'model.safetensors')) || existsSync(join(at, 'model.ckpt'))) return true;
  }
  return false;
}

/* --- the thing itself -------------------------------------------------------------- */

/** Options of {@link StableAudio}. */
export interface StableAudioOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: Log;
  /** Force a workspace directory; tests point this at a temp dir. */
  readonly dir?: string;
}

/**
 * One machine's Stable Audio installation, and the one process allowed to drive it.
 *
 * A single instance per daemon, because the lock is the point: torch takes every core
 * a CPU has, and two renders would each take twice as long as one. Provisioning shares
 * the same lock — downloading the weights while a render is trying to read them is a
 * corrupt file at best.
 */
export class StableAudio {
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: Log;
  private readonly place: Workspace | null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private job: 'render' | 'provision' | null = null;

  constructor(options: StableAudioOptions = {}) {
    this.env = options.env ?? process.env;
    this.log = options.log ?? ((): void => {});
    this.place = workspace(this.env, options.dir);
  }

  /** Where this instance would work, or null when no `run.py` could be found. */
  workspace(): Workspace | null {
    return this.place;
  }

  /** True while a child is running. A second request is refused, not queued. */
  busy(): boolean {
    return this.child !== null;
  }

  /** Stop whatever is running. False when there was nothing to stop. */
  cancel(): boolean {
    if (this.child === null) return false;
    this.child.kill();
    return true;
  }

  /** The default repo for this machine, which `STABLE_AUDIO_REPO` may override. */
  private defaultRepo(): string {
    const configured = this.env['STABLE_AUDIO_REPO'];
    return configured !== undefined && configured !== '' ? configured : DEFAULT_REPO;
  }

  /** The token to hand the child, and where it came from. */
  private token(): { value: string | null; source: 'env' | 'file' | null } {
    const fromEnv = this.env['HF_TOKEN'] ?? this.env['HUGGINGFACE_HUB_TOKEN'] ?? '';
    if (fromEnv !== '') return { value: fromEnv, source: 'env' };
    /* `huggingface-cli login` writes here, and someone who ran it has every right to
       expect the button to work without exporting anything. */
    const home = this.env['HF_HOME'];
    const file = home !== undefined && home !== '' ? join(resolve(home), 'token') : join(homedir(), '.cache', 'huggingface', 'token');
    if (existsSync(file)) {
      try {
        const text = readTokenFile(file);
        if (text !== '') return { value: text, source: 'file' };
      } catch {
        /* Unreadable is the same as absent for the purpose of the badge. */
      }
    }
    return { value: null, source: null };
  }

  /**
   * Everything the Model tab needs to decide what to show.
   *
   * Deliberately answers even when nothing is installed: "what is missing and what
   * will fix it" is the whole content of the first screen, and a status call that
   * failed on an absent venv would leave the panel with nothing to say.
   */
  async status(params: { readonly repo?: string } = {}): Promise<ModelStatus> {
    const place = this.place;
    /* Validated even though nothing is spawned from it: the id becomes a directory
       name that is walked for its size and reported back, and `../..` would turn a
       status call into a way to ask how big an arbitrary directory is. */
    const asked = params.repo !== undefined && params.repo !== '' && REPO_RE.test(params.repo) ? params.repo : null;
    const repo = asked ?? this.defaultRepo();
    const cacheDir = hfCacheDir(this.env);
    const weightsDir = modelCacheDir(cacheDir, repo);
    const token = this.token();

    if (place === null) {
      return {
        stage: 'unavailable',
        ready: false,
        busy: false,
        running: null,
        reason:
          'this build of the bridge carries no copy of run.py — reinstall txt2sfx-bridge, or point TXT2SFX_STABLE_AUDIO_DIR at a checkout of test/stable-audio',
        workDir: '',
        script: null,
        venv: { path: '', present: false, bytes: 0, torch: null },
        weights: { repo, dir: weightsDir, present: false, bytes: 0 },
        cacheDir,
        gated: repo === DEFAULT_REPO,
        licenceUrl: LICENCE_URL,
        tokensUrl: TOKENS_URL,
        hasToken: token.value !== null,
        tokenSource: token.source,
        launcher: null,
        uv: null,
        python: null,
        defaults: { ...DEFAULTS, repo },
        renders: [],
      };
    }

    const venvPresent = existsSync(place.venvPython) && existsSync(join(place.venv, '.deps-installed'));
    const present = await weightsPresent(weightsDir);

    /* The interpreter probe costs two process launches, so it is skipped once the venv
       exists: at that point nothing needs a launcher except a repair, and a repair is
       started from a terminal. */
    const tools = venvPresent
      ? { launcher: null, uv: null, python: null }
      : await findLauncher();

    const [venvBytes, weightBytes] = await Promise.all([
      venvPresent ? cachedSize(place.venv) : Promise.resolve(0),
      present ? cachedSize(weightsDir) : Promise.resolve(0),
    ]);

    const stage: ModelStatus['stage'] = !venvPresent
      ? tools.launcher === null
        ? 'needs-python'
        : 'needs-venv'
      : present
        ? 'ready'
        : 'needs-weights';

    return {
      stage,
      ready: stage === 'ready',
      busy: this.child !== null,
      running: this.job,
      ...(stage === 'needs-python'
        ? {
            reason:
              'no Python was found to build the environment with — install uv (`winget install --id astral-sh.uv`, or `pip install uv`) and press this again; uv fetches the CPython 3.10 that stable-audio-tools pins',
          }
        : {}),
      workDir: place.dir,
      script: place.script,
      venv: { path: place.venv, present: venvPresent, bytes: venvBytes, torch: await stampedTorch(place.venv) },
      weights: { repo, dir: weightsDir, present, bytes: weightBytes },
      cacheDir,
      /* Only the checkpoint Stability publishes is behind the licence click. A mirror
         is not, which is exactly why `--repo` exists — so the panel must not show the
         licence steps to somebody who has already routed around them. */
      gated: repo === DEFAULT_REPO,
      licenceUrl: LICENCE_URL,
      tokensUrl: TOKENS_URL,
      hasToken: token.value !== null,
      tokenSource: token.source,
      launcher: tools.launcher?.label ?? null,
      uv: tools.uv,
      python: tools.python,
      defaults: { ...DEFAULTS, repo },
      renders: await listRenders(place.outDir),
    };
  }

  /**
   * Build the environment and download the weights, reporting every line.
   *
   * The launcher is preferred over the venv's own interpreter even when the venv
   * exists, because `run.py`'s bootstrap is also its repair path: it re-syncs a venv
   * whose `requirements.txt` moved, and costs about a second when nothing did. Falling
   * back to the venv interpreter covers the machine that has no system Python at all —
   * there, the weights can still be fetched, which is the other half of this job.
   */
  async provision(
    params: ModelProvisionParams = {},
    onEvent: (event: ModelEvent) => void = () => {},
  ): Promise<ModelProvisionResult> {
    const place = this.place;
    if (place === null) throw new Error((await this.status()).reason ?? 'no run.py');
    await ensureWorkspace(place);

    const argv = provisionArgs({ ...params, repo: params.repo ?? this.defaultRepo() });
    const { launcher } = await findLauncher();

    let command: string;
    let args: string[];
    if (launcher !== null) {
      command = launcher.command;
      args = [...launcher.prefix, place.script, ...argv];
    } else if (existsSync(place.venvPython)) {
      command = place.venvPython;
      args = [place.script, ...argv];
    } else {
      throw new Error(
        'no Python and no uv on PATH — install uv (`winget install --id astral-sh.uv`, or `pip install uv`), then press this again',
      );
    }

    let provisioned: { torch: string; device: string } | null = null;
    await this.spawn('provision', command, args, params.token, PROVISION_TIMEOUT_MS, {
      onEvent,
      /* Provisioning writes nothing to stdout worth keeping, so both streams are read
         as text: pip and huggingface_hub split their output between the two and a
         human who is watching a download wants all of it. */
      onLine: (line) => {
        const parsed = parseProvisioned(line);
        if (parsed !== null) provisioned = parsed;
        else onEvent({ type: 'log', line });
      },
      audio: false,
    });

    forgetSizes();
    const status = await this.status(params.repo === undefined ? {} : { repo: params.repo });
    if (!status.ready) {
      throw new Error(
        status.reason ??
          'provisioning finished without leaving a usable installation — the lines above say what stopped it',
      );
    }
    return { status, ...(provisioned === null ? {} : provisioned) };
  }

  /**
   * Render one prompt, reporting progress as it arrives.
   *
   * The audio comes back in memory and is never written down: a target is consumed
   * once, by the reference slot, and a session of clicking the button should not leave
   * a directory to sweep up. `out/` still exists for what a terminal run put there.
   */
  async render(
    request: ModelRenderParams,
    onEvent: (event: ModelEvent) => void = () => {},
  ): Promise<ModelRenderResult & { readonly audio: Buffer }> {
    const place = this.place;
    if (place === null) throw new Error((await this.status()).reason ?? 'no run.py');
    if (!existsSync(place.venvPython)) {
      throw new Error('the model is not installed yet — use the Model tab\'s install button first');
    }

    /* A caller that says nothing about the repo gets the machine's own default, so a
       box whose cache holds a mirror of the gated checkpoint works without every
       caller having to know that. */
    const argv = renderArgs({ ...request, repo: request.repo ?? this.defaultRepo() });

    const chunks: Buffer[] = [];
    let result: RenderResultLine | null = null;
    const startedMs = Date.now();

    await this.spawn('render', place.venvPython, [place.script, ...argv], request.token, RENDER_TIMEOUT_MS, {
      onEvent,
      onLine: (line) => {
        const parsed = parseResult(line);
        if (parsed === null) onEvent({ type: 'log', line });
        else result = parsed;
      },
      audio: true,
      onAudio: (chunk) => chunks.push(chunk),
    });

    if (result === null || chunks.length === 0) {
      throw new Error('run.py finished without writing audio to stdout');
    }
    const audio = Buffer.concat(chunks);
    const named: RenderResultLine = result;
    return { name: named.name, mime: named.mime, bytes: audio.byteLength, ms: Date.now() - startedMs, audio };
  }

  /** A render a terminal run left in `out/`, by name. */
  async read(name: string): Promise<{ bytes: Buffer; mime: string }> {
    const place = this.place;
    if (place === null) throw new Error('no workspace');
    if (!RENDER_NAME_RE.test(name)) throw new Error(`not a render name: ${name}`);
    const target = join(place.outDir, name);
    // Belt and braces: RENDER_NAME_RE already excludes separators and dots.
    if (!target.startsWith(place.outDir + sep)) throw new Error('refusing to read outside out/');
    return { bytes: await readFile(target), mime: name.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg' };
  }

  /**
   * The one place a child process is started.
   *
   * `shell: false` and the prompt as a single argv element, so it is text to Python
   * and never to a shell. The token travels in the environment rather than in argv:
   * argv is echoed in the `start` event, is visible in the process list to every other
   * user on the machine, and would end up in whatever log the caller keeps.
   */
  private spawn(
    job: 'render' | 'provision',
    command: string,
    args: readonly string[],
    token: string | undefined,
    timeoutMs: number,
    handlers: {
      onEvent: (event: ModelEvent) => void;
      onLine: (line: string) => void;
      audio: boolean;
      onAudio?: (chunk: Buffer) => void;
    },
  ): Promise<void> {
    if (this.child !== null) {
      return Promise.reject(
        new Error(
          this.job === 'provision'
            ? 'the model is being installed — one at a time'
            : 'a render is already running — one at a time',
        ),
      );
    }

    if (token !== undefined && token !== '' && !TOKEN_RE.test(token)) {
      return Promise.reject(
        new Error('that does not look like a Hugging Face token — paste the `hf_…` value itself, nothing around it'),
      );
    }

    const child = spawn(command, [...args], {
      cwd: this.place?.dir ?? process.cwd(),
      shell: false,
      windowsHide: true,
      env: {
        ...this.env,
        PYTHONUNBUFFERED: '1',
        /* Both streams are read as UTF-8 here, so the child has to write it. Without
           this, Python picks the locale encoding for a pipe — cp1251 on a Russian
           Windows install — and the line that echoes the prompt back arrives as
           replacement characters. That looked exactly like a prompt that had been
           corrupted on the way in, which it was not: argv reaches `sys.argv` intact
           (CreateProcessW carries UTF-16), and only the echo was ever wrong. The audio
           is unaffected either way — `claim_stdout()` reopens fd 1 in binary. */
        PYTHONIOENCODING: 'utf-8',
        ...(token === undefined || token === '' ? {} : { HF_TOKEN: token }),
      },
    });
    this.child = child;
    this.job = job;
    handlers.onEvent({ type: 'start', argv: args });
    this.log(`stable-audio: ${command} ${args.join(' ')}`);

    return new Promise<void>((settle, fail) => {
      let audioBytes = 0;
      let overflowed = false;
      let carry = '';
      let failure: string | null = null;

      const take = (chunk: Buffer): void => {
        const split = splitLines(chunk.toString('utf8'), carry);
        carry = split.carry;
        for (const line of split.lines) handlers.onLine(line);
      };

      if (handlers.audio) {
        /* stdout is the audio and stderr is everything a human reads — that split is
           what `--stdout` buys, and it is why the two handlers are not the same. */
        child.stdout.on('data', (chunk: Buffer) => {
          audioBytes += chunk.byteLength;
          if (audioBytes > MAX_AUDIO) {
            if (!overflowed) {
              overflowed = true;
              failure = `run.py wrote more than ${String(MAX_AUDIO)} bytes of audio — killed`;
              child.kill();
            }
            return;
          }
          handlers.onAudio?.(chunk);
        });
      } else {
        child.stdout.on('data', take);
      }
      child.stderr.on('data', take);

      const timer = setTimeout(() => {
        failure = `no result after ${String(Math.round(timeoutMs / 60000))} minutes — killed`;
        child.kill();
      }, timeoutMs);

      child.on('error', (error) => {
        failure ??= `could not start ${command}: ${error.message}`;
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        this.child = null;
        this.job = null;
        if (carry !== '') handlers.onLine(carry);

        if (failure !== null) fail(new Error(failure));
        else if (code === 0) settle();
        else if (signal !== null) fail(new Error(`run.py was stopped (${signal})`));
        else fail(new Error(`run.py exited with ${String(code)} — see the lines above`));
      });
    });
  }
}

/** The token file, trimmed. The one synchronous read here: it happens inside
 * `status`, which is answered per panel render, and the file is one short line. */
function readTokenFile(path: string): string {
  return readFileSync(path, 'utf8').trim();
}
