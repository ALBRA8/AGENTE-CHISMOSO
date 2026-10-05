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
}

export const DEFAULT_CONFIG: ChismosoConfig = {
  dbPath: process.env.CHISMOSO_DB_PATH ?? DEFAULT_DB_PATH,
  logLevel: (process.env.CHISMOSO_LOG_LEVEL as any) ?? 'INFO',
  defaultGeography: process.env.CHISMOSO_GEOGRAPHY ?? 'global',
  outputDir: process.env.CHISMOSO_OUTPUT_DIR ?? '/home/z/my-project/download/chismoso',
};

export function resolveConfig(overrides?: Partial<ChismosoConfig>): ChismosoConfig {
  return { ...DEFAULT_CONFIG, ...(overrides ?? {}) };
}

export function resolveOutputPath(cfg: ChismosoConfig, filename: string): string {
  return path.join(cfg.outputDir, filename);
}
