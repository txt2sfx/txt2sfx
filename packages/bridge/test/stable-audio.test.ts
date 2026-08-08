/**
 * The boundary between this process and `run.py`.
 *
 * What is worth testing here is exactly that boundary, not the model: an argv built
 * from an untrusted body (the daemon spawns a process with it), the line splitter that
 * has to cope with tqdm's carriage returns, and the two machine-readable lines by which
 * the child names what it produced. Everything else is a multi-gigabyte download and
 * twenty seconds of CPU, which is not a unit test.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureWorkspace,
  formatBytes,
  hfCacheDir,
  modelCacheDir,
  parseProvisioned,
  parseResult,
  provisionArgs,
  renderArgs,
  splitLines,
  workspace,
  type Workspace,
} from '../src/stable-audio.js';

describe('renderArgs', () => {
  it('passes the prompt as one argument and streams the result', () => {
    expect(renderArgs({ prompt: '  glass bottle shattering  ' })).toEqual([
      'glass bottle shattering',
      '--stdout',
    ]);
  });

  /* `--stdout` is the whole reason a click leaves nothing in out/. Losing it would
     not fail loudly — it would quietly go back to filling a directory. */
  it('always asks for the audio on stdout', () => {
    expect(renderArgs({ prompt: 'thud', seconds: 2 })).toContain('--stdout');
  });

  it('forwards the knobs the panel offers', () => {
    expect(renderArgs({ prompt: 'coin pickup', seconds: 2.5, steps: 16, seed: 42 })).toEqual([
      'coin pickup',
      '--stdout',
      '--seconds',
      '2.5',
      '--steps',
      '16',
      '--seed',
      '42',
    ]);
  });

  /* An empty field in the form is "leave it to run.py", not "zero". */
  it('treats empty and absent values as the preset default', () => {
    expect(renderArgs({ prompt: 'thud', seconds: '', steps: null, seed: undefined })).toEqual([
      'thud',
      '--stdout',
    ]);
  });

  it('refuses a run it cannot describe', () => {
    expect(() => renderArgs({})).toThrow(/prompt/);
    expect(() => renderArgs({ prompt: '   ' })).toThrow(/prompt/);
    expect(() => renderArgs({ prompt: 'x'.repeat(500) })).toThrow(/longer/);
    expect(() => renderArgs({ prompt: 'a\nb' })).toThrow(/control/);
  });

  /* The ceilings are the point: `--steps 1e9` is a hang somebody has to notice and
     kill, and a hang started from a browser tab is the worst kind. */
  it('bounds every number rather than passing it through', () => {
    expect(() => renderArgs({ prompt: 'x', steps: 1e9 })).toThrow(/steps/);
    expect(() => renderArgs({ prompt: 'x', seconds: 400 })).toThrow(/seconds/);
    expect(() => renderArgs({ prompt: 'x', seconds: 0 })).toThrow(/seconds/);
    expect(() => renderArgs({ prompt: 'x', seed: -1 })).toThrow(/seed/);
    expect(() => renderArgs({ prompt: 'x', seconds: 'soon' })).toThrow(/seconds/);
  });

  it('only accepts the presets run.py knows', () => {
    expect(renderArgs({ prompt: 'x', model: 'sfx3' })).toContain('sfx3');
    expect(() => renderArgs({ prompt: 'x', model: 'huge' })).toThrow(/model/);
  });

  /* The repo is how a machine reaches the checkpoint it actually has cached, and
     it is also the one field that could smuggle a flag or a path into the argv. */
  it('accepts a repo id and nothing shaped like a path or a flag', () => {
    expect(renderArgs({ prompt: 'x', repo: 'joeriben/stable-audio-open-small' })).toEqual([
      'x',
      '--stdout',
      '--repo',
      'joeriben/stable-audio-open-small',
    ]);
    expect(() => renderArgs({ prompt: 'x', repo: '--cpu' })).toThrow(/repo/);
    expect(() => renderArgs({ prompt: 'x', repo: '../../etc/passwd' })).toThrow(/repo/);
    expect(() => renderArgs({ prompt: 'x', repo: 'no-owner' })).toThrow(/repo/);
  });
});

describe('splitLines', () => {
  it('holds back a partial line for the next chunk', () => {
    const first = splitLines('loaded in 10.1s\nsampl', '');
    expect(first.lines).toEqual(['loaded in 10.1s']);
    expect(splitLines('ed in 8.1s\n', first.carry).lines).toEqual(['sampled in 8.1s']);
  });

  /* tqdm redraws its bar with a carriage return. Treating that as "no line yet"
     means the progress arrives in one lump after the step it was reporting ended. */
  it('treats a carriage return as a line', () => {
    expect(splitLines('12%|#\r50%|#####\r', '').lines).toEqual(['12%|#', '50%|#####']);
    expect(splitLines('a\r\nb\r\n', '').lines).toEqual(['a', 'b']);
  });
});

