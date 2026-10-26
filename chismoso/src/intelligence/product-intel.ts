/**
 * CHISMOSO V1.4 — Product Intelligence (Task IMP-CLONA-2)
 *
 * Wrapper around REA (Reverse-engineer Anything) — the ClonaKit tool that
 * investigates how an app is built WITHOUT accessing its source code.
 *
 * REA is consumed as an MCP server (see data/mcp-servers.json + the
 * `rea` entry). This module:
 *   1. Looks up the `rea` MCP server in the registry (must be connected).
 *   2. Finds REA's investigation/analyze tool by name pattern.
 *   3. Calls it via `mcpRegistry.callTool('rea.<toolName>', { target, depth })`.
 *   4. Parses REA's free-text report to extract detected frameworks.
 *   5. Converts each framework into a CHISMOSO Signal + Evidence pair.
 *
 * Boundary (see docs/CLONAKIT-INTEGRATION.md):
 *   - CHISMOSO detects the product mention in trends → calls REA.
 *   - REA returns ONLY metadata (frameworks, permissions, web equivalents).
 *   - CHISMOSO persists that metadata as `TruthLevel.OBSERVED` signals
 *     (REA observes the binary, not source code — so OBSERVED, not DERIVED).
 *   - No source code, no assets, no DRM bypass — REA's design enforces this.
 *
 * Failure modes (all non-fatal — return `available: false` + reason):
 *   - REA server not connected → operators see a clear install hint.
 *   - REA server connected but no investigate tool surfaced → tell the
 *     operator which tools ARE exposed so they can pick one.
 *   - REA call rejects (timeout, server died) → log + return reason.
 */

import { mcpRegistry } from '../mcp/registry.js';
import {
  generateId,
  nowISO,
  SignalType,
  SourceType,
  TruthLevel,
  type Signal,
  type Evidence,
} from '../models.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

export type InvestigationDepth = 'quick' | 'standard' | 'deep';

export interface ProductIntelResult {
  /** Product name / path / URL that was investigated. */
  product: string;
  /** True iff REA produced a report we could parse. */
  available: boolean;
  /** Populated when `available === false` — operator-actionable reason. */
  reason?: string;
  /** CHISMOSO signals to ingest (one per detected framework). */
  signals: Signal[];
  /** CHISMOSO evidence to ingest (one per detected framework). */
  evidence: Evidence[];
  /** First 5000 chars of REA's raw report — for debugging / inline display. */
  raw_summary?: string;
  /** Tool name on the REA server that was actually invoked. */
  rea_tool?: string;
}

// ---------------------------------------------------------------------------
// CAPABILITIES TABLE — ported from ClonaKit's capacidades.mjs
// ---------------------------------------------------------------------------
//
// Each entry: framework name → [purpose (Spanish, matches what REA returns),
// web-equivalent]. The web equivalent is what the Opportunity engine will
// surface to the operator as "the MVP could use X" — see
// docs/CLONAKIT-INTEGRATION.md for the legal boundary.
//
// Only the 12 most common Apple frameworks are ported here. ClonaKit's full
// table covers 50+; operators who want more can extend this map at deploy
// time (it's a plain JS object — no rebuild needed).
// ---------------------------------------------------------------------------

const CAPABILITIES: Record<string, [string, string]> = {
  AVFoundation: ['Grabar y reproducir audio y vídeo, usar la cámara', 'getUserMedia() y las etiquetas <video>/<audio>'],
  ScreenCaptureKit: ['Capturar la pantalla', 'getDisplayMedia()'],
  Metal: ['Gráficos y cálculo en la tarjeta gráfica (GPU)', 'WebGL o WebGPU'],
  SwiftUI: ['Interfaz moderna de Apple', 'HTML + CSS (o React, Vue…)'],
  CoreData: ['Base de datos local', 'IndexedDB o localStorage'],
  CloudKit: ['Sincronizar datos en iCloud', 'Un backend (Supabase, Firebase…)'],
  StoreKit: ['Compras dentro de la app', 'Stripe u otra pasarela de pago web'],
  WebKit: ['Mostrar páginas web dentro de la app', 'Un <iframe> o la propia web'],
  CoreLocation: ['Ubicación', 'navigator.geolocation'],
  CoreML: ['Inteligencia artificial en el propio ordenador', 'TensorFlow.js, ONNX Runtime Web o una API de IA'],
  Vision: ['Reconocer texto, caras u objetos en imágenes', 'Tesseract.js o una API de IA'],
  NaturalLanguage: ['Analizar texto', 'Una API de IA'],
};

