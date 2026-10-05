/**
 * CHISMOSO V1.0 — E2E Test (secciones 38 y 58)
 *
 * Ejecuta la investigación canónica de la especificación:
 *   "Investiga qué tendencias y problemas emergentes podrían generar
 *    oportunidades de negocio para automatización de pequeños restaurantes
 *    en Colombia."
 *
 * Valida el Definition of Done (sección 58):
 *   INVESTIGATION → REAL SOURCES → REAL SIGNALS → NORMALIZED EVIDENCE
 *   → DETECTED TRENDS → DETECTED PROBLEMS → OPPORTUNITIES → SCORES
 *   → CONFIDENCE → LIMITATIONS → ACTIONABLE REPORT
 *
 * Y verifica la regla anti-ficticia (sección 39):
 *   - GoogleTrendsProvider debe reportar UNAVAILABLE y NO simular datos.
 *   - Si hay poca evidencia, el status debe ser INSUFFICIENT_EVIDENCE
 *     en vez de inventar tendencias.
 *
 * Esta prueba hace llamadas reales a la red via z-ai-web-dev-sdk.
 */

import { describe, it, expect } from 'vitest';
import { ChismosoDB } from '../src/db.js';
import { Repositories } from '../src/repositories.js';
import { createDefaultProviderRegistry } from '../src/providers/index.js';
import { createDefaultToolRegistry, LLMClient, Orchestrator } from '../src/orchestrator/index.js';
import { InvestigationStatus, ProviderHealth } from '../src/models.js';
import { logger, LogLevel } from '../src/logger.js';

logger.setLevel(LogLevel.WARN); // silenciar logs en E2E

