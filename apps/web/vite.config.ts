import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { examplesFs } from './plugins/examples-fs.js';
import { stableAudio } from './plugins/stable-audio.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * The playground runs off TypeScript sources, not `dist/` — same choice as
 * `vitest.config.ts`, and for the same reason: editing a primitive and hearing
 * the result should not require a build step in between.
 */
export default defineConfig({
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