interface DetectedFramework {
  name: string;
  purpose: string;
  web_equivalent: string;
}

// ---------------------------------------------------------------------------
// MAIN ENTRY — investigateProduct
// ---------------------------------------------------------------------------

/**
 * Calls REA via MCP to investigate a product, then converts REA's output
 * into CHISMOSO signals + evidence (truth level: OBSERVED — REA observes
 * the binary, doesn't read source code).
 *
 * Never throws — returns `available: false` + reason on every failure mode
 * so callers (the orchestrator tool wrapper, the MCP resource handler) can
 * surface a clean error to the operator without crashing the surrounding
 * loop.
 */
export async function investigateProduct(
  product: string,
  depth: InvestigationDepth = 'standard',
): Promise<ProductIntelResult> {
  const reaServer = mcpRegistry.getServer('rea');
  if (!reaServer) {
    return {
      product,
      available: false,
      reason:
        'REA MCP server not connected. Run `chismoso mcp connect rea` after ' +
        '`npm install rea-agents`. See docs/CLONAKIT-INTEGRATION.md.',
      signals: [],
      evidence: [],
    };
  }

  // Find the right REA tool to call. REA's MCP server exposes a tool whose
  // name contains "investigate" or "analyze" (ClonaKit's REA_BIN uses
  // `rea investigate ...` and `rea analyze ...` as the CLI surface, so the
  // MCP wrapper follows the same vocabulary). We match loosely so a future
  // rename of the tool doesn't break this code.
  const reaTool = reaServer.tools.find(
    (t) => t.name.includes('investigate') || t.name.includes('analyze'),
  );
  if (!reaTool) {
    return {
      product,
      available: false,
      reason:
        `REA server connected but no investigate/analyze tool found. ` +
        `Available tools: ${reaServer.tools.map((t) => t.name).join(', ') || '(none)'}`,
      signals: [],
      evidence: [],
    };
  }

  try {
    // REA's investigate tool accepts { target, depth } per ClonaKit's
    // `herramientas/investigar.mjs` (the CLI passes `<ruta de la app o URL>`
    // as the positional arg + `--depth`).
    const result = await mcpRegistry.callTool(`rea.${reaTool.name}`, {
      target: product,
      depth,
    });

    // MCP `callTool` returns `{ content: [{ type: 'text', text: '...' }, ...] }`.
    // REA's report is text-only — extract the joined text blob.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentArr = Array.isArray(result?.content) ? result.content : [];
    const text = contentArr
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
      .filter((t: string) => t.length > 0)
      .join('\n');

    if (!text) {
      return {
        product,
        available: false,
        reason: 'REA returned an empty report (no text content blocks).',
        signals: [],
        evidence: [],
        rea_tool: reaTool.name,
      };
    }

    // Parse REA's output → frameworks. Each framework → one signal + evidence.
    const detectedFrameworks = extractFrameworks(text);
    const signals: Signal[] = [];
    const evidence: Evidence[] = [];
    const now = nowISO();

    for (const fw of detectedFrameworks) {
      const sigId = generateId('sig');
      const evId = generateId('ev');
      const snippet = `${fw.name}: ${fw.purpose}. Web equivalent: ${fw.web_equivalent}`;

      signals.push({
        id: sigId,
        topic: product,
        keyword: fw.name,
        source: 'rea',
        sourceType: SourceType.WEB_CONTENT, // REA inspects binary content + loaded web scripts
        timestamp: now,
        observedAt: now,
        geography: 'global',
        metric: 'framework_detected',
        value: fw.name,
        normalizedValue: 1,
        unit: 'framework',
        entity: product,
        direction: 'up',
        velocity: 0,
        confidence: 0.8,
        evidenceType: TruthLevel.OBSERVED,
        signalType: SignalType.NEW_PRODUCT,
        metadata: {
          framework: fw.name,
          purpose: fw.purpose,
          web_equivalent: fw.web_equivalent,
          rea_tool: reaTool.name,
          depth,
        },
        rawSnippet: snippet,
        url: undefined,
        evidenceIds: [evId],
      });

      evidence.push({
        id: evId,
        source: 'rea',
        sourceType: SourceType.WEB_CONTENT,
        observedAt: now,
        collectedAt: now,
        geographicScope: 'global',
        topic: product,
        rawValue: `${fw.name}: ${fw.purpose}`,
        normalizedValue: snippet,
        extractedFact: `Product "${product}" uses framework "${fw.name}".`,
        provenance: 'rea.mcp',
        verificationStatus: 'unverified',
        confidence: 0.8,
        evidenceType: TruthLevel.OBSERVED,
        metadata: {
          rea_tool: reaTool.name,
          product,
          depth,
          framework: fw.name,
          web_equivalent: fw.web_equivalent,
        },
      });
    }

    logger.info('Product intel investigation complete', {
      product,
      rea_tool: reaTool.name,
      depth,
      frameworks_detected: detectedFrameworks.length,
      signals: signals.length,
      evidence: evidence.length,
    });

    return {
      product,
      available: true,
      signals,
      evidence,
      raw_summary: text.slice(0, 5000),
      rea_tool: reaTool.name,
    };
  } catch (e: any) {
    logger.warn('REA investigation failed', {
      product,
      rea_tool: reaTool.name,
      err: e?.message ?? String(e),
    });
    return {
      product,
      available: false,
      reason: e?.message ?? 'REA call failed',
      signals: [],
      evidence: [],
      rea_tool: reaTool.name,
    };
  }
}

