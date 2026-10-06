/**
 * Unit tests — ExecutionTraceRepository (spec §30, Task IMP-5)
 *
 * Covers the lifecycle: start → complete, plus findById / findByInvestigation.
 * Uses an in-memory SQLite DB so each test gets a clean slate.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ChismosoDB } from '../src/db.js';
import { ExecutionTraceRepository } from '../src/execution-trace/index.js';

let db: ChismosoDB;
let repo: ExecutionTraceRepository;

beforeEach(() => {
  db = new ChismosoDB({ path: ':memory:' });
  repo = new ExecutionTraceRepository(db);
});

describe('ExecutionTraceRepository.start', () => {
  it('creates a trace with status="running" and a unique id', () => {
    const t = repo.start('investigate', { objective: 'test' });
    expect(t.id).toMatch(/^exec_/);
    expect(t.task).toBe('investigate');
    expect(t.status).toBe('running');
    expect(t.start_time).toBeTruthy();
    expect(t.inputs).toEqual({ objective: 'test' });
    expect(t.tools_used).toEqual([]);
    expect(t.errors).toEqual([]);
    expect(t.agent_id).toBe('AGENTE-CHISMOSO');
  });

  it('persists the trace so findById can read it back', () => {
    const t = repo.start('investigate-react', { objective: 'persisted' });
    const found = repo.findById(t.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(t.id);
    expect(found!.status).toBe('running');
    expect(found!.inputs).toEqual({ objective: 'persisted' });
  });

  it('honors opts.related_investigation_id', () => {
    const t = repo.start('investigate', { x: 1 }, {
      related_investigation_id: 'inv_abc',
    });
    const found = repo.findById(t.id);
    expect(found!.related_investigation_id).toBe('inv_abc');
  });
});

describe('ExecutionTraceRepository.complete', () => {
  it('flips status from running → success and sets end_time + duration_ms', async () => {
    const t = repo.start('investigate', { obj: 1 });
    // Sleep a tiny bit so duration_ms is non-zero (best-effort — flakiness
    // here would only mean duration_ms === 0, which is also fine).
    await new Promise((r) => setTimeout(r, 5));
    repo.complete(t.id, 'success', { count: 5 }, []);
    const found = repo.findById(t.id);
    expect(found!.status).toBe('success');
    expect(found!.end_time).toBeTruthy();
    expect(found!.duration_ms).toBeGreaterThanOrEqual(0);
    expect(found!.outputs).toEqual({ count: 5 });
    expect(found!.errors).toEqual([]);
  });

  it('persists errors on failure', () => {
    const t = repo.start('investigate', { obj: 1 });
    repo.complete(t.id, 'failure', undefined, ['boom', 'kaboom']);
    const found = repo.findById(t.id);
    expect(found!.status).toBe('failure');
    expect(found!.errors).toEqual(['boom', 'kaboom']);
    expect(found!.outputs).toBeUndefined();
  });

  it('persists tools_used + evidence_ids passed via extra', () => {
    const t = repo.start('investigate', { obj: 1 });
    repo.complete(t.id, 'success', { count: 1 }, [], {
      tools_used: ['search_web', 'search_community'],
      evidence_ids: ['ev_1', 'ev_2'],
    });
    const found = repo.findById(t.id);
    expect(found!.tools_used).toEqual(['search_web', 'search_community']);
    expect(found!.evidence_ids).toEqual(['ev_1', 'ev_2']);
  });

  it('persists timeout status', () => {
    const t = repo.start('mcp_call', { tool: 'github.search' });
    repo.complete(t.id, 'timeout', undefined, ['tool_timeout: 30000ms']);
    const found = repo.findById(t.id);
    expect(found!.status).toBe('timeout');
    expect(found!.errors).toEqual(['tool_timeout: 30000ms']);
  });
});

describe('ExecutionTraceRepository.findByInvestigation', () => {
  it('returns traces linked to the investigation id', () => {
    const t1 = repo.start('investigate', { obj: 1 }, { related_investigation_id: 'inv_a' });
    const t2 = repo.start('investigate', { obj: 2 }, { related_investigation_id: 'inv_a' });
    repo.start('investigate', { obj: 3 }, { related_investigation_id: 'inv_b' });

    const found = repo.findByInvestigation('inv_a');
    expect(found.length).toBe(2);
    const ids = found.map((t) => t.id);
    expect(ids).toContain(t1.id);
    expect(ids).toContain(t2.id);
  });

  it('returns [] when the investigation has no traces', () => {
    expect(repo.findByInvestigation('inv_nonexistent')).toEqual([]);
  });
});

describe('ExecutionTraceRepository.findByTask / listRecent', () => {
  it('findByTask returns traces for that task only', () => {
    repo.start('investigate', { obj: 1 });
    repo.start('investigate', { obj: 2 });
    repo.start('mcp_call', { tool: 'foo' });
    const investigates = repo.findByTask('investigate', 10);
    expect(investigates.length).toBe(2);
    expect(investigates.every((t) => t.task === 'investigate')).toBe(true);
    const mcpCalls = repo.findByTask('mcp_call', 10);
    expect(mcpCalls.length).toBe(1);
    expect(mcpCalls[0].task).toBe('mcp_call');
  });

  it('listRecent returns traces ordered by start_time DESC', async () => {
    const a = repo.start('investigate', { obj: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    const b = repo.start('investigate', { obj: 'b' });
    const recent = repo.listRecent(10);
    expect(recent[0].id).toBe(b.id);
    expect(recent[1].id).toBe(a.id);
  });
});

describe('ExecutionTraceRepository.addTool', () => {
  it('appends each tool name to tools_used (3 tools → length === 3)', () => {
    const t = repo.start('investigate', { obj: 1 });
    repo.addTool(t.id, 'search_web');
    repo.addTool(t.id, 'search_community');
    repo.addTool(t.id, 'collect_trends');

    const found = repo.findById(t.id);
    expect(found!.tools_used).toEqual([
      'search_web',
      'search_community',
      'collect_trends',
    ]);
    expect(found!.tools_used.length).toBe(3);
  });

  it('is idempotent — calling addTool with the same name twice dedupes', () => {
    const t = repo.start('investigate', { obj: 1 });
    repo.addTool(t.id, 'search_web');
    repo.addTool(t.id, 'search_web'); // dup — should be no-op
    repo.addTool(t.id, 'search_community');

    const found = repo.findById(t.id);
    expect(found!.tools_used).toEqual(['search_web', 'search_community']);
    expect(found!.tools_used.length).toBe(2);
  });

  it('persists immediately — visible even before complete()', () => {
    const t = repo.start('investigate', { obj: 1 });
    repo.addTool(t.id, 'search_web');
    // NOT calling complete() — trace is still 'running'.
    const found = repo.findById(t.id);
    expect(found!.status).toBe('running');
    expect(found!.tools_used).toEqual(['search_web']);
  });

  it('survives a subsequent complete() call — tools_used preserved', () => {
    const t = repo.start('investigate', { obj: 1 });
    repo.addTool(t.id, 'search_web');
    repo.addTool(t.id, 'deepen_content');
    repo.complete(t.id, 'success', { count: 1 }, []);

    const found = repo.findById(t.id);
    expect(found!.status).toBe('success');
    expect(found!.tools_used).toEqual(['search_web', 'deepen_content']);
  });

  it('is a no-op on a nonexistent trace id (does not throw)', () => {
    expect(() => repo.addTool('exec_doesnotexist', 'search_web')).not.toThrow();
  });
});

describe('ExecutionTraceRepository.addError', () => {
  it('appends each error message to errors[]', () => {
    const t = repo.start('investigate', { obj: 1 });
    repo.addError(t.id, 'tool_error[web_search]: timeout');
    repo.addError(t.id, 'tool_error[reddit]: 503');

    const found = repo.findById(t.id);
    expect(found!.errors).toEqual([
      'tool_error[web_search]: timeout',
      'tool_error[reddit]: 503',
    ]);
  });

  it('accumulates errors added before complete() — not overwritten when errors omitted', () => {
    const t = repo.start('investigate', { obj: 1 });
    repo.addError(t.id, 'first_error');
    // Pass `undefined` for errors so complete() preserves DB state.
    repo.complete(t.id, 'success', { count: 1 });

    const found = repo.findById(t.id);
    expect(found!.errors).toEqual(['first_error']);
  });

  it('is a no-op on a nonexistent trace id (does not throw)', () => {
    expect(() => repo.addError('exec_doesnotexist', 'oops')).not.toThrow();
  });
});

describe('ExecutionTraceRepository.stats', () => {
  it('counts by status + computes success_rate', () => {
    const t1 = repo.start('investigate', { obj: 1 });
    const t2 = repo.start('investigate', { obj: 2 });
    const t3 = repo.start('investigate', { obj: 3 });
    const t4 = repo.start('investigate', { obj: 4 });
    repo.complete(t1.id, 'success');
    repo.complete(t2.id, 'success');
    repo.complete(t3.id, 'failure');
    // t4 stays running

    const stats = repo.stats();
    expect(stats.total).toBe(4);
    expect(stats.by_status.running).toBe(1);
    expect(stats.by_status.success).toBe(2);
    expect(stats.by_status.failure).toBe(1);
    // success_rate = 2 / (2 + 1 + 0 timeouts) = 0.667 (rounded to 3 dp)
    expect(stats.success_rate).toBeCloseTo(0.667, 2);
  });

  it('returns success_rate=0 when no completed traces', () => {
    repo.start('investigate', { obj: 1 });
    const stats = repo.stats();
    expect(stats.success_rate).toBe(0);
    expect(stats.total).toBe(1);
    expect(stats.by_status.running).toBe(1);
  });

  it('counts by_task', () => {
    repo.start('investigate', {});
    repo.start('investigate', {});
    repo.start('mcp_call', {});
    const stats = repo.stats();
    expect(stats.by_task.investigate).toBe(2);
    expect(stats.by_task.mcp_call).toBe(1);
  });
});
