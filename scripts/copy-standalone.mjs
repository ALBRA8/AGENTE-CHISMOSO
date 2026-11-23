#!/usr/bin/env node
/**
 * Cross-platform copy of static assets into the Next.js standalone output.
 * Replaces the Unix-only `cp -r` in the build script.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const standaloneDir = '.next/standalone';
const staticSrc = '.next/static';
const publicSrc = 'public';

if (!existsSync(standaloneDir)) {
  console.error('[copy-standalone] .next/standalone not found. Run `next build` first.');
  process.exit(1);
}

// Copy .next/static → .next/standalone/.next/static
const staticDest = join(standaloneDir, '.next', 'static');
mkdirSync(join(standaloneDir, '.next'), { recursive: true });
if (existsSync(staticSrc)) {
  cpSync(staticSrc, staticDest, { recursive: true });
  console.log('[copy-standalone] Copied .next/static → standalone');
}

// Copy public/ → .next/standalone/public/
if (existsSync(publicSrc)) {
  cpSync(publicSrc, join(standaloneDir, 'public'), { recursive: true });
  console.log('[copy-standalone] Copied public/ → standalone');
}

// Copy chismoso/dist → .next/standalone/chismoso/dist (needed by API routes)
const chismosoDist = 'chismoso/dist';
if (existsSync(chismosoDist)) {
  mkdirSync(join(standaloneDir, 'chismoso'), { recursive: true });
  cpSync(chismosoDist, join(standaloneDir, 'chismoso', 'dist'), { recursive: true });
  console.log('[copy-standalone] Copied chismoso/dist → standalone');
}

console.log('[copy-standalone] Done.');