describe('parseResult', () => {
  it('reads the name and media type run.py reports for its stdout', () => {
    expect(
      parseResult('txt2sfx-result {"name":"thud-42.mp3","mime":"audio/mpeg","bytes":131072,"seed":42}'),
    ).toEqual({ name: 'thud-42.mp3', mime: 'audio/mpeg', bytes: 131072 });
  });

  it('leaves every other line alone', () => {
    expect(parseResult('loaded in 10.1s on cpu')).toBeNull();
    expect(parseResult('txt2sfx-result not json')).toBeNull();
  });

  /* The name becomes a File name and the mime goes to `decodeAudioData`. Neither is
     attacker-controlled here, but both come off a pipe, and a plausible-looking line
     is exactly what would make a bad one hard to spot. */
  it('refuses a name or a type it would not have written itself', () => {
    expect(parseResult('txt2sfx-result {"name":"../x.mp3","mime":"audio/mpeg"}')).toBeNull();
    expect(parseResult('txt2sfx-result {"name":"x.exe","mime":"audio/mpeg"}')).toBeNull();
    expect(parseResult('txt2sfx-result {"name":"x.mp3","mime":"text/html"}')).toBeNull();
    expect(parseResult('txt2sfx-result {"mime":"audio/mpeg"}')).toBeNull();
  });
});

describe('provisionArgs', () => {
  it('asks run.py to install and nothing else', () => {
    expect(provisionArgs()).toEqual(['--provision']);
  });

  /* The repo field is the way past the licence gate, so it is also the field most
     worth smuggling a flag through. Same check as the render path, on purpose. */
  it('validates the repo the same way a render does', () => {
    expect(provisionArgs({ repo: 'joeriben/stable-audio-open-small' })).toEqual([
      '--provision',
      '--repo',
      'joeriben/stable-audio-open-small',
    ]);
    expect(() => provisionArgs({ repo: '--reinstall' })).toThrow(/repo/);
    expect(() => provisionArgs({ model: 'huge' })).toThrow(/model/);
  });

  it('can spare a GPU box the three-gigabyte CUDA download', () => {
    expect(provisionArgs({ cpuTorch: true })).toContain('--cpu-torch');
  });
});

describe('parseProvisioned', () => {
  it('reads where the weights landed and what torch was built', () => {
    expect(
      parseProvisioned(
        'txt2sfx-provisioned {"repo":"stabilityai/stable-audio-open-small","model_dir":"/c/models--x","model_bytes":1800,"torch":"2.7.1","device":"cpu"}',
      ),
    ).toEqual({
      repo: 'stabilityai/stable-audio-open-small',
      modelDir: '/c/models--x',
      modelBytes: 1800,
      torch: '2.7.1',
      device: 'cpu',
    });
  });

  it('leaves every other line alone', () => {
    expect(parseProvisioned('Downloading model.safetensors: 41%')).toBeNull();
    expect(parseProvisioned('txt2sfx-provisioned {"repo":"x"}')).toBeNull();
  });
});

describe('the Hugging Face cache layout', () => {
  /* Reimplemented here rather than asked of Python, because the panel has to name the
     directory and its size before any Python exists to ask. If huggingface_hub ever
     changes this rule, this is the test that says so. */
  it('maps a repo id to the directory the hub actually uses', () => {
    expect(modelCacheDir('/cache', 'stabilityai/stable-audio-open-small')).toMatch(
      /models--stabilityai--stable-audio-open-small$/,
    );
  });

  it('follows HF_HUB_CACHE and HF_HOME, in that order', () => {
    /* Resolved, not passed through: a relative `HF_HUB_CACHE` would otherwise be
       reported against whatever directory the daemon happened to be started in. */
    expect(hfCache({ HF_HUB_CACHE: '/explicit' })).toMatch(/[\\/]explicit$/);
    expect(hfCache({ HF_HOME: '/home-of-hf' })).toMatch(/home-of-hf[\\/]hub$/);
  });
});

describe('the workspace', () => {
  /* The whole point of the packed copy: a user who installed the bridge with npx has
     no checkout, so the scripts and the venv have to live somewhere that survives. */
  it('honours an explicit directory over everything else', () => {
    const place = workspace({}, '/somewhere/else');
    expect(place?.dir).toMatch(/somewhere[\\/]else$/);
    expect(place?.script).toMatch(/run\.py$/);
    expect(place?.venvPython).toMatch(/(Scripts[\\/]python\.exe|bin[\\/]python)$/);
  });

  /* Running from this repository, the workspace *is* `test/stable-audio` — so a venv
     provisioned from a terminal and one provisioned from the Model tab are the same
     venv, and nobody ends up with two five-gigabyte copies. */
  it('uses the checkout when there is one', () => {
    const place = workspace({});
    expect(place?.dir).toMatch(/test[\\/]stable-audio$/);
    expect(place?.packed).toBe(false);
  });

  /* The half that makes `npx txt2sfx-bridge` self-sufficient. Someone installing the
     bridge has no checkout, so the installer has to be carried in the package and
     written out somewhere durable before anything can run it. */
  it('writes the installer into a workspace that does not have it', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'txt2sfx-ws-')), 'nested');
    const place = workspace({}, dir);
    expect(place).not.toBeNull();
    await ensureWorkspace(place as Workspace);
    expect(existsSync(join(dir, 'run.py'))).toBe(true);
    expect(existsSync(join(dir, 'requirements.txt'))).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  /* And never over the checkout's own copy, which is the file git tracks. */
  it('leaves the scripts alone when the workspace is where they live', async () => {
    const place = workspace({});
    await expect(ensureWorkspace(place as Workspace)).resolves.toBeUndefined();
  });
});

describe('formatBytes', () => {
  /* The number the panel shows next to a directory. It has to agree with what run.py
     prints and with what Hugging Face reports while fetching, or the same download
     appears to be two different sizes. */
  it('reads like a download page', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1_800_000_000)).toBe('1.68 GB');
  });
});

/** `hfCacheDir` with a hand-made environment — it defaults to the real one. */
function hfCache(env: NodeJS.ProcessEnv): string {
  return hfCacheDir(env);
}
