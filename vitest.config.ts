import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * Tests run straight off TypeScript sources — no build step, no stale `dist/`.
 * Workspace packages are aliased to their entry sources so a change in
 * `shared` is visible to `core` tests immediately.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@txt2sfx/shared': r('./packages/shared/src/index.ts'),
      '@txt2sfx/core': r('./packages/core/src/index.ts'),
      '@txt2sfx/analyzer': r('./packages/analyzer/src/index.ts'),
      '@txt2sfx/optimizer': r('./packages/optimizer/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
