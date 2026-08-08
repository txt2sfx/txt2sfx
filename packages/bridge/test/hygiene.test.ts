/**
 * Claims the package makes about itself, kept honest.
 *
 * The version constant, the dependency story and the no-stdout rule are all
 * things that fail silently in production and never in a behavioural test —
 * so they get structural tests, in the same spirit as the repository's
 * documentation-drift checks.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bridgeOnboardingPrompt } from '@txt2sfx/agent';
import { TOOLS, TOOL_NAMES, VERSION } from '../src/index.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;

describe('the package manifest', () => {
  it('matches the VERSION constant, which the bundle ships instead of reading disk', () => {
    expect(manifest['version']).toBe(VERSION);
  });

  it('carries zero runtime dependencies — the badge is a claim, this is the check', () => {
    expect(manifest['dependencies']).toBeUndefined();
  });

  it('keeps the native renderer optional, so npx cannot fail on its account', () => {
    const optional = manifest['optionalDependencies'] as Record<string, string>;
    expect(Object.keys(optional)).toEqual(['node-web-audio-api']);
  });

  it('is publishable: public, with a bin pointing into dist', () => {
    expect(manifest['private']).toBeUndefined();
    expect((manifest['bin'] as Record<string, string>)['txt2sfx-bridge']).toBe('dist/txt2sfx-bridge.mjs');
  });

  it('ships the bundle, the installer scripts, and nothing else from dist', () => {
    // `tsc -b` fills dist with modules that import `@txt2sfx/*`, and those
    // packages are private and unpublishable. Shipping the whole directory
    // put files in the tarball that throw ERR_MODULE_NOT_FOUND on the first
    // import — plus a source map for every one of them. So the list is
    // enumerated, and every entry has to earn its place.
    //
    // The two Python files are the reason `npx txt2sfx-bridge` can install the
    // reference model for someone who has never cloned this repository: they are
    // the entire installer, `scripts/pack-assets.mjs` copies them out of
    // `test/stable-audio/`, and `src/stable-audio.ts` looks for them beside the
    // bundle before falling back to a checkout. Drop them and the Model tab's
    // install button has nothing to run.
    //
    // `render-child.mjs` is a second bundle rather than part of the first
    // because a process cannot fork itself into a different entry point: it is
    // the module the render subprocess runs, and `render.ts` finds it beside
    // the bundle the same way. Drop it and the bridge silently falls back to
    // rendering in-process, which works and leaks — see `render-child.ts`.
    expect(manifest['files']).toEqual([
      'dist/txt2sfx-bridge.mjs',
      'dist/render-child.mjs',
      'dist/stable-audio/run.py',
      'dist/stable-audio/requirements.txt',
      'README.md',
      'LICENSE',
    ]);
  });

  it('bundles the render subprocess as its own entry point', () => {
    // Same rule as the Python assets one line up: a `files` entry that no build
    // step produces ships as an absence, not as a failure. And the native module
    // must stay external in both bundles — bundling it would defeat the optional
    // dependency and break every platform without a prebuilt binary.
    const scripts = manifest['scripts'] as Record<string, string> | undefined;
    const bundle = scripts?.['bundle'] ?? '';
    expect(bundle).toContain('src/render-child.ts');
    expect(bundle).toContain('--outfile=dist/render-child.mjs');
    expect(bundle.match(/--external:node-web-audio-api/g)).toHaveLength(2);
  });

  it('packs those scripts as part of the bundle step, not by hand', () => {
    // A `files` entry naming a file no build step produces is a tarball that is
    // missing it — npm does not fail on the absence, it just ships without.
    expect(manifest['scripts']).toMatchObject({ bundle: expect.stringContaining('pack-assets.mjs') });
  });

  it('advertises no library entry, because the unbundled one cannot resolve for a consumer', () => {
    // The bundle is the product. `import('txt2sfx-bridge')` reaching
    // `dist/index.js` would pull the private workspace packages with it, so
    // the manifest must not promise an entry the tarball cannot honour;
    // in-repo consumers import `../src/index.js` directly and are unaffected.
    expect(manifest['main']).toBeUndefined();
    expect(manifest['exports']).toBeUndefined();
    expect(manifest['types']).toBeUndefined();
  });

  it('builds the bundle on pack, not only on publish — so `npm pack` shows the real tarball', () => {
    // `prepublishOnly` is skipped by `npm pack` and `npm publish --dry-run`,
    // which meant the rehearsal inspected whatever happened to be in dist.
    // `npm run` rather than `pnpm` because npm is the one package manager
    // guaranteed to exist wherever a lifecycle script runs.
    const scripts = manifest['scripts'] as Record<string, string>;
    expect(scripts['prepack']).toBe('npm run bundle');
    expect(scripts['prepublishOnly']).toBeUndefined();
  });

  it('points at its source, so the npm page can link back to the repository', () => {
    const repository = manifest['repository'] as Record<string, string>;
    expect(repository['url']).toContain('github.com/txt2sfx/txt2sfx');
    expect(repository['directory']).toBe('packages/bridge');
  });
});

describe('the no-stdout rule', () => {
  it('has no bare console.log anywhere in src — stdout belongs to JSON-RPC', () => {
    const srcDir = join(packageDir, 'src');
    for (const file of readdirSync(srcDir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(srcDir, file), 'utf8');
      expect(source, `${file} writes to stdout via console.log`).not.toMatch(/\bconsole\.log\(/);
    }
  });
});

describe('the twelve tools', () => {
  it('are exactly the twelve the spec names, in its order', () => {
    expect(TOOL_NAMES).toEqual([
      'sfx_contract',
      'sfx_validate',
      'sfx_render',
      'sfx_audition',
      'sfx_compare',
      'sfx_fit',
      'sfx_export',
      'sfx_open',
      'sfx_bank_search',
      'sfx_bank_publish',
      'sfx_next_request',
      'sfx_answer',
    ]);
  });

  it('each carry a real schema and a description worth reading', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(120);
      expect(tool.inputSchema['type']).toBe('object');
      expect(tool.inputSchema['properties']).toBeDefined();
    }
  });

  it('sfx_contract tells the model to call it first', () => {
    const contract = TOOLS.find((tool) => tool.name === 'sfx_contract');
    expect(contract?.description).toContain('Call this first');
  });
});

describe('the pasted onboarding prompt', () => {
  /* It lives in `@txt2sfx/agent` because the playground copies it too, but the
     tools it names are this package's — and a prompt that sends an agent after
     a tool that does not exist fails in the one place nobody is watching: a
     stranger's first five minutes. */
  const prompt = bridgeOnboardingPrompt({ port: 4499 });

  it('names only tools that exist', () => {
    const named = new Set([...prompt.matchAll(/\bsfx_[a-z_]+/g)].map((match) => match[0]));
    expect(named.size).toBeGreaterThan(3);
    for (const name of named) expect(TOOL_NAMES, name).toContain(name);
  });

  it('sends the agent to the contract before it writes anything', () => {
    expect(prompt).toMatch(/sfx_contract first/);
  });

  it('carries both doors, because neither alone gets everyone in', () => {
    /* MCP for the client that can be restarted, HTTP for the agent that cannot
       restart itself — the whole reason `/tools/<name>` exists. */
    expect(prompt).toContain('mcp add txt2sfx');
    expect(prompt).toContain('/tools/<name>');
    expect(prompt).toContain('x-txt2sfx-token');
  });

  it('covers the clients with no add command, whose config key is not mcpServers', () => {
    /* An agent told only the generic shape has to guess where its own client
       keeps servers, and a guess at a config path fails silently. */
    expect(prompt).toContain('opencode.json');
    expect(prompt).toContain('"type": "local"');
    expect(prompt).toContain('.cursor/mcp.json');
    expect(prompt).toContain('"mcpServers"');
  });

  it('puts --port in the argv only when it is not the default', () => {
    expect(prompt).toContain('txt2sfx-bridge --stdio --port 4499');
    expect(bridgeOnboardingPrompt()).toContain('txt2sfx-bridge --stdio\n');
    expect(bridgeOnboardingPrompt()).not.toContain('--port 4455');
  });

  it('points at the port it was built for, not the default', () => {
    expect(prompt).toContain('http://127.0.0.1:4499/tools');
    expect(prompt).not.toContain('4455');
  });

  it('promises no API key, since the absence of one is the point', () => {
    expect(prompt).toMatch(/never ask me for a key/);
  });
});
