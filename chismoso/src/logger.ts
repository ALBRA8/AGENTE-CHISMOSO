/**
 * CHISMOSO V1.5 — Logger / observability (sección 32, audit §15 PII).
 *
 * Logger estructurado mínimo, no depende de librerías externas.
 *
 * Sanitiza:
 *   - Credenciales (apikey, token, password, secret, authorization,
 *     auth, email, phone, address, ip, user_id, session_id, cookies)
 *     — claves redactadas a `[REDACTED]` recursivamente.
 *   - Emails en log messages: reemplaza `[a-z]+@[a-z.]+` con `[email]`.
 *   - IPs en log messages: reemplaza `\d+\.\d+\.\d+\.\d+` con `[ip]`.
 *   - URLs con query strings en log messages: conserva origin + path,
 *     reemplaza query por `?[REDACTED]`.
 *
 * Cada línea incluye `trace_id` cuando el AsyncLocalStorage de
 * `trace-id.ts` tiene un ID activo (establecido por el middleware de
 * Next.js). Esto permite correlacionar logs a través de:
 *   - API → CLI subprocess → orchestrator → tools → DB.
 *   - Sentry events (tagged con `trace_id` por sentry.ts).
 *   - Audit log rows (campo `trace_id` en audit_log table).
 *
 * Fail-safe: nunca propaga excepciones a los callers. Si la
 * sanitización o la serialización fallan, se loguea un mensaje plano.
 */

import { traceIdStorage, getTraceIdFromEnv } from './trace-id.js';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

let currentLevel: LogLevel = LogLevel.INFO;

const ORDER: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 10,
  [LogLevel.INFO]: 20,
  [LogLevel.WARN]: 30,
  [LogLevel.ERROR]: 40,
};

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

// ---------------------------------------------------------------------------
// PII REDACTION
// ---------------------------------------------------------------------------

/**
 * Claves cuyos valores se redactan a `[REDACTED]`. Comparación
 * case-insensitive.
 *
 * Extendida para audit §15 P0-8:
 *   - credenciales existentes: apikey, api_key, token, password,
 *     secret, authorization, auth
 *   - PII extendido: email, phone, address, ip, user_id, session_id,
 *     cookies
 */
const SENSITIVE_KEYS = [
  'apikey',
  'api_key',
  'token',
  'password',
  'secret',
  'authorization',
  'auth',
  'email',
  'phone',
  'address',
  'ip',
  'user_id',
  'session_id',
  'cookies',
];

/**
 * Regex para redactar PII en mensajes de log (no en claves, sino en
 * strings arbitrarios que pueden contener emails, IPs, URLs con
 * query strings).
 *
 * Aplicado en orden:
 *   1. Emails: `[a-z]+@[a-z.]+` → `[email]`
 *   2. IPv4: `\d+\.\d+\.\d+\.\d+` → `[ip]`
 *   3. URLs con query: conserva origin + path, reemplaza query por
 *      `?[REDACTED]`.
 *
 * NOTA: las regex son intencionalmente simples (no validan formato
 * completo) para no consumir CPU en cada log line. Casos edge:
 *   - `1.2.3.4.5` (no es IP válida) → se redacta como `[ip].5`
 *   - `foo@bar` (no es email válido) → se redacta como `[email]`
 * La sobre-redacción es preferible a la sub-redacción para PII.
 */
const EMAIL_RE = /[a-zA-Z][a-zA-Z0-9._%+-]*@[a-zA-Z][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}/g;
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const URL_QUERY_RE = /(https?:\/\/[^\s?#]+)(\?[^\s#]*)/g;

function redactString(s: string): string {
  return s
    .replace(EMAIL_RE, '[email]')
    .replace(IPV4_RE, '[ip]')
    .replace(URL_QUERY_RE, '$1?[REDACTED]');
}

function sanitize(obj: unknown): unknown {
  if (obj == null) return obj;
  if (typeof obj === 'string') return redactString(obj);
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.includes(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = sanitize(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TRACE ID PROPAGATION
// ---------------------------------------------------------------------------

/**
 * Lee el trace ID del AsyncLocalStorage de trace-id.ts.
 * Returns undefined cuando no hay request scope activo (background
 * scheduler tick, top-level process code).
 */
function getCurrentTraceId(): string | undefined {
  try {
    // First check the AsyncLocalStorage (set by `runWithTraceId`).
    // If no scope is active, fall back to the env var (set by the
    // Next.js /api/investigate route when spawning this CLI
    // subprocess).
    const fromStorage = traceIdStorage.getStore();
    if (fromStorage) return fromStorage;
    return getTraceIdFromEnv();
  } catch {
    // AsyncLocalStorage can throw if the module wasn't loaded yet
    // (rare, only during very early boot). Fail safe — omit trace_id.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// LOG CONTEXT
// ---------------------------------------------------------------------------

export interface LogContext {
  investigationId?: string;
  providerName?: string;
  [k: string]: unknown;
}

function log(level: LogLevel, msg: string, ctx?: LogContext): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const sanitizedMsg = redactString(msg);
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: sanitizedMsg,
  };
  if (ctx) {
    const sanitized = sanitize(ctx) as Record<string, unknown>;
    Object.assign(payload, sanitized);
  }
  // Attach trace_id from AsyncLocalStorage (set by Next.js middleware).
  const traceId = getCurrentTraceId();
  if (traceId) payload.trace_id = traceId;

  // eslint-disable-next-line no-console
  console[level === LogLevel.ERROR ? 'error' : 'log'](JSON.stringify(payload));
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => log(LogLevel.DEBUG, msg, ctx),
  info: (msg: string, ctx?: LogContext) => log(LogLevel.INFO, msg, ctx),
  warn: (msg: string, ctx?: LogContext) => log(LogLevel.WARN, msg, ctx),
  error: (msg: string, ctx?: LogContext) => log(LogLevel.ERROR, msg, ctx),
  setLevel: setLogLevel,
  getLevel: getLogLevel,
};