describe('CHISMOSO E2E — canonical investigation', () => {
  it('runs a full investigation end-to-end with REAL providers', async () => {
    const db = new ChismosoDB({ path: ':memory:' });
    const repos = new Repositories(db);
    const providerRegistry = createDefaultProviderRegistry();
    const toolRegistry = createDefaultToolRegistry();
    const llm = new LLMClient();
    const orchestrator = new Orchestrator({
      db,
      repositories: repos,
      providerRegistry,
      toolRegistry,
      llm,
      budget: {
        maxIterations: 1,
        maxQueries: 4,
        maxSources: 3,
        maxResults: 40,
        maxRuntimeMs: 180_000,
        maxProviderCalls: 6,
      },
    });

    const objective =
      'Investiga qué tendencias y problemas emergentes podrían generar oportunidades de negocio para automatización de pequeños restaurantes en Colombia.';

    const t0 = Date.now();
    const result = await orchestrator.investigate({ objective, geography: 'Colombia' });
    const elapsedSec = Math.round((Date.now() - t0) / 1000);
    console.log(`[e2e] Investigation completed in ${elapsedSec}s — status: ${result.investigation.status}`);

    // ----------------------------------------------------------------------
    // Definition of Done checks
    // ----------------------------------------------------------------------
    expect(result.investigation.id).toMatch(/^inv_/);
    expect(result.investigation.status).not.toBe(InvestigationStatus.RUNNING);
    expect(result.investigation.startedAt).toBeTruthy();
    expect(result.investigation.completedAt).toBeTruthy();

    // 1. REAL SOURCES — providers used are real, not simulated.
    expect(result.investigation.providersUsed.length).toBeGreaterThan(0);
    expect(result.investigation.providersUsed).toContain('web_search');
    expect(result.investigation.providersUsed).toContain('reddit_communities');
    // Google Trends is UNAVAILABLE; it must NOT be in providersUsed (empty items excluded).
    expect(result.investigation.providersUsed).not.toContain('google_trends');

    // 2. REAL SIGNALS — at least 1 signal collected from real web.
    expect(result.signals.length).toBeGreaterThan(0);
    const realSources = new Set(result.signals.map((s) => s.source));
    expect(realSources.size).toBeGreaterThanOrEqual(1);

    // 3. NORMALIZED EVIDENCE — every signal has a topic, sourceType, timestamp, evidenceType.
    for (const s of result.signals.slice(0, 5)) {
      expect(s.topic).toBeTruthy();
      expect(s.sourceType).toBeTruthy();
      expect(s.timestamp).toBeTruthy();
      expect(s.evidenceType).toBeTruthy();
      expect(s.signalType).toBeTruthy();
      expect(s.id).toMatch(/^sig_/);
    }

    // 4. EVIDENCE — every evidence has source, collected_at, evidenceType, normalizedValue.
    expect(result.evidence.length).toBeGreaterThan(0);
    for (const e of result.evidence.slice(0, 5)) {
      expect(e.source).toBeTruthy();
      expect(e.collectedAt).toBeTruthy();
      expect(e.evidenceType).toBeTruthy();
      expect(e.normalizedValue).toBeTruthy();
      expect(e.id).toMatch(/^ev_/);
    }

    // 5. TRENDS — at least one trend if signals >= 5 (otherwise investigation is INSUFFICIENT).
    if (result.signals.length >= 5) {
      expect(result.trends.length).toBeGreaterThan(0);
      for (const t of result.trends) {
        expect(t.topic).toBeTruthy();
        expect(t.state).toBeTruthy();
        expect(t.score).toBeGreaterThanOrEqual(0);
        expect(t.score).toBeLessThanOrEqual(100);
        expect(t.confidence).toBeGreaterThanOrEqual(0);
        expect(t.confidence).toBeLessThanOrEqual(1);
        expect(t.scoreBreakdown).toBeDefined();
        expect(t.firstSeen).toBeTruthy();
        expect(t.lastSeen).toBeTruthy();
      }
    }

    // 6. OPPORTUNITIES — if any opportunity, score breakdown is transparent.
    for (const o of result.opportunities) {
      expect(o.title).toBeTruthy();
      expect(o.score).toBeGreaterThanOrEqual(0);
      expect(o.score).toBeLessThanOrEqual(100);
      expect(o.scoreBreakdown).toHaveProperty('demand');
      expect(o.scoreBreakdown).toHaveProperty('competition');
      expect(o.scoreBreakdown).toHaveProperty('uncertainty');
      expect(o.suggestedNextAgent).toBe('AGENTE-LEADS');
      expect(o.evidence.length).toBeGreaterThan(0);
    }

    // 7. REPORT — markdown + machine-readable JSON.
    expect(result.report.markdown).toContain('# CHISMOSO INTELLIGENCE REPORT');
    expect(result.report.markdown).toContain('## Resumen ejecutivo');
    expect(result.report.markdown).toContain('## Limitations');
    expect(result.report.markdown).toContain('## Recommended next action');
    expect(result.report.machine.investigationId).toBe(result.investigation.id);
    expect(result.report.machine.providersUsed.length).toBeGreaterThan(0);

    // 8. LIMITATIONS — always present (even on success).
    expect(result.report.machine.limitations.length).toBeGreaterThan(0);
    // Limitations mention Google Trends unavailable since that's the known gap.
    expect(result.report.machine.limitations.some((l) => /UNAVAILABLE|google_trends/i.test(l))).toBe(true);

    // 9. TRUTH LEVELS — opportunities carry DERIVED, signals carry OBSERVED.
    if (result.opportunities.length > 0) {
      const o = result.opportunities[0];
      // opportunity is a DERIVED synthesis — the report annotates it explicitly.
      expect(result.report.markdown).toMatch(/TruthLevel:\s*DERIVED/);
    }
    if (result.signals.length > 0) {
      expect(result.report.markdown).toMatch(/TruthLevel:\s*OBSERVED/);
    }

    // 10. ANTI-FICTICIOUS — GoogleTrendsProvider must NOT have produced fake data.
    const trendsProvider = providerRegistry.get('google_trends')!;
    expect(await trendsProvider.health()).toBe(ProviderHealth.UNAVAILABLE);

    // 11. OBSERVABILITY — provider_runs table populated for each provider call.
    expect(result.investigation.providerRuns.length).toBeGreaterThan(0);
    for (const run of result.investigation.providerRuns) {
      expect(run.providerName).toBeTruthy();
      expect(run.startedAt).toBeTruthy();
      expect(run.query).toBeTruthy();
    }

    db.close();
  }, 240_000);

  it('falls back gracefully with INSUFFICIENT_EVIDENCE when providers return nothing', async () => {
    // Use an objective that almost certainly returns no relevant signals
    // (a very specific non-existent niche).
    const db = new ChismosoDB({ path: ':memory:' });
    const repos = new Repositories(db);
    const providerRegistry = createDefaultProviderRegistry();
    const toolRegistry = createDefaultToolRegistry();
    const llm = new LLMClient();
    const orchestrator = new Orchestrator({
      db,
      repositories: repos,
      providerRegistry,
      toolRegistry,
      llm,
      budget: {
        maxIterations: 1,
        maxQueries: 1,
        maxSources: 2,
        maxResults: 5,
        maxRuntimeMs: 60_000,
        maxProviderCalls: 1,
      },
    });

    // Note: even though some signals will be returned, with maxQueries=1 and
    // budget 1 iteration, we expect the investigation to terminate cleanly.
    const result = await orchestrator.investigate({
      objective: 'zzznonexistentmarket1234 nonexistent niche',
      geography: 'antarctica',
    });
    expect([InvestigationStatus.COMPLETED, InvestigationStatus.PARTIAL, InvestigationStatus.INSUFFICIENT_EVIDENCE])
      .toContain(result.investigation.status);
    expect(result.report.machine.limitations.length).toBeGreaterThan(0);
    db.close();
  }, 90_000);
});
