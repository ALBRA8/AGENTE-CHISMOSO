/**
 * CHISMOSO V1.4 — Skills barrel (spec §26, §27, §28)
 *
 * Single import surface for everything related to skills:
 *
 *   - models.ts        — type surface (Skill, SkillInvocation, SkillStatus, ...)
 *   - repository.ts    — persistence layer (SQLite CRUD + transition guard)
 *   - registry.ts      — SkillsCatalog (lifecycle verbs + seeding)
 *   - builtins.ts      — 8 pre-defined CHISMOSO skills
 *
 * Usage from the chismoso CLI / orchestrator:
 *   import { SkillsCatalog, SkillStatus, BUILTIN_SKILLS } from './skills/index.js';
 *
 * Usage from the Next.js API routes:
 *   import { SkillRepository } from '../../../../chismoso/dist/skills/index.js';
 */

export * from './models.js';
export * from './repository.js';
export * from './builtins.js';
export * from './registry.js';
