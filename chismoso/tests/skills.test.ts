/**
 * CHISMOSO V1.4 — Skills tests (spec §26, §27, §28)
 *
 * Covers the spec-required cases:
 *   1. Insert builtin → list shows it as ACTIVE
 *   2. Try PROPOSED→ACTIVE → should fail (must go via VALIDATING)
 *   3. Try RETIRED→* → should fail (terminal)
 *   4. Record 10 invocations, 7 success, 3 failure → success_rate = 0.7
 *   5. Feedback 'useful' → recorded, success_rate unchanged (separate metric)
 *
 * Plus a few extra sanity checks:
 *   - Seeding is idempotent (re-running seedBuiltins inserts 0 new skills)
 *   - Lifecycle verbs validate / deprecate / retire enforce the same rules
 *   - startInvocation refuses on non-ACTIVE skills
 *   - completeInvocation accepts success / failure / timeout
 *   - Search by both identity slug and UUID id resolves correctly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChismosoDB } from '../src/db.js';
import {
  SkillsCatalog,
  SkillRepository,
  SkillStatus,
  InvalidTransitionError,
  BUILTIN_SKILLS,
  type Skill,
  type SkillInput,
} from '../src/skills/index.js';

describe('SkillsCatalog', () => {
  let db: ChismosoDB;
  let catalog: SkillsCatalog;
  let repo: SkillRepository;

  beforeEach(() => {
    db = new ChismosoDB({ path: ':memory:' });
    catalog = new SkillsCatalog(db);
    repo = catalog.repo;
  });

  afterEach(() => {
    db.close();
  });

  // ---------------------------------------------------------------------------
  // TEST 1 — Insert builtin → list shows it as ACTIVE
  // ---------------------------------------------------------------------------

  describe('seed + list', () => {
    it('inserts every builtin and lists them as ACTIVE', () => {
      const inserted = catalog.seedBuiltins();
      expect(inserted).toBe(BUILTIN_SKILLS.length);

      const all = catalog.list();
      expect(all.length).toBe(BUILTIN_SKILLS.length);
      // Every seeded skill must be ACTIVE — builtins ship pre-validated.
      for (const s of all) {
        expect(s.status).toBe(SkillStatus.ACTIVE);
        expect(s.origin).toBe('builtin');
      }

      // Spot-check one identity exists and matches the spec contract.
      const signalDiscovery = catalog.findByIdentity('signal_discovery');
      expect(signalDiscovery).not.toBeNull();
      expect(signalDiscovery!.purpose).toMatch(/signal/i);
      expect(signalDiscovery!.tools_required).toContain('search_web');
      expect(signalDiscovery!.confidence).toBeGreaterThan(0);
      expect(signalDiscovery!.confidence).toBeLessThanOrEqual(1);
      expect(signalDiscovery!.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('seeding is idempotent — re-running inserts 0 new skills', () => {
      catalog.seedBuiltins();
      const second = catalog.seedBuiltins();
      expect(second).toBe(0);
      expect(catalog.list().length).toBe(BUILTIN_SKILLS.length);
    });

    it('lists all 8 builtin identities', () => {
      catalog.seedBuiltins();
      const identities = catalog.list().map((s) => s.identity).sort();
      expect(identities).toEqual(
        [
          'alert_prioritization',
          'anomaly_analysis',
          'evidence_validation',
          'opportunity_detection',
          'signal_discovery',
          'source_evaluation',
          'temporal_analysis',
          'trend_detection',
        ].sort(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // TEST 2 — PROPOSED → ACTIVE is forbidden (must go via VALIDATING)
  // ---------------------------------------------------------------------------

  describe('lifecycle: PROPOSED → ACTIVE is forbidden', () => {
    it('rejects direct PROPOSED → ACTIVE transition', () => {
      const skill = catalog.propose({
        identity: 'test_skill_never_validated',
        purpose: 'Test skill that should not skip validation',
        trigger: 'never',
        prerequisites: [],
        procedure: 'noop',
        tools_required: [],
        expected_result: 'nothing',
        verification: 'check that nothing happens',
        pitfalls: [],
        evidence: 'unit test',
        version: '1.0.0',
        confidence: 0.5,
        origin: 'learned',
        status: SkillStatus.PROPOSED,
      });

      expect(() =>
        repo.transition(skill.id, SkillStatus.ACTIVE),
      ).toThrow(InvalidTransitionError);
    });

    it('allows PROPOSED → VALIDATING → ACTIVE (two-step validation)', () => {
      const skill = catalog.propose({
        identity: 'test_skill_validated',
        purpose: 'Skill that goes through the proper validation flow',
        trigger: 'when asked nicely',
        prerequisites: [],
        procedure: 'noop',
        tools_required: [],
        expected_result: 'nothing in particular',
        verification: 'visual inspection',
        pitfalls: [],
        evidence: 'unit test',
        version: '1.0.0',
        confidence: 0.5,
        origin: 'learned',
        status: SkillStatus.PROPOSED,
      });

      // Step 1: PROPOSED → VALIDATING
      const validating = repo.transition(skill.id, SkillStatus.VALIDATING);
      expect(validating.status).toBe(SkillStatus.VALIDATING);

      // Step 2: VALIDATING → ACTIVE — this also stamps last_validated.
      const active = repo.transition(validating.id, SkillStatus.ACTIVE);
      expect(active.status).toBe(SkillStatus.ACTIVE);
      expect(active.last_validated).not.toBeNull();
      expect(active.last_validated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('catalog.validate() does the two-step in one call', () => {
      const skill = catalog.propose({
        identity: 'test_skill_one_shot_validate',
        purpose: 'Skill validated via the catalog convenience method',
        trigger: 'on demand',
        prerequisites: [],
        procedure: 'noop',
        tools_required: [],
        expected_result: 'something useful',
        verification: 'unit test',
        pitfalls: [],
        evidence: 'unit test',
        version: '1.0.0',
        confidence: 0.5,
        origin: 'learned',
        status: SkillStatus.PROPOSED,
      });

      const active = catalog.validate(skill.identity);
      expect(active.status).toBe(SkillStatus.ACTIVE);
      expect(active.last_validated).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // TEST 3 — RETIRED → * is forbidden (terminal)
  // ---------------------------------------------------------------------------

  describe('lifecycle: RETIRED is terminal', () => {
    it('rejects RETIRED → ACTIVE', () => {
      const skill = makeActiveSkill(catalog, 'test_retired_to_active');
      catalog.deprecate(skill.identity);
      catalog.retire(skill.identity);
      const retired = catalog.findByIdentity(skill.identity);
      expect(retired!.status).toBe(SkillStatus.RETIRED);

      expect(() =>
        repo.transition(retired!.id, SkillStatus.ACTIVE),
      ).toThrow(InvalidTransitionError);
    });

    it('rejects RETIRED → DEPRECATED', () => {
      const skill = makeActiveSkill(catalog, 'test_retired_to_deprecated');
      catalog.deprecate(skill.identity);
      catalog.retire(skill.identity);

      expect(() =>
        repo.transition(skill.id, SkillStatus.DEPRECATED),
      ).toThrow(InvalidTransitionError);
    });

    it('rejects RETIRED → PROPOSED', () => {
      const skill = makeActiveSkill(catalog, 'test_retired_to_proposed');
      catalog.deprecate(skill.identity);
      catalog.retire(skill.identity);

      expect(() =>
        repo.transition(skill.id, SkillStatus.PROPOSED),
      ).toThrow(InvalidTransitionError);
    });

    it('rejects RETIRED → VALIDATING', () => {
      const skill = makeActiveSkill(catalog, 'test_retired_to_validating');
      catalog.deprecate(skill.identity);
      catalog.retire(skill.identity);

      expect(() =>
        repo.transition(skill.id, SkillStatus.VALIDATING),
      ).toThrow(InvalidTransitionError);
    });
  });

  // ---------------------------------------------------------------------------
  // TEST 4 — 10 invocations, 7 success, 3 failure → success_rate = 0.7
  // ---------------------------------------------------------------------------

  describe('success_rate measurement', () => {
    it('records 7 successes + 3 failures → success_rate = 0.7', () => {
      // Seed one ACTIVE skill so we can invoke it.
      catalog.seedBuiltins();
      const skill = catalog.findByIdentity('signal_discovery')!;

      // 7 successes
      for (let i = 0; i < 7; i++) {
        const inv = catalog.startInvocation(
          skill.identity,
          { query: `success-${i}` },
          undefined,
        );
        catalog.completeInvocation(inv.id, 'success', {
          signalsStored: i + 1,
        });
      }

      // 3 failures
      for (let i = 0; i < 3; i++) {
        const inv = catalog.startInvocation(
          skill.identity,
          { query: `failure-${i}` },
          undefined,
        );
        catalog.completeInvocation(inv.id, 'failure', undefined, 'boom');
      }

      // Reload the skill from DB to see the recomputed stats.
      const after = catalog.findByIdentity(skill.identity)!;
      expect(after.invocations).toBe(10);
      expect(after.successes).toBe(7);
      expect(after.failures).toBe(3);
      // 7 / 10 = 0.7 — use toBeCloseTo to avoid float precision noise.
      expect(after.success_rate).toBeCloseTo(0.7, 5);
    });

    it('success_rate stays 0 when no invocations have been recorded', () => {
      catalog.seedBuiltins();
      const skill = catalog.findByIdentity('signal_discovery')!;
      expect(skill.invocations).toBe(0);
      expect(skill.successes).toBe(0);
      expect(skill.failures).toBe(0);
      expect(skill.success_rate).toBe(0);
    });

    it('timeouts count as failures for success_rate', () => {
      catalog.seedBuiltins();
      const skill = catalog.findByIdentity('signal_discovery')!;

      // 1 success + 1 timeout
      const ok = catalog.startInvocation(skill.identity, {});
      catalog.completeInvocation(ok.id, 'success');
      const tmo = catalog.startInvocation(skill.identity, {});
      catalog.completeInvocation(tmo.id, 'timeout', undefined, 'timed out');

      const after = catalog.findByIdentity(skill.identity)!;
      expect(after.invocations).toBe(2);
      expect(after.successes).toBe(1);
      expect(after.failures).toBe(1);
      // 1 / 2 = 0.5
      expect(after.success_rate).toBeCloseTo(0.5, 5);
    });
  });

  // ---------------------------------------------------------------------------
  // TEST 5 — Feedback 'useful' is recorded, success_rate unchanged
  // ---------------------------------------------------------------------------

  describe('feedback is separate from success_rate', () => {
    it('records "useful" without changing success_rate', () => {
      catalog.seedBuiltins();
      const skill = catalog.findByIdentity('signal_discovery')!;

      // One successful invocation.
      const inv = catalog.startInvocation(skill.identity, {
        query: 'feedback-test',
      });
      catalog.completeInvocation(inv.id, 'success', { ok: true });

      const before = catalog.findByIdentity(skill.identity)!;
      expect(before.success_rate).toBe(1); // 1 / 1
      expect(before.successes).toBe(1);

      // Now mark the invocation 'useful'. success_rate MUST NOT change.
      catalog.recordFeedback(inv.id, 'useful');

      const after = catalog.findByIdentity(skill.identity)!;
      expect(after.success_rate).toBe(before.success_rate);
      expect(after.successes).toBe(before.successes);
      expect(after.invocations).toBe(before.invocations);

      // But the invocation row DOES carry the feedback stamp.
      const invAfter = repo.findInvocation(inv.id);
      expect(invAfter).not.toBeNull();
      expect(invAfter!.feedback).toBe('useful');
    });

    it('records "useless" without changing success_rate either', () => {
      catalog.seedBuiltins();
      const skill = catalog.findByIdentity('trend_detection')!;

      const inv = catalog.startInvocation(skill.identity, {});
      catalog.completeInvocation(inv.id, 'success');

      const before = catalog.findByIdentity(skill.identity)!;
      catalog.recordFeedback(inv.id, 'useless');
      const after = catalog.findByIdentity(skill.identity)!;

      // success_rate unchanged — feedback is its own metric.
      expect(after.success_rate).toBe(before.success_rate);
      expect(after.successes).toBe(before.successes);

      const invAfter = repo.findInvocation(inv.id);
      expect(invAfter!.feedback).toBe('useless');
    });

    it('a technically-successful invocation can still be marked useless', () => {
      // This is the WHOLE POINT of separating the two metrics: a skill can
      // succeed technically (returns 200, exits cleanly) while being
      // useless to the operator (wrong scope, wrong timing).
      catalog.seedBuiltins();
      const skill = catalog.findByIdentity('anomaly_analysis')!;

      const inv = catalog.startInvocation(skill.identity, {});
      catalog.completeInvocation(inv.id, 'success');

      // success_rate = 1.0 (the skill "worked") ...
      const after = catalog.findByIdentity(skill.identity)!;
      expect(after.success_rate).toBe(1);

      // ... but the operator says it was useless.
      catalog.recordFeedback(inv.id, 'useless');
      const invRow = repo.findInvocation(inv.id);
      expect(invRow!.status).toBe('success');
      expect(invRow!.feedback).toBe('useless');
    });
  });

  // ---------------------------------------------------------------------------
  // EXTRA — invocability rules + lookup-by-identity-or-id
  // ---------------------------------------------------------------------------

  describe('startInvocation refuses non-ACTIVE skills', () => {
    it('refuses to invoke a PROPOSED skill', () => {
      const skill = catalog.propose({
        identity: 'test_invoke_proposed',
        purpose: 'Should not be invocable until validated',
        trigger: 'never',
        prerequisites: [],
        procedure: 'noop',
        tools_required: [],
        expected_result: 'nothing',
        verification: 'manual',
        pitfalls: [],
        evidence: 'unit test',
        version: '1.0.0',
        confidence: 0.5,
        origin: 'learned',
        status: SkillStatus.PROPOSED,
      });

      expect(() => catalog.startInvocation(skill.identity, {})).toThrow(
        /cannot be invoked in status PROPOSED/,
      );
    });

    it('refuses to invoke a DEPRECATED skill', () => {
      catalog.seedBuiltins();
      const skill = catalog.findByIdentity('signal_discovery')!;
      catalog.deprecate(skill.identity);

      expect(() => catalog.startInvocation(skill.identity, {})).toThrow(
        /cannot be invoked in status DEPRECATED/,
      );
    });

    it('refuses to invoke a RETIRED skill', () => {
      catalog.seedBuiltins();
      const skill = catalog.findByIdentity('signal_discovery')!;
      catalog.deprecate(skill.identity);
      catalog.retire(skill.identity);

      expect(() => catalog.startInvocation(skill.identity, {})).toThrow(
        /cannot be invoked in status RETIRED/,
      );
    });
  });

  describe('lookup accepts either identity slug or UUID id', () => {
    it('findByIdentity and findById return the same record', () => {
      catalog.seedBuiltins();
      const byIdentity = catalog.findByIdentity('signal_discovery')!;
      const byId = catalog.findById(byIdentity.id);
      expect(byId).not.toBeNull();
      expect(byId!.id).toBe(byIdentity.id);
      expect(byId!.identity).toBe(byIdentity.identity);
    });

    it('catalog verbs accept either identifier', () => {
      const byIdentity = makeActiveSkill(catalog, 'test_lookup_by_id');
      // catalog.validate() should accept the UUID id, not just the identity.
      // (Already ACTIVE — should be a no-op return.)
      const viaId = catalog.validate(byIdentity.id);
      expect(viaId.id).toBe(byIdentity.id);
    });
  });

  describe('recomputeStats stays consistent after manual row manipulation', () => {
    it('handles a skill with zero invocations gracefully', () => {
      catalog.seedBuiltins();
      const skill = catalog.findByIdentity('signal_discovery')!;
      // No invocations recorded — recompute should be a no-op (0 / 0 = 0).
      repo.recomputeStats(skill.id);
      const after = catalog.findByIdentity(skill.identity)!;
      expect(after.invocations).toBe(0);
      expect(after.success_rate).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a fresh ACTIVE skill for tests that need to invoke / deprecate /
 * retire without first waiting for the full seedBuiltins() set.
 */
function makeActiveSkill(catalog: SkillsCatalog, identity: string): Skill {
  const input: SkillInput = {
    identity,
    purpose: `Active skill for tests: ${identity}`,
    trigger: 'unit test',
    prerequisites: [],
    procedure: 'noop',
    tools_required: [],
    expected_result: 'nothing in particular',
    verification: 'visual inspection',
    pitfalls: [],
    evidence: 'unit test fixture',
    version: '1.0.0',
    confidence: 0.5,
    origin: 'learned',
    status: SkillStatus.PROPOSED,
  };
  const proposed = catalog.propose(input);
  return catalog.validate(proposed.identity);
}
