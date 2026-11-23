import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // Vitest 5: poolOptions removed. Use pool + isolate directly.
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
