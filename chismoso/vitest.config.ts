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
  // CHISMOSO tests are pure TypeScript — no CSS needed. Vite's default
  // behavior walks up from the test file looking for a postcss.config.*,
  // which finds the parent Next.js project's config (with the Tailwind v4
  // plugin that this older vite doesn't recognize as a string). Provide an
  // empty inline PostCSS config so vite doesn't try to resolve it.
  css: {
    postcss: {
      plugins: [],
    },
  },
});

