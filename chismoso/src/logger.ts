/**
 * CHISMOSO V1.0 — Logger / observability (sección 32)
 *
 * Logger estructurado mínimo, no depende de librerías externas.
 * Sanitiza credenciales antes de imprimir.
 */

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

const SENSITIVE_KEYS = [
  'apikey',
  'api_key',
  'token',
  'password',
  'secret',
  'authorization',
  'auth',
];

function sanitize(obj: unknown): unknown {
  if (obj == null) return obj;
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

export interface LogContext {
  investigationId?: string;
  providerName?: string;
  [k: string]: unknown;
}

function log(level: LogLevel, msg: string, ctx?: LogContext): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(ctx ? sanitize(ctx) as Record<string, unknown> : {}),
  };
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
