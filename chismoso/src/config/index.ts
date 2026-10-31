/**
 * CHISMOSO V1.0 — Configuration
 */

import path from 'node:path';
import { DEFAULT_DB_PATH } from '../db.js';

export interface ChismosoConfig {
  dbPath: string;
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  defaultGeography: string;
  outputDir: string;
  /**
   * ClonaKit tech enrichment toggle (Task FRENTE-B-CHISMOSO-CLONAKIT).
   *
   * When `true` (the default), every signal normalised by
   * `normalizeRawItem()` is passed through `enrichSignalWithTech()` which
   * attaches:
   *   - `metadata.clonakit_enrichment` (persisted) — validated techStack,
   *     webEquivalents, fichaSnippet, counts.
   *   - `techStack`, `webEquivalents`, `fichaSnippet` (in-memory) — for
   *     tools / MCP / dashboard.
   *
   * Set to `false` to disable the enrichment entirely. This is useful for
   * tests that assert the raw signal shape, or for operators who want to
   * run CHISMOSO without the ClonaKit layer.
   *
   * Env var: `CHISMOSO_CLONAKIT_ENRICHMENT=false` disables it.
   */
  clonakit_enrichment: boolean;
}

function parseBoolEnv(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  const s = v.trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  return fallback;
}

export const DEFAULT_CONFIG: ChismosoConfig = {
  dbPath: process.env.CHISMOSO_DB_PATH ?? DEFAULT_DB_PATH,
  logLevel: (process.env.CHISMOSO_LOG_LEVEL as any) ?? 'INFO',
  defaultGeography: process.env.CHISMOSO_GEOGRAPHY ?? 'global',
  outputDir: process.env.CHISMOSO_OUTPUT_DIR ?? '/home/z/my-project/download/chismoso',
  clonakit_enrichment: parseBoolEnv(process.env.CHISMOSO_CLONAKIT_ENRICHMENT, true),
};

export function resolveConfig(overrides?: Partial<ChismosoConfig>): ChismosoConfig {
  return { ...DEFAULT_CONFIG, ...(overrides ?? {}) };
}

export function resolveOutputPath(cfg: ChismosoConfig, filename: string): string {
  return path.join(cfg.outputDir, filename);
}
