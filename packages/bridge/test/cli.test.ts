/**
 * The command line, and the one check that decides whether any of it runs.
 *
 * `runningAsScript` earns a test of its own because its failure mode has no symptom:
 * when it answers `false` by mistake the process exits 0 having printed nothing, which
 * looks like a fast, successful, silent command. That is exactly what shipped — npm
 * installs a bin as a symlink in `node_modules/.bin` on POSIX, Node's ESM loader
 * resolves symlinks before handing a module its own URL, and the two paths therefore
 * never matched. Windows hid it, because npm writes a `.cmd` shim carrying the real
 * path. So the test goes through a symlink on purpose: that is the shape of a real
 * install, and the developer machine is the one place it does not happen.
 */

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCliOptions, runningAsScript } from '../src/cli.js';

describe('runningAsScript', () => {
  let dir = '';
  let real = '';
  let link = '';
  /** Windows refuses symlinks without Developer Mode; POSIX never does. */
  let linked = false;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'txt2sfx-cli-'));
    real = join(dir, 'txt2sfx-bridge.mjs');
    link = join(dir, 'bin-link');
    await writeFile(real, '// stands in for the published bundle\n', 'utf8');
    try {
      await symlink(real, link);
      linked = true;
    } catch {
      linked = false;
    }
  });

  afterAll(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('recognises the module when it is invoked by its own path', () => {
    expect(runningAsScript(pathToFileURL(real).href, real)).toBe(true);
  });

  /* The regression. `node_modules/.bin/txt2sfx-bridge` is this symlink, and the URL
     the loader gives the module is the target — so a raw comparison says "not the
     program" and the whole CLI silently does nothing. */
  it('recognises it through the symlink npm installs on POSIX', (ctx) => {
    if (!linked) {
      ctx.skip();
      return;
    }
    expect(runningAsScript(pathToFileURL(real).href, link)).toBe(true);
  });

  it('says no when something else is the program', () => {
    expect(runningAsScript(pathToFileURL(real).href, join(dir, 'somebody-else.mjs'))).toBe(false);
    expect(runningAsScript(pathToFileURL(real).href, undefined)).toBe(false);
  });

  /* Importing this module from a test must not start a daemon, which is the whole
     reason the guard exists. Under vitest argv[1] is the runner, not the CLI. */
  it('says no when a test is what imported the module', () => {
    expect(runningAsScript(pathToFileURL(fileURLToPath(import.meta.url)).href, process.argv[1])).toBe(false);
  });

  /* argv[1] can name something unopenable — `node --eval`, odd launchers. A guard
     that threw there would take the process down before it printed its usage. */
  it('does not throw on an argv[1] that is not a file', () => {
    expect(() => runningAsScript(pathToFileURL(real).href, join(dir, 'no', 'such', 'path'))).not.toThrow();
  });
});

describe('parseCliOptions', () => {
  it('defaults to serving on the documented port', () => {
    const options = parseCliOptions([]);
    expect(options.command).toBe('serve');
    expect(options.port).toBe(4455);
  });

  it('reads the four shapes of the same process', () => {
    expect(parseCliOptions(['doctor']).command).toBe('doctor');
    expect(parseCliOptions(['claude']).command).toBe('claude');
    expect(parseCliOptions(['--stdio']).command).toBe('stdio');
    expect(parseCliOptions(['--help']).command).toBe('help');
  });

  /* A bad flag has to be loud: a typo that silently became "serve on 4455" would look
     like the flag worked. */
  it('refuses a flag it does not know, and a port that is not one', () => {
    expect(() => parseCliOptions(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseCliOptions(['--port', 'soon'])).toThrow(/--port/);
    expect(() => parseCliOptions(['--allow-origin'])).toThrow(/--allow-origin/);
  });

  it('takes the bank from the environment, and the flag wins', () => {
    expect(parseCliOptions([], { TXT2SFX_BANK: 'http://bank.local' }).bankUrl).toBe('http://bank.local');
    expect(parseCliOptions(['--bank', 'http://flag.local/'], { TXT2SFX_BANK: 'http://bank.local' }).bankUrl).toBe(
      'http://flag.local',
    );
  });
});
