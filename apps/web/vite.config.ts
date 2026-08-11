import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { chatPrompt } from './plugins/chat-prompt.js';
import { examplesFs } from './plugins/examples-fs.js';
import { gmBank } from './plugins/gm-bank.js';
import { metrika } from './plugins/metrika.js';
import { pwa } from './plugins/pwa.js';
import { stableAudio } from './plugins/stable-audio.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * Where the built playground is served from.
 *
 * The root, in every case that matters today: the site is published as the
 * organization site `https://txt2sfx.github.io/`, out of its own repository, so
 * there is no subdirectory prefix to bake into asset URLs — and the build CI
 * publishes is byte-for-byte the one a developer gets from `pnpm build:web`.
 *
 * The override survives because the failure it prevents is silent and ugly: a
 * playground served from a subdirectory without it loads a blank body, every
 * asset 404. Anyone hosting this under a path (a fork's project site, a staging
 * prefix behind a proxy) sets `PAGES_BASE_PATH` and needs no patch here.
 */
const configured = process.env['PAGES_BASE_PATH']?.trim() ?? '';
// Normalised here rather than left to Vite's own fixup so the value is
// unambiguous in the config: `configure-pages` emits `/txt2sfx` with no
// trailing slash, and `''` for a site published at the root.
const base = configured === '' ? '/' : `/${configured.replace(/^\/+|\/+$/g, '')}/`;

/**
 * Audience measurement on the published site, and nowhere else.
 *
 * Same shape as `PAGES_BASE_PATH` above and for the same reason: a property of one
 * deployment does not belong in files every fork and every `pnpm dev` inherits. Unset
 * — which is the state locally, in CI's `verify` job and in any fork — the build is
 * byte-for-byte the one that has no counter in it. `plugins/metrika.ts` explains what
 * is injected, and the one line of the stock snippet it does not use.
 *
 * Not a secret: the id is readable in the page source of any site that runs a counter.
 */
const metrikaId = process.env['YANDEX_METRIKA_ID'];

/**
 * The playground runs off TypeScript sources, not `dist/` — same choice as
 * `vitest.config.ts`, and for the same reason: editing a primitive and hearing
 * the result should not require a build step in between.
 */
export default defineConfig({
  base,
  plugins: [
    react(),
    examplesFs(r('../../examples')),
    stableAudio(r('../../test/stable-audio')),
    gmBank(),
    chatPrompt(),
    metrika(metrikaId),
    /* Takes `base` rather than reading it back off the resolved config, because the
       manifest's `id` and `scope` and the worker's precache list are all built from it and
       a site published under a path is exactly the case where a second reading could
       disagree with the first. */
    pwa(base),
  ],
  resolve: {
    alias: {
      '@txt2sfx/shared': r('../../packages/shared/src/index.ts'),
      '@txt2sfx/core': r('../../packages/core/src/index.ts'),
      '@txt2sfx/analyzer': r('../../packages/analyzer/src/index.ts'),
      '@txt2sfx/optimizer': r('../../packages/optimizer/src/index.ts'),
      '@txt2sfx/agent': r('../../packages/agent/src/index.ts'),
    },
  },
  server: {
    // `examples/` and `packages/` live above this app's root.
    fs: { allow: [repoRoot] },
  },
  build: { target: 'es2022' },
});
