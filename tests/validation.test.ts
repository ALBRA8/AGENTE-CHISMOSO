import { describe, it, expect } from 'vitest';
import {
  validateObjective,
  validateGeography,
  validateMaxQueries,
  validateMaxRuntimeMs,
  validateTopic,
  validateTopK,
  validateQuery,
  validateMeshPayload,
} from '../src/lib/validation';

describe('validateObjective', () => {
  it('accepts a normal non-empty string', () => {
    const r = validateObjective('Find new coffee trends in Bogota');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('Find new coffee trends in Bogota');
  });

  it('trims surrounding whitespace', () => {
    const r = validateObjective('   hello world   ');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('hello world');
  });

  it('rejects non-string input', () => {
    expect(validateObjective(123).ok).toBe(false);
    expect(validateObjective(null).ok).toBe(false);
    expect(validateObjective(undefined).ok).toBe(false);
    expect(validateObjective({ a: 1 }).ok).toBe(false);
  });

  it('rejects empty/whitespace-only input', () => {
    expect(validateObjective('').ok).toBe(false);
    expect(validateObjective('   ').ok).toBe(false);
  });

  it('rejects strings longer than 1000 chars', () => {
    const r = validateObjective('a'.repeat(1001));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1000/);
  });

  it('accepts strings exactly 1000 chars', () => {
    expect(validateObjective('a'.repeat(1000)).ok).toBe(true);
  });

  it('rejects short objectives with shell metacharacters', () => {
    expect(validateObjective('ls; rm -rf /').ok).toBe(false);
    expect(validateObjective('a | b').ok).toBe(false);
    expect(validateObjective('foo && bar').ok).toBe(false);
    expect(validateObjective('echo `whoami`').ok).toBe(false);
    expect(validateObjective('$(curl evil)').ok).toBe(false);
    expect(validateObjective('cat /etc/passwd &').ok).toBe(false);
  });

  it('does NOT block short objectives without shell metacharacters (defense in depth only)', () => {
    // 'rm -rf /' has letters, spaces, dashes, slashes — none are in our blocklist.
    // The CLI spawns with array args, so this is safe even though it looks scary.
    expect(validateObjective('rm -rf /').ok).toBe(true);
  });

  it('allows long objectives that happen to contain metacharacters (defense in depth only)', () => {
    // >50 chars: regex check skipped, normal long text with parens is OK.
    const longWithParens =
      'Analyze the coffee shop market (including specialty and chains) and report trends for the next quarter.';
    expect(validateObjective(longWithParens).ok).toBe(true);
  });
});

describe('validateGeography', () => {
  it('defaults to "global" when undefined/null', () => {
    expect(validateGeography(undefined).value).toBe('global');
    expect(validateGeography(null).value).toBe('global');
  });

  it('accepts a normal string', () => {
    expect(validateGeography('Colombia').value).toBe('Colombia');
  });

  it('returns "global" for empty/whitespace input', () => {
    expect(validateGeography('').value).toBe('global');
    expect(validateGeography('   ').value).toBe('global');
  });

  it('rejects non-string input', () => {
    expect(validateGeography(123).ok).toBe(false);
    expect(validateGeography(false).ok).toBe(false);
  });

  it('rejects strings longer than 100 chars', () => {
    expect(validateGeography('a'.repeat(101)).ok).toBe(false);
  });
});

describe('validateMaxQueries', () => {
  it('defaults to 4 when undefined/null', () => {
    expect(validateMaxQueries(undefined).value).toBe(4);
    expect(validateMaxQueries(null).value).toBe(4);
  });

  it('accepts numbers within range', () => {
    expect(validateMaxQueries(1).value).toBe(1);
    expect(validateMaxQueries(5).value).toBe(5);
    expect(validateMaxQueries(10).value).toBe(10);
  });

  it('accepts numeric strings', () => {
    expect(validateMaxQueries('7').value).toBe(7);
  });

  it('rejects values below 1', () => {
    expect(validateMaxQueries(0).ok).toBe(false);
    expect(validateMaxQueries(-3).ok).toBe(false);
  });

  it('rejects values above 10', () => {
    expect(validateMaxQueries(11).ok).toBe(false);
    expect(validateMaxQueries(100).ok).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(validateMaxQueries('abc').ok).toBe(false);
    expect(validateMaxQueries(NaN).ok).toBe(false);
    expect(validateMaxQueries(Infinity).ok).toBe(false);
  });

  it('floors fractional values', () => {
    expect(validateMaxQueries(5.9).value).toBe(5);
  });
});

