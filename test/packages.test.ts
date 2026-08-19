/**
 * The publishable shape of the five library packages, kept honest.
 *
 * `@txt2sfx/shared`, `core`, `analyzer`, `optimizer` and `agent` ship to npm
 * in lockstep: they pin each other with `workspace:*`, which `pnpm pack`
 * rewrites to the exact version, so a set published at two different versions
 * would pair a `core` with a `shared` it was never tested against. The
 * publish workflow checks this again at release time; this test catches the
 * drift at the commit that introduces it, where it is a one-line fix instead
 * of a failed tag.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const NAMES = ['shared', 'core', 'analyzer', 'optimizer', 'agent'] as const;
const root = fileURLToPath(new URL('..', import.meta.url));

const manifests = NAMES.map((name) => {
  const dir = join(root, 'packages', name);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  return { name, dir, manifest };
});

describe('the five library packages', () => {
  it('carry one version, because they publish in lockstep', () => {
    const versions = new Set(manifests.map(({ manifest }) => manifest['version']));
    expect([...versions]).toHaveLength(1);
  });

  for (const { name, dir, manifest } of manifests) {
    describe(`@txt2sfx/${name}`, () => {
      it('is publishable: public, scoped-public on the registry, pointing at its source', () => {
        expect(manifest['private']).toBeUndefined();
        expect(manifest['publishConfig']).toEqual({ access: 'public' });
        const repository = manifest['repository'] as Record<string, string>;
        expect(repository['url']).toContain('github.com/txt2sfx/txt2sfx');
        expect(repository['directory']).toBe(`packages/${name}`);
      });

      it('ships dist and src — src because declarationMap points into it', () => {
        // A `.d.ts.map` referencing a file the tarball does not carry is a
        // promise the consumer's go-to-definition cannot honour.
        expect(manifest['files']).toEqual(['dist', 'src']);
      });

      it('rebuilds on pack, so a local `pnpm pack` never ships a stale dist', () => {
        expect((manifest['scripts'] as Record<string, string>)['prepack']).toBe('tsc -b');
      });

      it('pins its siblings with workspace:*, which pack rewrites to the exact version', () => {
        const dependencies = (manifest['dependencies'] ?? {}) as Record<string, string>;
        for (const [dep, range] of Object.entries(dependencies)) {
          expect(dep, `${name} may only depend on @txt2sfx/* at runtime`).toMatch(/^@txt2sfx\//);
          expect(range).toBe('workspace:*');
        }
      });

      it('has the LICENSE and README npm shows beside the code', () => {
        expect(existsSync(join(dir, 'LICENSE'))).toBe(true);
        expect(existsSync(join(dir, 'README.md'))).toBe(true);
      });
    });
  }
});
