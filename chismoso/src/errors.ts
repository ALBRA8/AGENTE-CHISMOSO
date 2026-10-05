/**
 * CHISMOSO V1.0 — Error Taxonomy (sección 12 de la especificación)
 *
 * Errores normalizados para todo el sistema. El comportamiento (retry, fallback,
 * abort) depende del tipo, no de un catch-all "retry everything".
 */

export enum ErrorCode {
  OK = 'OK',
  TEMPORARY_FAILURE = 'TEMPORARY_FAILURE',
  AUTH_FAILURE = 'AUTH_FAILURE',
  RATE_LIMIT = 'RATE_LIMIT',
  EMPTY_RESULT = 'EMPTY_RESULT',
  INVALID_INPUT = 'INVALID_INPUT',
  TIMEOUT = 'TIMEOUT',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  PARSE_ERROR = 'PARSE_ERROR',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  UNKNOWN = 'UNKNOWN',
}

export interface ChismosoError {
  code: ErrorCode;
  message: string;
  providerName?: string;
  retryable: boolean;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ChismosoErrorImpl extends Error implements ChismosoError {
  public code: ErrorCode;
  public providerName?: string;
  public retryable: boolean;
  public retryAfterMs?: number;
  public cause?: unknown;

  constructor(opts: ChismosoError) {
    super(opts.message);
    this.name = 'ChismosoError';
    this.code = opts.code;
    this.providerName = opts.providerName;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
    this.cause = opts.cause;
  }

  toJSON(): ChismosoError {
    return {
      code: this.code,
      message: this.message,
      providerName: this.providerName,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

/**
 * Decide el tratamiento basándose en el código de error (sección 12).
 */
export function retryStrategy(code: ErrorCode): {
  retryable: boolean;
  maxRetries: number;
  baseDelayMs: number;
  backoffMultiplier: number;
} {
  switch (code) {
    case ErrorCode.RATE_LIMIT:
      return { retryable: true, maxRetries: 2, baseDelayMs: 2000, backoffMultiplier: 2 };
    case ErrorCode.TEMPORARY_FAILURE:
      return { retryable: true, maxRetries: 2, baseDelayMs: 800, backoffMultiplier: 1.5 };
    case ErrorCode.TIMEOUT:
      return { retryable: true, maxRetries: 1, baseDelayMs: 1500, backoffMultiplier: 2 };
    case ErrorCode.EMPTY_RESULT:
      return { retryable: false, maxRetries: 0, baseDelayMs: 0, backoffMultiplier: 1 };
    case ErrorCode.AUTH_FAILURE:
      return { retryable: false, maxRetries: 0, baseDelayMs: 0, backoffMultiplier: 1 };
    case ErrorCode.QUOTA_EXCEEDED:
      return { retryable: false, maxRetries: 0, baseDelayMs: 0, backoffMultiplier: 1 };
    case ErrorCode.PROVIDER_UNAVAILABLE:
      return { retryable: false, maxRetries: 0, baseDelayMs: 0, backoffMultiplier: 1 };
    case ErrorCode.PARSE_ERROR:
      return { retryable: false, maxRetries: 0, baseDelayMs: 0, backoffMultiplier: 1 };
    case ErrorCode.INVALID_INPUT:
      return { retryable: false, maxRetries: 0, baseDelayMs: 0, backoffMultiplier: 1 };
    case ErrorCode.OK:
    case ErrorCode.UNKNOWN:
    default:
      return { retryable: false, maxRetries: 0, baseDelayMs: 0, backoffMultiplier: 1 };
  }
}

/**
 * Clasifica un error nativo de red/SDK a nuestro taxonomy.
 */
export function classifyError(err: unknown, providerName?: string): ChismosoError {
  if (err instanceof ChismosoErrorImpl) return err;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (msg.includes('rate') && msg.includes('limit')) {
    return new ChismosoErrorImpl({
      code: ErrorCode.RATE_LIMIT,
      message: err instanceof Error ? err.message : String(err),
      providerName,
      retryable: true,
      retryAfterMs: 2000,
      cause: err,
    });
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout')) {
    return new ChismosoErrorImpl({
      code: ErrorCode.TIMEOUT,
      message: err instanceof Error ? err.message : String(err),
      providerName,
      retryable: true,
      retryAfterMs: 1500,
      cause: err,
    });
  }
  if (msg.includes('auth') || msg.includes('unauthorized') || msg.includes('401') || msg.includes('403')) {
    return new ChismosoErrorImpl({
      code: ErrorCode.AUTH_FAILURE,
      message: err instanceof Error ? err.message : String(err),
      providerName,
      retryable: false,
      cause: err,
    });
  }
  if (msg.includes('quota') || msg.includes('plan limit')) {
    return new ChismosoErrorImpl({
      code: ErrorCode.QUOTA_EXCEEDED,
      message: err instanceof Error ? err.message : String(err),
      providerName,
      retryable: false,
      cause: err,
    });
  }
  if (msg.includes('empty') || msg.includes('no result') || msg.includes('not found') || msg.includes('no search results')) {
    return new ChismosoErrorImpl({
      code: ErrorCode.EMPTY_RESULT,
      message: err instanceof Error ? err.message : String(err),
      providerName,
      retryable: false,
      cause: err,
    });
  }
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('econnreset') || msg.includes('econnrefused')) {
    return new ChismosoErrorImpl({
      code: ErrorCode.TEMPORARY_FAILURE,
      message: err instanceof Error ? err.message : String(err),
      providerName,
      retryable: true,
      retryAfterMs: 800,
      cause: err,
    });
  }
  return new ChismosoErrorImpl({
    code: ErrorCode.UNKNOWN,
    message: err instanceof Error ? err.message : String(err),
    providerName,
    retryable: false,
    cause: err,
  });
}
