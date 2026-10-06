/**
 * CHISMOSO V1.0 — MemoryDV barrel (spec §12-§14)
 *
 * Single import surface for the memory subsystem:
 *
 *   import {
 *     MemoryRecord, MemoryType, MemoryStatus,
 *     MemoryRepository, MemoryConsolidator,
 *     computeRelevance, shouldDecay, boostUtility,
 *   } from '../memory/index.js';
 */

export * from './models.js';
export * from './decay.js';
export { MemoryRepository, type MemoryInsertInput } from './repository.js';
export { MemoryConsolidator, type ConsolidationResult } from './consolidation.js';
