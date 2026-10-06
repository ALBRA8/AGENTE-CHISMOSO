/**
 * Input validators for CHISMOSO API routes.
 *
 * Each validator returns a `ValidationResult<T>` — either `{ ok: true, value }`
 * or `{ ok: false, error }`. Routes call these at the top of their handler and
 * short-circuit with HTTP 400 on failure.
 *
 * Design rules:
 *  - Always coerce to a canonical form (trimmed string, integer number).
 *  - Always provide a sensible default for optional fields.
 *  - Defense in depth: even though `spawn(... args[])` is safe from shell
 *    injection, we still block short objectives containing shell
 *    metacharacters — catches blatant probes early.
 */

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/**
 * `objective` is the free-text investigation goal passed to the CHISMOSO CLI
 * as the first positional argument. The CLI itself spawns with array args
 * (no shell), so shell metacharacters are not strictly dangerous — but we
 * still block short strings that look like shell-injection attempts as
 * defense in depth.
 */
export function validateObjective(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string') return { ok: false, error: 'objective must be a string' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: 'objective is required' };
  if (trimmed.length > 1000) return { ok: false, error: 'objective must be at most 1000 chars' };
  // Block obvious shell metacharacters (defense in depth — spawn with array args is already safe)
  if (/[;|&`$()]/.test(trimmed) && trimmed.length < 50) {
    return { ok: false, error: 'objective contains suspicious characters' };
  }
  return { ok: true, value: trimmed };
}

export function validateGeography(input: unknown): ValidationResult<string> {
  if (input === undefined || input === null) return { ok: true, value: 'global' };
  if (typeof input !== 'string') return { ok: false, error: 'geography must be a string' };
  const trimmed = input.trim();
  if (trimmed.length > 100) return { ok: false, error: 'geography too long' };
  return { ok: true, value: trimmed || 'global' };
}

export function validateMaxQueries(input: unknown): ValidationResult<number> {
  if (input === undefined || input === null) return { ok: true, value: 4 };
  const n = typeof input === 'number' ? input : parseInt(String(input), 10);
  if (!Number.isFinite(n)) return { ok: false, error: 'maxQueries must be a number' };
  if (n < 1) return { ok: false, error: 'maxQueries must be >= 1' };
  if (n > 10) return { ok: false, error: 'maxQueries must be <= 10' };
  return { ok: true, value: Math.floor(n) };
}

export function validateMaxRuntimeMs(input: unknown): ValidationResult<number> {
  if (input === undefined || input === null) return { ok: true, value: 180_000 };
  const n = typeof input === 'number' ? input : parseInt(String(input), 10);
  if (!Number.isFinite(n)) return { ok: false, error: 'maxRuntimeMs must be a number' };
  if (n < 30_000) return { ok: false, error: 'maxRuntimeMs must be >= 30s' };
  if (n > 240_000) return { ok: false, error: 'maxRuntimeMs must be <= 240s' };
  return { ok: true, value: Math.floor(n) };
}

export function validateTopic(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string') return { ok: false, error: 'topic must be a string' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: 'topic is required' };
  if (trimmed.length > 200) return { ok: false, error: 'topic too long' };
  if (!/^[\w\s\-\.]+$/.test(trimmed)) return { ok: false, error: 'topic contains invalid characters' };
  return { ok: true, value: trimmed };
}

export function validateTopK(input: unknown): ValidationResult<number> {
  if (input === undefined || input === null) return { ok: true, value: 10 };
  const n = typeof input === 'number' ? input : parseInt(String(input), 10);
  if (!Number.isFinite(n)) return { ok: false, error: 'topK must be a number' };
  if (n < 1) return { ok: false, error: 'topK must be >= 1' };
  if (n > 50) return { ok: false, error: 'topK must be <= 50' };
  return { ok: true, value: Math.floor(n) };
}

/**
 * `query` for /api/semantic-search — free-text natural-language search
 * (ES or EN). Max 500 chars (anything longer is almost certainly abuse or
 * a copy-paste accident).
 */
export function validateQuery(input: unknown): ValidationResult<string> {
  if (typeof input !== 'string') return { ok: false, error: 'query must be a string' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: 'query is required' };
  if (trimmed.length > 500) return { ok: false, error: 'query must be at most 500 chars' };
  return { ok: true, value: trimmed };
}

export function validateMeshPayload(
  input: unknown,
): ValidationResult<{ sourceAgent: string; signalType: string; payload: any }> {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'body must be an object' };
  const obj = input as any;
  if (typeof obj.source_agent !== 'string' || obj.source_agent.length === 0)
    return { ok: false, error: 'source_agent is required' };
  if (typeof obj.signal_type !== 'string' || obj.signal_type.length === 0)
    return { ok: false, error: 'signal_type is required' };
  if (obj.payload === undefined) return { ok: false, error: 'payload is required' };
  const payloadStr = JSON.stringify(obj.payload);
  if (payloadStr.length > 100_000) return { ok: false, error: 'payload too large (max 100KB)' };
  if (obj.source_agent.length > 100) return { ok: false, error: 'source_agent too long' };
  if (obj.signal_type.length > 100) return { ok: false, error: 'signal_type too long' };
  return {
    ok: true,
    value: { sourceAgent: obj.source_agent, signalType: obj.signal_type, payload: obj.payload },
  };
}
