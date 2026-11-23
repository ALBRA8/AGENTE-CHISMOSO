import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Root vitest config — covers `tests/*.test.ts` in the Next.js project
 * (NOT the `chismoso/` subpackage, which has its own config).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Vitest 5: poolOptions was removed. Use pool + isolate directly.
    pool: 'threads',
    fileParallelism: false,
    isolate: false,
  },
  css: {
    postcss: {
      plugins: [],
    },
  },
});