describe('validateMaxRuntimeMs', () => {
  it('defaults to 180000 when undefined/null', () => {
    expect(validateMaxRuntimeMs(undefined).value).toBe(180_000);
    expect(validateMaxRuntimeMs(null).value).toBe(180_000);
  });

  it('accepts values within 30s..240s', () => {
    expect(validateMaxRuntimeMs(30_000).value).toBe(30_000);
    expect(validateMaxRuntimeMs(120_000).value).toBe(120_000);
    expect(validateMaxRuntimeMs(240_000).value).toBe(240_000);
  });

  it('rejects values below 30s', () => {
    expect(validateMaxRuntimeMs(29_999).ok).toBe(false);
    expect(validateMaxRuntimeMs(0).ok).toBe(false);
  });

  it('rejects values above 240s', () => {
    expect(validateMaxRuntimeMs(240_001).ok).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(validateMaxRuntimeMs('abc').ok).toBe(false);
    expect(validateMaxRuntimeMs(NaN).ok).toBe(false);
    expect(validateMaxRuntimeMs(Infinity).ok).toBe(false);
  });
});

describe('validateTopic', () => {
  it('accepts a normal alphanumeric topic', () => {
    expect(validateTopic('coffee-shops.2024').value).toBe('coffee-shops.2024');
    expect(validateTopic('coffee shops 2024').value).toBe('coffee shops 2024');
  });

  it('rejects empty/whitespace input', () => {
    expect(validateTopic('').ok).toBe(false);
    expect(validateTopic('   ').ok).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(validateTopic(42).ok).toBe(false);
    expect(validateTopic(null).ok).toBe(false);
  });

  it('rejects strings longer than 200 chars', () => {
    expect(validateTopic('a'.repeat(201)).ok).toBe(false);
  });

  it('rejects strings with invalid characters', () => {
    expect(validateTopic('coffee!').ok).toBe(false);
    expect(validateTopic('coffee@shops').ok).toBe(false);
    expect(validateTopic('coffee/shops').ok).toBe(false);
    expect(validateTopic('café').ok).toBe(false); // non-ascii letter
  });
});

describe('validateTopK', () => {
  it('defaults to 10 when undefined/null', () => {
    expect(validateTopK(undefined).value).toBe(10);
    expect(validateTopK(null).value).toBe(10);
  });

  it('accepts values within 1..50', () => {
    expect(validateTopK(1).value).toBe(1);
    expect(validateTopK(25).value).toBe(25);
    expect(validateTopK(50).value).toBe(50);
  });

  it('rejects values below 1', () => {
    expect(validateTopK(0).ok).toBe(false);
    expect(validateTopK(-5).ok).toBe(false);
  });

  it('rejects values above 50', () => {
    expect(validateTopK(51).ok).toBe(false);
    expect(validateTopK(100).ok).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(validateTopK('abc').ok).toBe(false);
    expect(validateTopK(NaN).ok).toBe(false);
    expect(validateTopK(Infinity).ok).toBe(false);
  });

  it('accepts numeric strings', () => {
    expect(validateTopK('15').value).toBe(15);
  });

  it('floors fractional values', () => {
    expect(validateTopK(12.7).value).toBe(12);
  });
});

