/**
 * Unit tests — FICHA module (Task IMP-CLONA-1, ClonaKit pattern).
 *
 * Verifies the contract that the FICHA builder, renderer, and the
 * evidence/traceability block implement. The LLM stage is exercised via
 * mock clients — we never touch the real ZAI SDK in unit tests.
 *
 *   1. buildFicha with no LLM → deterministic fallback produces a valid
 *      FichaSpec with 3-5 MVP functions, 1-3 screens, evidence block,
 *      truth_level === 'DERIVED'.
 *   2. buildFicha with a mock LLM that returns valid JSON → uses LLM
 *      output for soft fields but ALWAYS keeps evidence block and
 *      truth_level deterministic.
 *   3. buildFicha with a mock LLM that throws → falls back gracefully.
 *   4. buildFicha with a mock LLM that returns invalid JSON → falls
 *      back gracefully.
 *   5. renderFichaMarkdown produces all ClonaKit sections (1-9).
 *   6. Evidence block carries the full traceability chain
 *      (opportunity_id, investigation_id, signal_count, top URLs).
 *   7. TruthLevel is ALWAYS 'DERIVED' — the invariant the clean-room
 *      contract depends on.
 */

import { describe, it, expect } from 'vitest';
import { buildFicha, __test__ } from '../src/ficha/builder.js';
import { renderFichaMarkdown, FICHAS_DIR } from '../src/ficha/renderer.js';
import type { FichaSpec } from '../src/ficha/models.js';
import type { LLMClient, ChatMessage, LLMResponse } from '../src/orchestrator/llm.js';
import { SignalType, SourceType, TruthLevel } from '../src/models.js';
import type { Opportunity, Evidence, Trend, Problem, Signal } from '../src/models.js';

// ---------------------------------------------------------------------------
// MOCK DATA FACTORIES
// ---------------------------------------------------------------------------

function mkSignal(source: string, snippet: string, url?: string): Signal {
  return {
    id: `sig_${Math.random().toString(36).slice(2, 8)}`,
    topic: 'restaurant-automation',
    keyword: 'whatsapp',
    source,
    sourceType: SourceType.REDDIT_COMMUNITIES,
    timestamp: new Date().toISOString(),
    geography: 'Colombia',
    metric: 'mention_count',
    value: 1,
    normalizedValue: 1,
    direction: 'up',
    velocity: 0,
    confidence: 0.6,
    evidenceType: TruthLevel.OBSERVED,
    signalType: SignalType.COMPLAINT_SPIKE,
    metadata: {},
    rawSnippet: snippet,
    url,
  };
}

function mkEvidence(s: Signal): Evidence {
  return {
    id: `ev_${s.id}`,
    source: s.source,
    sourceType: s.sourceType,
    url: s.url,
    observedAt: s.timestamp,
    collectedAt: s.timestamp,
    geographicScope: s.geography,
    topic: s.topic,
    rawValue: s.rawSnippet,
    normalizedValue: s.rawSnippet.toLowerCase(),
    extractedFact: s.rawSnippet,
    provenance: 'reddit_communities',
    verificationStatus: 'unverified',
    confidence: s.confidence,
    evidenceType: TruthLevel.OBSERVED,
    metadata: {},
  };
}

function mkOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  const sigs = [
    mkSignal('reddit', 'I hate confirming reservations manually by WhatsApp', 'https://reddit.com/r/restaurantowners/abc'),
    mkSignal('reddit', 'How do I automate my restaurant WhatsApp bookings?', 'https://reddit.com/r/smallbusiness/def'),
    mkSignal('reddit', 'This is a broken workflow, I lost two reservations', 'https://reddit.com/r/restaurantowners/ghi'),
    mkSignal('web_search', 'Restaurant automation demand growing in Colombia', 'https://example.com/article1'),
    mkSignal('web_search', 'WhatsApp booking automation pricing plan', 'https://example.com/article2'),
  ];
  const ev = sigs.map(mkEvidence);
  return {
    id: 'opp_test123',
    title: 'Opportunity around "restaurant-automation": WhatsApp booking automation for small restaurants',
    description: 'Trend state: emerging trend with score 65/100 across 3 sources. Problem severity: 72/100, frequency: 68/100. Evidence base: 5 normalized signals.',
    problem: 'Small restaurant owners in Colombia confirm reservations manually via WhatsApp, which is tedious and prone to errors.',
    targetSegment: 'Small restaurant owners',
    geography: 'Colombia',
    evidence: ev,
    demand: 70,
    growth: 65,
    problemSeverity: 72,
    monetization: 55,
    timing: 75,
    marketFit: 68,
    competition: 40,
    uncertainty: 50,
    score: 68,
    scoreBreakdown: {
      demand: 70,
      growth: 65,
      problemSeverity: 72,
      monetization: 55,
      timing: 75,
      marketFit: 68,
      competition: 40,
      uncertainty: 50,
    },
    confidence: 0.7,
    suggestedNextAgent: 'AGENTE-LEADS',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function mkTrend(): Trend {
  return {
    id: 'trnd_test1',
    topic: 'restaurant-automation',
    description: 'Emerging trend: small restaurants adopting WhatsApp for bookings.',
    state: 'EMERGING_TREND' as any,
    direction: 'up',
    confidence: 0.65,
    sourcesCount: 3,
    signalsCount: 5,
    evidence: [],
    signals: [],
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    observationCount: 1,
    growth: 0.65,
    velocity: 0.3,
    persistence: 0.4,
    crossSourceConfirmation: 0.5,
    score: 65,
    scoreBreakdown: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function mkProblem(): Problem {
  return {
    id: 'prob_test1',
    description: 'Manual WhatsApp booking confirmation is error-prone and time-consuming.',
    topic: 'restaurant-automation',
    severity: 72,
    frequency: 68,
    confidence: 0.7,
    evidence: [],
    signals: [],
    segmentsAffected: ['Small restaurant owners'],
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    observationCount: 1,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// MOCK LLM CLIENTS
// ---------------------------------------------------------------------------

/**
 * Creates a stub LLMClient that returns the given response string. The
 * real LLMClient wraps ZAI; we don't want to touch the network in tests.
 */
function mkMockLLM(opts: {
  responseContent?: string;
  throwOnChat?: boolean;
}): LLMClient {
  const chat = async (
    _messages: ChatMessage[],
    _opts?: { thinking?: boolean },
  ): Promise<LLMResponse> => {
    if (opts.throwOnChat) {
      throw new Error('mock LLM failure');
    }
    return {
      content: opts.responseContent ?? '',
      raw: {},
      durationMs: 0,
      tokens: 0,
    };
  };
  // We return an object that satisfies the LLMClient interface — the
  // only member the builder uses is `chat`. Cast through `unknown`
  // because TypeScript's strict structural typing complains about
  // missing private fields on the real class.
  return { chat } as unknown as LLMClient;
}

/** A valid LLM JSON response: 4 functions, 2 screens, sensible data. */
const VALID_LLM_JSON = JSON.stringify({
  title: 'Reservas Fáciles',
  one_liner: 'Una web para que restaurantes pequeños reciban y confirmen reservas por WhatsApp sin herramientas de pago.',
  inspired_by: 'Inspirada en Calendly',
  target_audience: 'Dueños de restaurantes pequeños en Colombia que ya usan WhatsApp para reservas pero las pierden.',
  problem_it_solves: 'Las reservas por WhatsApp se confirman a mano, son lentas y se pierden. Esta web las organiza en una lista.',
  mvp_functions: [
    {
      name: 'Formulario de reserva',
      description: 'El cliente llena nombre, fecha, hora y número de personas; la web valida y muestra el cupo.',
      web_equivalent: 'Formulario HTML estándar + validación en cliente',
    },
    {
      name: 'Lista de reservas',
      description: 'El dueño ve todas las reservas del día, ordenadas por hora, con estado (pendiente, confirmada, cancelada).',
      web_equivalent: 'Tabla HTML + estado en memoria',
    },
    {
      name: 'Confirmación por WhatsApp',
      description: 'Botón que abre WhatsApp con un mensaje pre-escrito para confirmar la reserva al cliente.',
      web_equivalent: 'Enlace wa.me/?text=<mensaje> + clipboard',
    },
    {
      name: 'Exportar día',
      description: 'Botón que descarga las reservas del día como CSV para llevar a la cocina.',
      web_equivalent: 'Blob + descarga, CSV propio',
    },
  ],
  screens: [
    {
      name: 'Formulario público',
      what_you_see: [
        'Una cabecera con el nombre del restaurante.',
        'El formulario con campos grandes para móvil.',
        'Un pie con la política de privacidad breve.',
      ],
      what_you_can_do: [
        'Elegir fecha, hora y número de personas.',
        'Pulsar Reservar.',
        'Ver la confirmación en pantalla.',
      ],
    },
    {
      name: 'Panel del dueño',
      what_you_see: [
        'La lista de reservas del día en una tabla.',
        'El total de reservas confirmadas.',
      ],
      what_you_can_do: [
        'Confirmar o cancelar una reserva.',
        'Abrir WhatsApp con el mensaje pre-escrito.',
        'Exportar el día a CSV.',
      ],
    },
  ],
  data: {
    what_it_stores: ['reservas', 'datos de contacto del cliente', 'estado de cada reserva'],
    where: 'navegador (localStorage) — sin servidor en la primera versión',
    personal_data: 'sí: nombre y teléfono de los clientes (manejar con RGPD en cuenta)',
  },
  for_later: [
    'Integración directa con WhatsApp Business API para no depender del enlace wa.me.',
    'Sincronización entre dispositivos (requiere backend).',
    'Recordatorios automáticos el día anterior.',
  ],
});

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe('FICHA builder — deterministic fallback', () => {
  it('produces a FichaSpec with 3-5 MVP functions when no LLM is provided', async () => {
    const opp = mkOpportunity();
    const evidence = opp.evidence;
    const ficha = await buildFicha({
      opportunity: opp,
      trend: mkTrend(),
      problem: mkProblem(),
      evidence,
      investigationId: 'inv_test1',
    });
    expect(ficha.id).toBe(`ficha_${opp.id}`);
    expect(ficha.mvp_functions.length).toBeGreaterThanOrEqual(3);
    expect(ficha.mvp_functions.length).toBeLessThanOrEqual(5);
    // Each function must have all three required fields.
    for (const fn of ficha.mvp_functions) {
      expect(typeof fn.name).toBe('string');
      expect(fn.name.length).toBeGreaterThan(0);
      expect(typeof fn.description).toBe('string');
      expect(fn.description.length).toBeGreaterThan(0);
      expect(typeof fn.web_equivalent).toBe('string');
      expect(fn.web_equivalent.length).toBeGreaterThan(0);
    }
    // Screens: at least 1, at most 3.
    expect(ficha.screens.length).toBeGreaterThanOrEqual(1);
    expect(ficha.screens.length).toBeLessThanOrEqual(3);
  });

  it('always sets truth_level to DERIVED', async () => {
    const opp = mkOpportunity();
    const ficha = await buildFicha({
      opportunity: opp,
      evidence: opp.evidence,
      investigationId: 'inv_test1',
    });
    expect(ficha.truth_level).toBe('DERIVED');
  });

  it('populates the evidence block with full traceability', async () => {
    const opp = mkOpportunity();
    const evidence = opp.evidence;
    const ficha = await buildFicha({
      opportunity: opp,
      trend: mkTrend(),
      problem: mkProblem(),
      evidence,
      investigationId: 'inv_test1',
    });
    expect(ficha.evidence.opportunity_id).toBe(opp.id);
    expect(ficha.evidence.investigation_id).toBe('inv_test1');
    expect(typeof ficha.evidence.signal_count).toBe('number');
    expect(ficha.evidence.signal_count).toBeGreaterThan(0);
    // The top evidence URLs should come from the input evidence.
    const inputUrls = evidence.map((e) => e.url).filter(Boolean) as string[];
    for (const url of ficha.evidence.top_evidence_urls) {
      expect(inputUrls).toContain(url);
    }
    // trend_topic should be the trend's topic when trend is provided.
    expect(ficha.evidence.trend_topic).toBe('restaurant-automation');
  });

  it('caps top_evidence_urls at 5 entries', async () => {
    const opp = mkOpportunity();
    // Build 10 evidence items with URLs.
    const ev: Evidence[] = [];
    for (let i = 0; i < 10; i++) {
      const sig = mkSignal('reddit', `snippet ${i}`, `https://example.com/page${i}`);
      ev.push(mkEvidence(sig));
    }
    const ficha = await buildFicha({
      opportunity: { ...opp, evidence: ev },
      evidence: ev,
      investigationId: 'inv_test1',
    });
    expect(ficha.evidence.top_evidence_urls.length).toBeLessThanOrEqual(5);
  });
});

describe('FICHA builder — LLM stage', () => {
  it('uses LLM output for soft fields when the LLM returns valid JSON', async () => {
    const opp = mkOpportunity();
    const llm = mkMockLLM({ responseContent: VALID_LLM_JSON });
    const ficha = await buildFicha({
      opportunity: opp,
      trend: mkTrend(),
      problem: mkProblem(),
      evidence: opp.evidence,
      investigationId: 'inv_test1',
    }, llm);
    // Title / one_liner / inspired_by come from the LLM.
    expect(ficha.title).toBe('Reservas Fáciles');
    expect(ficha.one_liner).toContain('Una web para que restaurantes pequeños');
    expect(ficha.inspired_by).toBe('Inspirada en Calendly');
    expect(ficha.target_audience).toContain('Dueños de restaurantes pequeños');
    // 4 functions, 2 screens — straight from the LLM JSON.
    expect(ficha.mvp_functions.length).toBe(4);
    expect(ficha.screens.length).toBe(2);
    expect(ficha.data.where).toContain('navegador');
    expect(ficha.for_later.length).toBe(3);
  });

  it('keeps evidence block + truth_level deterministic even when LLM succeeds', async () => {
    const opp = mkOpportunity();
    const llm = mkMockLLM({ responseContent: VALID_LLM_JSON });
    const ficha = await buildFicha({
      opportunity: opp,
      trend: mkTrend(),
      problem: mkProblem(),
      evidence: opp.evidence,
      investigationId: 'inv_xyz',
    }, llm);
    // The LLM is NOT trusted with the evidence block or the truth_level —
    // these come from the deterministic synthesiser regardless.
    expect(ficha.truth_level).toBe('DERIVED');
    expect(ficha.evidence.opportunity_id).toBe(opp.id);
    expect(ficha.evidence.investigation_id).toBe('inv_xyz');
    expect(ficha.evidence.trend_topic).toBe('restaurant-automation');
    expect(ficha.confidence).toBe(opp.confidence);
  });

  it('falls back to deterministic synthesis when the LLM throws', async () => {
    const opp = mkOpportunity();
    const llm = mkMockLLM({ throwOnChat: true });
    const ficha = await buildFicha({
      opportunity: opp,
      trend: mkTrend(),
      problem: mkProblem(),
      evidence: opp.evidence,
      investigationId: 'inv_test1',
    }, llm);
    // Fallback still satisfies the structural contract.
    expect(ficha.truth_level).toBe('DERIVED');
    expect(ficha.mvp_functions.length).toBeGreaterThanOrEqual(3);
    expect(ficha.mvp_functions.length).toBeLessThanOrEqual(5);
    expect(ficha.screens.length).toBeGreaterThanOrEqual(1);
    expect(ficha.evidence.opportunity_id).toBe(opp.id);
  });

  it('falls back to deterministic synthesis when the LLM returns invalid JSON', async () => {
    const opp = mkOpportunity();
    const llm = mkMockLLM({ responseContent: 'sorry, I cannot help with that' });
    const ficha = await buildFicha({
      opportunity: opp,
      trend: mkTrend(),
      problem: mkProblem(),
      evidence: opp.evidence,
      investigationId: 'inv_test1',
    }, llm);
    expect(ficha.truth_level).toBe('DERIVED');
    expect(ficha.mvp_functions.length).toBeGreaterThanOrEqual(3);
    // The fallback title is the opportunity title.
    expect(ficha.title).toBe(opp.title);
  });

  it('falls back when the LLM returns JSON with fewer than 3 functions', async () => {
    const opp = mkOpportunity();
    const bad = JSON.stringify({
      title: 'Too few',
      mvp_functions: [{ name: 'only one', description: 'desc', web_equivalent: 'web' }],
      screens: [{ name: 'one', what_you_see: ['x'], what_you_can_do: ['y'] }],
      data: { what_it_stores: ['x'], where: 'browser', personal_data: 'none' },
      for_later: ['x'],
    });
    const llm = mkMockLLM({ responseContent: bad });
    const ficha = await buildFicha({
      opportunity: opp,
      evidence: opp.evidence,
      investigationId: 'inv_test1',
    }, llm);
    // Validation rejects the 1-function output and falls back.
    expect(ficha.mvp_functions.length).toBeGreaterThanOrEqual(3);
    expect(ficha.mvp_functions.length).toBeLessThanOrEqual(5);
  });
});

describe('FICHA renderer', () => {
  it('renders all ClonaKit sections (1-9) with the expected content', async () => {
    const opp = mkOpportunity();
    const ficha = await buildFicha({
      opportunity: opp,
      trend: mkTrend(),
      problem: mkProblem(),
      evidence: opp.evidence,
      investigationId: 'inv_test1',
    });
    const md = renderFichaMarkdown(ficha);
    // Header
    expect(md).toContain(`# Ficha: ${ficha.title}`);
    expect(md).toContain('> Generada por CHISMOSO');
    expect(md).toContain('Veracidad: DERIVED');
    // Sections 1-9
    expect(md).toContain('## 1. En una frase');
    expect(md).toContain('## 2. Para quién y para qué');
    expect(md).toContain('## 3. Funciones de la primera versión (MVP)');
    expect(md).toContain('## 4. Pantallas');
    expect(md).toContain('## 5. Datos');
    expect(md).toContain('## 6. Para más adelante (fuera de esta versión)');
    expect(md).toContain('## 7. Evidencia (trazabilidad CHISMOSO)');
    expect(md).toContain('## 8. Veracidad y limitaciones');
    expect(md).toContain('## 9. Checklist de sala limpia');
    // MVP table header
    expect(md).toContain('| # | Función | Qué hace, con tus palabras | Cómo se hará en la web |');
    // Evidence traceability block carries opportunity_id + investigation_id
    expect(md).toContain(`**Opportunity ID:** \`${opp.id}\``);
    expect(md).toContain(`**Investigation ID:** \`inv_test1\``);
    expect(md).toContain('**Signals count:**');
    // Limitations section
    expect(md).toContain('**TruthLevel:** DERIVED');
    expect(md).toContain('**Confianza:**');
    expect(md).toContain('AGENTE-MVP');
    // Checklist de sala limpia (ClonaKit verbatim)
    expect(md).toContain('- [ ] Las funciones están descritas con mis palabras');
    expect(md).toContain('- [ ] Ninguna función se salta pagos, licencias, logins o protecciones del original.');
  });

  it('includes the inspired_by line in the header when set', async () => {
    const opp = mkOpportunity();
    const llm = mkMockLLM({ responseContent: VALID_LLM_JSON });
    const ficha = await buildFicha({
      opportunity: opp,
      trend: mkTrend(),
      problem: mkProblem(),
      evidence: opp.evidence,
      investigationId: 'inv_test1',
    }, llm);
    const md = renderFichaMarkdown(ficha);
    expect(md).toContain('> Inspirada en: Inspirada en Calendly (solo como referencia de funciones; no se copia nada)');
  });

  it('omits the inspired_by line when not set', async () => {
    const opp = mkOpportunity();
    const ficha = await buildFicha({
      opportunity: opp,
      evidence: opp.evidence,
      investigationId: 'inv_test1',
    });
    // Fallback does not set inspired_by.
    expect(ficha.inspired_by).toBeUndefined();
    const md = renderFichaMarkdown(ficha);
    expect(md).not.toContain('> Inspirada en:');
  });

  it('renders all top evidence URLs as bullets', async () => {
    const opp = mkOpportunity();
    const ficha = await buildFicha({
      opportunity: opp,
      trend: mkTrend(),
      problem: mkProblem(),
      evidence: opp.evidence,
      investigationId: 'inv_test1',
    });
    const md = renderFichaMarkdown(ficha);
    for (const url of ficha.evidence.top_evidence_urls) {
      expect(md).toContain(`  - ${url}`);
    }
  });

  it('handles the "no URLs" case gracefully', async () => {
    // Build evidence with no URLs.
    const opp = mkOpportunity();
    const noUrlEvidence = opp.evidence.map((e) => ({ ...e, url: undefined }));
    const ficha = await buildFicha({
      opportunity: { ...opp, evidence: noUrlEvidence },
      evidence: noUrlEvidence,
      investigationId: 'inv_test1',
    });
    expect(ficha.evidence.top_evidence_urls).toEqual([]);
    const md = renderFichaMarkdown(ficha);
    expect(md).toContain('_(sin URLs en la evidencia)_');
  });
});

describe('FICHA renderer — FICHAS_DIR + filename convention', () => {
  it('exposes the canonical fichas directory', () => {
    expect(FICHAS_DIR).toBe('/home/z/my-project/download/chismoso/fichas');
  });
});

describe('FICHA builder — internal helpers', () => {
  it('extractJson pulls the first balanced JSON object out of a markdown-fenced response', () => {
    const fenced = '```json\n{"a":1}\n```';
    const extracted = __test__.extractJson(fenced);
    expect(extracted).toBe('{"a":1}');
  });

  it('parseAndValidate rejects an empty object', () => {
    expect(__test__.parseAndValidate('{}')).toBeNull();
  });

  it('parseAndValidate rejects a function array shorter than 3', () => {
    const bad = JSON.stringify({
      mvp_functions: [{ name: 'a', description: 'b', web_equivalent: 'c' }],
      screens: [{ name: 's', what_you_see: ['x'], what_you_can_do: ['y'] }],
      data: { what_it_stores: ['x'], where: 'browser', personal_data: 'none' },
      for_later: [],
    });
    expect(__test__.parseAndValidate(bad)).toBeNull();
  });

  it('parseAndValidate rejects a 6-function array (>5)', () => {
    const fns = Array.from({ length: 6 }, (_, i) => ({
      name: `f${i}`,
      description: `d${i}`,
      web_equivalent: `w${i}`,
    }));
    const bad = JSON.stringify({
      mvp_functions: fns,
      screens: [{ name: 's', what_you_see: ['x'], what_you_can_do: ['y'] }],
      data: { what_it_stores: ['x'], where: 'browser', personal_data: 'none' },
      for_later: [],
    });
    expect(__test__.parseAndValidate(bad)).toBeNull();
  });

  it('parseAndValidate accepts a well-formed 3-5 function response', () => {
    expect(__test__.parseAndValidate(VALID_LLM_JSON)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ROUNDTRIP — render a FichaSpec, then re-extract evidence metadata
// from the markdown. This proves the round-trip contract between the
// renderer (FichaSpec → markdown) and the parsers in the API + MCP tool
// (markdown → parsed view).
// ---------------------------------------------------------------------------

describe('FICHA roundtrip (renderer → markdown parser)', () => {
  it('renders markdown whose evidence block roundtrips back to the same values', async () => {
    const opp = mkOpportunity();
    const ficha = await buildFicha({
      opportunity: opp,
      trend: mkTrend(),
      problem: mkProblem(),
      evidence: opp.evidence,
      investigationId: 'inv_roundtrip1',
    });
    const md = renderFichaMarkdown(ficha);

    // Re-parse with the same regexes the API + MCP tool use.
    // The renderer formats as `- **Opportunity ID:** \`value\`` and
    // `- **Signals count:** 5` so the regex uses `.*?` between the
    // label and the value to tolerate the bold markers (matching the
    // tolerant parsers in the API + MCP tool).
    const oppIdMatch = md.match(/Opportunity ID:.*?`([^`]+)`/);
    const invIdMatch = md.match(/Investigation ID:.*?`([^`]+)`/);
    const sigCountMatch = md.match(/Signals count:.*?(\d+)/);
    const truthMatch = md.match(/Veracidad:\s*(\w+)/);

    expect(oppIdMatch?.[1]).toBe(ficha.evidence.opportunity_id);
    expect(invIdMatch?.[1]).toBe(ficha.evidence.investigation_id);
    expect(parseInt(sigCountMatch?.[1] ?? '0', 10)).toBe(ficha.evidence.signal_count);
    expect(truthMatch?.[1]).toBe('DERIVED');
  });
});
