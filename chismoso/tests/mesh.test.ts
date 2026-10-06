/**
 * Unit tests — Agent Mesh (Task EXP-2) + URL validator (Task IMP-2)
 *
 * Uses an in-memory SQLite DB via the public AgentMesh API. The MeshDB
 * constructor accepts any path (including ':memory:'), so we pass that
 * through AgentMesh's constructor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentMesh } from '../src/mesh/index.js';
import { validateOutboundUrl } from '../src/mesh/url-validator.js';
import type { Opportunity } from '../src/models.js';

function mkOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: `opp_${Math.random().toString(36).slice(2, 8)}`,
    title: 'SaaS de reservas por WhatsApp para restaurantes',
    description: 'Automatiza confirmaciones de reserva vía WhatsApp.',
    problem: 'Confirmar reservas manualmente es tedioso y pierde ventas.',
    targetSegment: 'Restaurantes pequeños en Colombia',
    geography: 'Colombia',
    demand: 70,
    growth: 65,
    problemSeverity: 60,
    monetization: 55,
    timing: 75,
    marketFit: 50,
    competition: 40,
    uncertainty: 30,
    score: 62,
    scoreBreakdown: { demand: 70, growth: 65, problem: 60, monetization: 55, timing: 75, marketFit: 50, competition: 40, uncertainty: 30 },
    confidence: 0.6,
    suggestedNextAgent: 'AGENTE-LEADS',
    evidence: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('AgentMesh', () => {
  let mesh: AgentMesh;

  beforeEach(() => {
    mesh = new AgentMesh(':memory:');
  });

  afterEach(() => {
    mesh.close();
  });

  it('publishOpportunity() adds an event to the outbox', () => {
    const opp = mkOpportunity({ id: 'opp_1' });
    const eventId = mesh.publishOpportunity(opp);
    expect(eventId).toBeTruthy();
    const pending = mesh.pendingFor('AGENTE-LEADS');
    expect(pending.length).toBe(1);
    expect(pending[0].opportunityId).toBe('opp_1');
    expect(pending[0].agentTarget).toBe('AGENTE-LEADS');
    expect(pending[0].payload).toMatchObject({
      event: 'opportunity',
      opportunity: expect.objectContaining({ id: 'opp_1', title: expect.any(String) }),
    });
  });

  it('publishOpportunity() is idempotent for (opportunityId, agentTarget)', () => {
    const opp = mkOpportunity({ id: 'opp_2' });
    const id1 = mesh.publishOpportunity(opp);
    const id2 = mesh.publishOpportunity(opp);
    expect(id1).toBe(id2);
    expect(mesh.pendingFor('AGENTE-LEADS').length).toBe(1);
  });

  it('publishOpportunity() respects suggestedNextAgent override', () => {
    const opp = mkOpportunity({ id: 'opp_3', suggestedNextAgent: 'AGENTE-PRICING' });
    mesh.publishOpportunity(opp);
    expect(mesh.pendingFor('AGENTE-LEADS').length).toBe(0);
    expect(mesh.pendingFor('AGENTE-PRICING').length).toBe(1);
  });

  it('pendingFor() returns only undelivered events, oldest first', async () => {
    mesh.publishOpportunity(mkOpportunity({ id: 'opp_a', createdAt: '2024-01-01T00:00:00Z' }));
    await new Promise((r) => setTimeout(r, 5));
    mesh.publishOpportunity(mkOpportunity({ id: 'opp_b', createdAt: '2024-01-02T00:00:00Z' }));
    const pending = mesh.pendingFor('AGENTE-LEADS');
    expect(pending.length).toBe(2);
    expect(pending[0].opportunityId).toBe('opp_a');
    expect(pending[1].opportunityId).toBe('opp_b');
  });

  it('ack() marks events as delivered', () => {
    const opp = mkOpportunity({ id: 'opp_4' });
    const id = mesh.publishOpportunity(opp);
    expect(mesh.pendingFor('AGENTE-LEADS').length).toBe(1);
    const acked = mesh.ack([id]);
    expect(acked).toBe(1);
    expect(mesh.pendingFor('AGENTE-LEADS').length).toBe(0);
  });

  it('ingestExternalSignal() adds an external signal to the inbox', () => {
    const id = mesh.ingestExternalSignal('NEX', 'youtube_growth', {
      topic: 'restaurantes',
      growth: 0.18,
    });
    expect(id).toBeTruthy();
    const unconsumed = mesh.unconsumedExternalSignals();
    expect(unconsumed.length).toBe(1);
    expect(unconsumed[0].sourceAgent).toBe('NEX');
    expect(unconsumed[0].signalType).toBe('youtube_growth');
    expect(unconsumed[0].payload).toMatchObject({ topic: 'restaurantes', growth: 0.18 });
  });

  it('unconsumedExternalSignals() returns only consumed=null, oldest first', async () => {
    mesh.ingestExternalSignal('NEX', 't1', { i: 1 });
    await new Promise((r) => setTimeout(r, 5));
    mesh.ingestExternalSignal('NEX', 't2', { i: 2 });
    const list = mesh.unconsumedExternalSignals();
    expect(list.length).toBe(2);
    expect(list[0].payload).toMatchObject({ i: 1 });
    expect(list[1].payload).toMatchObject({ i: 2 });
  });

  it('markConsumed() marks a signal as consumed', () => {
    const id = mesh.ingestExternalSignal('NEX', 't', {});
    mesh.markConsumed(id);
    expect(mesh.unconsumedExternalSignals().length).toBe(0);
    // listExternalSignals includes consumed ones (debugging view).
    expect(mesh.listExternalSignals().length).toBe(1);
  });

  it('getConfig() / setConfig() roundtrip with subscribers', () => {
    // Default config: disabled, no subscribers.
    const initial = mesh.getConfig();
    expect(initial.enabled).toBe(false);
    expect(initial.subscribers.length).toBe(0);

    mesh.setConfig({
      enabled: true,
      subscribers: [
        { agentName: 'AGENTE-LEADS', webhookUrl: 'https://example.com/hook', secret: 's3cret' },
        { agentName: 'AGENTE-PRICING', webhookUrl: 'https://example.com/pricing' },
      ],
    });

    const after = mesh.getConfig();
    expect(after.enabled).toBe(true);
    expect(after.subscribers.length).toBe(2);
    const leads = after.subscribers.find((s) => s.agentName === 'AGENTE-LEADS');
    expect(leads?.webhookUrl).toBe('https://example.com/hook');
    expect(leads?.secret).toBe('s3cret');

    // setConfig is atomic — it replaces subscribers, doesn't append.
    mesh.setConfig({ enabled: false, subscribers: [] });
    expect(mesh.getConfig().subscribers.length).toBe(0);
    expect(mesh.getConfig().enabled).toBe(false);
  });

  it('status() returns correct counts', () => {
    mesh.publishOpportunity(mkOpportunity({ id: 'opp_s1' }));
    mesh.publishOpportunity(mkOpportunity({ id: 'opp_s2' }));
    mesh.ingestExternalSignal('NEX', 't', {});
    mesh.ingestExternalSignal('NEX', 't2', {});
    mesh.markConsumed(mesh.unconsumedExternalSignals()[0].id);

    const s = mesh.status();
    expect(s.pendingOutbox).toBe(2);
    expect(s.deliveredOutbox).toBe(0);
    expect(s.unconsumedSignals).toBe(1);
    expect(s.totalSignals).toBe(2);
  });
});

describe('validateOutboundUrl (SSRF guard)', () => {
  it('accepts valid public https URLs', () => {
    expect(validateOutboundUrl('https://example.com/webhook').ok).toBe(true);
    expect(validateOutboundUrl('https://agentes-leads.com/api/opp').ok).toBe(true);
  });

  it('rejects localhost and private IPs', () => {
    expect(validateOutboundUrl('http://localhost/admin').ok).toBe(false);
    expect(validateOutboundUrl('http://127.0.0.1/admin').ok).toBe(false);
    expect(validateOutboundUrl('http://10.0.0.1/internal').ok).toBe(false);
    expect(validateOutboundUrl('http://169.254.169.254/latest/meta-data/').ok).toBe(false);
  });

  it('rejects non-http(s) protocols', () => {
    expect(validateOutboundUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateOutboundUrl('ftp://example.com/file').ok).toBe(false);
  });

  it('rejects userinfo and blocked ports', () => {
    expect(validateOutboundUrl('https://user:pass@example.com/').ok).toBe(false);
    expect(validateOutboundUrl('http://example.com:3306/').ok).toBe(false);
  });
});