describe('validateQuery', () => {
  it('accepts a normal search query', () => {
    expect(validateQuery('tendencias cafe bogota').value).toBe('tendencias cafe bogota');
  });

  it('trims whitespace', () => {
    expect(validateQuery('  hello  ').value).toBe('hello');
  });

  it('rejects non-string input', () => {
    expect(validateQuery(123).ok).toBe(false);
    expect(validateQuery(null).ok).toBe(false);
    expect(validateQuery(undefined).ok).toBe(false);
  });

  it('rejects empty/whitespace input', () => {
    expect(validateQuery('').ok).toBe(false);
    expect(validateQuery('   ').ok).toBe(false);
  });

  it('rejects strings longer than 500 chars', () => {
    expect(validateQuery('a'.repeat(501)).ok).toBe(false);
  });

  it('accepts strings exactly 500 chars', () => {
    expect(validateQuery('a'.repeat(500)).ok).toBe(true);
  });
});

describe('validateMeshPayload', () => {
  it('accepts a valid mesh signal payload', () => {
    const r = validateMeshPayload({
      source_agent: 'NEX-SCOPE',
      signal_type: 'trend_spike',
      payload: { topic: 'coffee', score: 0.8 },
    });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      sourceAgent: 'NEX-SCOPE',
      signalType: 'trend_spike',
      payload: { topic: 'coffee', score: 0.8 },
    });
  });

  it('rejects non-object input', () => {
    expect(validateMeshPayload(null).ok).toBe(false);
    expect(validateMeshPayload('string').ok).toBe(false);
    expect(validateMeshPayload(42).ok).toBe(false);
    expect(validateMeshPayload(undefined).ok).toBe(false);
  });

  it('rejects missing source_agent', () => {
    expect(validateMeshPayload({ signal_type: 'x', payload: {} }).ok).toBe(false);
    expect(validateMeshPayload({ source_agent: '', signal_type: 'x', payload: {} }).ok).toBe(false);
  });

  it('rejects missing signal_type', () => {
    expect(validateMeshPayload({ source_agent: 'x', payload: {} }).ok).toBe(false);
    expect(validateMeshPayload({ source_agent: 'x', signal_type: '', payload: {} }).ok).toBe(false);
  });

  it('rejects missing payload', () => {
    expect(validateMeshPayload({ source_agent: 'x', signal_type: 'y' }).ok).toBe(false);
  });

  it('rejects source_agent longer than 100 chars', () => {
    expect(
      validateMeshPayload({
        source_agent: 'a'.repeat(101),
        signal_type: 'y',
        payload: {},
      }).ok,
    ).toBe(false);
  });

  it('rejects signal_type longer than 100 chars', () => {
    expect(
      validateMeshPayload({
        source_agent: 'x',
        signal_type: 'a'.repeat(101),
        payload: {},
      }).ok,
    ).toBe(false);
  });

  it('rejects payloads larger than 100KB when serialized', () => {
    const huge = 'x'.repeat(100_001);
    const r = validateMeshPayload({
      source_agent: 'x',
      signal_type: 'y',
      payload: { big: huge },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/100KB/);
  });

  it('accepts payload exactly at the 100KB boundary', () => {
    // Construct an object whose JSON.stringify length is exactly 100_000.
    // Object: { a: "<100000-? chars>" } — wrapper adds `{"a":"` (6) + `"}` (2) = 8 chars.
    // So the string itself should be 100_000 - 8 = 99_992 chars.
    const r = validateMeshPayload({
      source_agent: 'x',
      signal_type: 'y',
      payload: { a: 'x'.repeat(99_992) },
    });
    expect(r.ok).toBe(true);
  });

  it('accepts primitive payloads (string, number, bool)', () => {
    expect(
      validateMeshPayload({ source_agent: 'x', signal_type: 'y', payload: 'hello' }).ok,
    ).toBe(true);
    expect(
      validateMeshPayload({ source_agent: 'x', signal_type: 'y', payload: 42 }).ok,
    ).toBe(true);
    expect(
      validateMeshPayload({ source_agent: 'x', signal_type: 'y', payload: true }).ok,
    ).toBe(true);
  });

  it('accepts array payloads', () => {
    const r = validateMeshPayload({
      source_agent: 'x',
      signal_type: 'y',
      payload: [1, 2, 3],
    });
    expect(r.ok).toBe(true);
    expect(r.value?.payload).toEqual([1, 2, 3]);
  });
});
