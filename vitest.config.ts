import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Root vitest config — covers `tests/*.test.ts` in the Next.js project
 * (NOT the `chismoso/` subpackage, which has its own config at
 * `chismoso/vitest.config.ts`).
 *
 * The `@/` alias mirrors `tsconfig.json::paths` so test imports
 * resolve the same way Next.js resolves them at build time.
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
    // better-sqlite3 + Next.js server components don't tolerate worker
    // isolation well; mirror chismoso's single-thread setup.
    pool: 'threads',
    // @ts-ignore
    poolOptions: {
      threads: { singleThread: true, isolate: false },
    },
    fileParallelism: false,
    isolate: false,
  },
  // Tests are pure TypeScript — no CSS pipeline needed. Inline empty
  // PostCSS config so vite doesn't try to walk up and pick up the
  // Tailwind v4 plugin from the parent project (which would crash
  // vite 8's resolver).
  css: {
    postcss: {
      plugins: [],
    },
  },
});
