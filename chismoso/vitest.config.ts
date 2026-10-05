import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // better-sqlite3 native modules + worker isolation cause segfaults on cleanup.
    // Use single-process mode (no workers) to keep all DB instances in the same
    // process and let the GC handle Statement destruction gracefully.
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true, isolate: false },
    },
    // Even with singleThread, vitest may still spawn workers per file. Force
    // no file parallelism so all tests run in the main thread.
    fileParallelism: false,
    isolate: false,
  },
});
