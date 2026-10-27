import { describe, expect, it } from 'vitest';
import { buildVideoProductionPayload } from '../src/mesh/index.js';
import type { Opportunity } from '../src/models.js';

describe('Mesh Video Production Bridge', () => {
  it('converts an opportunity to a YouTube Automation video payload', () => {
    const mockOpp: Opportunity = {
      id: 'opp_test_123',
      title: 'Automatización de Edición de Video con IA',
      description: 'Creadores y agencias pagan más de $3000 al mes en editores y buscan soluciones todo-en-uno sin suscripciones.',
      problem: 'Altos costos mensuales de software y lentitud en entrega de videos cortos',
      targetSegment: 'Creadores de Contenido y Agencias',
      geography: 'Global / Hispanoamérica',
      evidence: [],
      demand: 85,
      growth: 90,
      problemSeverity: 80,
      monetization: 88,
      timing: 92,
      marketFit: 85,
      competition: 40,
      uncertainty: 20,
      score: 82,
      scoreBreakdown: {},
      confidence: 0.9,
      suggestedNextAgent: 'AGENTE-LEADS',
      createdAt: new Date().toISOString(),
    };

    const videoPayload = buildVideoProductionPayload(mockOpp);

    expect(videoPayload.title).toContain('Automatización de Edición');
    expect(videoPayload.hook).toContain('El 90%');
    expect(videoPayload.hook).toContain('Creadores de Contenido');
    expect(videoPayload.idea_summary).toBe(mockOpp.description);
    expect(videoPayload.target_rpm).toBeGreaterThanOrEqual(15.0);
    expect(videoPayload.recommended_mode).toBe('idea');
    expect(videoPayload.target_format).toBe('short');
    expect(videoPayload.source_agent).toBe('AGENTE-CHISMOSO');
  });
});