// ---------------------------------------------------------------------------
// PARSER — extractFrameworks
// ---------------------------------------------------------------------------

/**
 * Parse REA's text output to extract frameworks.
 *
 * REA's report is free-form markdown; we look for framework mentions using
 * a few heuristics. The primary pattern is `FrameworkName: description`
 * (which matches both ClonaKit's `investigar.mjs` report format and the
 * raw output of `otool -L` / REA's web-tech scanner).
 *
 * Each match is cross-referenced against the CAPABILITIES table to enrich
 * the entry with the web equivalent. Frameworks NOT in the table are kept
 * (with a generic web equivalent) — operators can extend the table later.
 *
 * Cap: 20 frameworks per product — keeps signal volume bounded so a single
 * product investigation doesn't drown out real trend signals.
 */
function extractFrameworks(text: string): DetectedFramework[] {
  const frameworks: DetectedFramework[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');

  for (const line of lines) {
    // Match patterns like "FrameworkName: description" or "- FrameworkName: description"
    // or "> FrameworkName: description". Framework names start uppercase and are 3-40 chars.
    const m = line.match(/^[>\s\-•*]*([A-Z][A-Za-z0-9_]+):\s*(.+)$/);
    if (!m) continue;
    const [, name, purposeRaw] = m;
    if (name.length < 3 || name.length > 40) continue;
    // Skip noise — common macOS plumbing frameworks that ClonaKit's
    // investigar.mjs explicitly filters out (NOISE_FRAMEWORKS).
    if (NOISE_FRAMEWORKS.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    const purpose = purposeRaw.slice(0, 200).trim();
    if (!purpose) continue;

    frameworks.push({
      name,
      purpose,
      web_equivalent: lookupWebEquivalent(name),
    });
  }

  return frameworks.slice(0, 20); // cap
}

/**
 * Returns the web-equivalent technology for a given framework name. Falls
 * back to a generic "(no web equivalent documented)" string so the LLM can
 * still reason about the framework even when we don't have a clean mapping.
 */
function lookupWebEquivalent(framework: string): string {
  const entry = CAPABILITIES[framework];
  return entry ? entry[1] : '(sin equivalente web documentado)';
}

// Frameworks that almost every macOS app links against. Listed for
// completeness but not surfaced as signals (they're noise — see ClonaKit's
// investigar.mjs NOISE_FRAMEWORKS set).
const NOISE_FRAMEWORKS = new Set([
  'Foundation',
  'CoreFoundation',
  'CoreServices',
  'Cocoa',
  'IOSurface',
  'ColorSync',
  'The',
  'This',
  'Note',
  'Notes',
  'Warning',
  'Important',
]);
