/**
 * CHISMOSO V1.0 — Alerts barrel (Task IMP-4, spec §20)
 *
 * Single import surface for everything alert-related. Callers should do:
 *
 *   import {
 *     AlertManager,
 *     AlertRepository,
 *     AlertStatus,
 *     AlertSeverity,
 *     AlertPriority,
 *     type Alert,
 *   } from '../alerts/index.js';
 */

export * from './models.js';
export * from './repository.js';
export * from './manager.js';
