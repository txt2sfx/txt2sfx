import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { examplesFs } from './plugins/examples-fs.js';
import { stableAudio } from './plugins/stable-audio.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * Where the built playground is served from.
 *
 * GitHub Pages puts a project site under a subdirectory (`/txt2sfx/`), so every
 * emitted asset URL needs that prefix or the page loads a blank body. The prefix
 * is read from the environment rather than hard-coded, because
 * `actions/configure-pages` derives it from the repository's Pages settings: a
 * custom domain publishes at the root and this file needs no edit for it.
 * Unset — `vite dev`, `vite preview`, any local `pnpm build:web` — means root.
 */
const configured = process.env['PAGES_BASE_PATH']?.trim() ?? '';
// Normalised here rather than left to Vite's own fixup so the value is
// unambiguous in the config: `configure-pages` emits `/txt2sfx` with no
// trailing slash, and `''` for a site published at the root.
const base = configured === '' ? '/' : `/${configured.replace(/^\/+|\/+$/g, '')}/`;

/**
 * The playground runs off TypeScript sources, not `dist/` — same choice as
 * `vitest.config.ts`, and for the same reason: editing a primitive and hearing
 * the result should not require a build step in between.
 */
export default defineConfig({
  base,
  plugins: [react(), examplesFs(r('../../examples')), stableAudio(r('../../test/stable-audio'))],
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
