/**
 * CHISMOSO V1.0 — Feedback barrel (spec §28)
 *
 * Public API for the Feedback subsystem.
 *
 * Importers:
 *   import {
 *     FeedbackRepository,
 *     FeedbackType,
 *     POSITIVE_FEEDBACK_TYPES,
 *     NEGATIVE_FEEDBACK_TYPES,
 *     type Feedback,
 *     type FeedbackTargetType,
 *     type FeedbackStats,
 *   } from '../feedback/index.js';
 */

export * from './models.js';
export * from './repository.js';
