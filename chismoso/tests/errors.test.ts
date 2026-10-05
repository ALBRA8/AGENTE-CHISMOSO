/**
 * Unit tests — Error Taxonomy (sección 12)
 */

import { describe, it, expect } from 'vitest';
import {
  ErrorCode,
  ChismosoErrorImpl,
  classifyError,
  retryStrategy,
} from '../src/errors.js';

describe('error taxonomy', () => {
  it('retryStrategy: RATE_LIMIT is retryable with backoff', () => {
    const s = retryStrategy(ErrorCode.RATE_LIMIT);
    expect(s.retryable).toBe(true);
    expect(s.maxRetries).toBeGreaterThan(0);
    expect(s.baseDelayMs).toBeGreaterThan(500);
  });

  it('retryStrategy: AUTH_FAILURE is NOT retryable', () => {
    expect(retryStrategy(ErrorCode.AUTH_FAILURE).retryable).toBe(false);
  });

  it('retryStrategy: EMPTY_RESULT is NOT retryable', () => {
    expect(retryStrategy(ErrorCode.EMPTY_RESULT).retryable).toBe(false);
  });

  it('retryStrategy: TIMEOUT is retryable once', () => {
    const s = retryStrategy(ErrorCode.TIMEOUT);
    expect(s.retryable).toBe(true);
    expect(s.maxRetries).toBe(1);
  });

  it('classifyError: maps rate limit message to RATE_LIMIT', () => {
    const err = new Error('rate limit exceeded');
    const c = classifyError(err, 'web_search');
    expect(c.code).toBe(ErrorCode.RATE_LIMIT);
    expect(c.retryable).toBe(true);
    expect(c.providerName).toBe('web_search');
  });

  it('classifyError: maps timeout message to TIMEOUT', () => {
    const err = new Error('request timeout');
    const c = classifyError(err);
    expect(c.code).toBe(ErrorCode.TIMEOUT);
  });

  it('classifyError: maps auth message to AUTH_FAILURE', () => {
    const err = new Error('Unauthorized 401');
    const c = classifyError(err);
    expect(c.code).toBe(ErrorCode.AUTH_FAILURE);
  });

  it('classifyError: maps unknown error to UNKNOWN', () => {
    const err = new Error('something weird happened');
    const c = classifyError(err);
    expect(c.code).toBe(ErrorCode.UNKNOWN);
    expect(c.retryable).toBe(false);
  });

  it('ChismosoErrorImpl preserves code and providerName in toJSON', () => {
    const e = new ChismosoErrorImpl({
      code: ErrorCode.RATE_LIMIT,
      message: 'rate limited',
      providerName: 'web_search',
      retryable: true,
    });
    const j = e.toJSON();
    expect(j.code).toBe(ErrorCode.RATE_LIMIT);
    expect(j.providerName).toBe('web_search');
  });
});
