/**
 * CHISMOSO V1.0 — FICHA Renderer (Task IMP-CLONA-1)
 *
 * Renders a FichaSpec to a ClonaKit-style FICHA.md Markdown document.
 *
 * The output mirrors the section structure of ClonaKit's plantilla
 * `FICHA.md` and the worked example `recetas/email-marketing/FICHA.md`:
 *
 *   1. En una frase
 *   2. Para quién y para qué
 *   3. Funciones de la primera versión (MVP)  — markdown table
 *   4. Pantallas                                 — one subsection per screen
 *   5. Datos
 *   6. Para más adelante (fuera de esta versión)
 *   7. Evidencia (trazabilidad CHISMOSO)
 *   8. Veracidad y limitaciones
 *
 * Section 9 (Checklist de sala limpia) is included as a verbatim
 * ClonaKit checklist so any human reader (or downstream builder agent)
 * can tick the boxes before starting to program.
 *
 * The renderer is a PURE function — given the same FichaSpec, it
 * always produces the same Markdown. It does no I/O, no logging, no
 * external calls. This makes it trivial to unit-test and to invoke
 * from the orchestrator, the API routes, the CLI and the MCP server
 * without surprises.
 */

import type { FichaSpec } from './models.js';

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * The directory where rendered FICHA files are persisted. Centralised
 * here so the orchestrator, CLI and API all agree on the same path.
 */
export const FICHAS_DIR = '/home/z/my-project/download/chismoso/fichas';

/**
 * Filename convention for a persisted FICHA: `ficha-<opportunity_id>.md`.
 * Exported so the orchestrator and the API can compute paths without
 * duplicating the format string.
 */
export function fichaFilename(opportunityId: string): string {
  return `ficha-${opportunityId}.md`;
}

/**
 * Render a FichaSpec to a Markdown document following ClonaKit's
 * plantilla `FICHA.md` structure.
 */
export function renderFichaMarkdown(ficha: FichaSpec): string {
  const L: string[] = [];

  // ----- HEADER ----------------------------------------------------------
  L.push(`# Ficha: ${ficha.title}`);
  L.push('');
  if (ficha.inspired_by) {
    L.push(`> Inspirada en: ${ficha.inspired_by} (solo como referencia de funciones; no se copia nada)`);
  }
  L.push(`> Generada por CHISMOSO · Fecha: ${ficha.generated_at}`);
  L.push(`> Veracidad: ${ficha.truth_level} (síntesis de señales observadas)`);
  L.push('');
  L.push(
    'Esta ficha es el **encargo** para construir un producto/servicio que resuelva la oportunidad detectada. ' +
    'Quien la programe solo verá este documento, así que todo lo que importe tiene que estar aquí.',
  );

  // ----- 1. EN UNA FRASE -------------------------------------------------
  L.push('');
  L.push('## 1. En una frase');
  L.push('');
  L.push(ficha.one_liner);

  // ----- 2. PARA QUIÉN Y PARA QUÉ ---------------------------------------
  L.push('');
  L.push('## 2. Para quién y para qué');
  L.push('');
  L.push(ficha.target_audience);

  // ----- 3. FUNCIONES DE LA PRIMERA VERSIÓN (MVP) -----------------------
  L.push('');
  L.push('## 3. Funciones de la primera versión (MVP)');
  L.push('');
  L.push('Entre 3 y 5. Las demás van a la sección 6.');
  L.push('');
  L.push('| # | Función | Qué hace, con tus palabras | Cómo se hará en la web |');
  L.push('| --- | --- | --- | --- |');
  ficha.mvp_functions.forEach((fn, i) => {
    L.push(
      `| ${i + 1} | ${escapeCell(fn.name)} | ${escapeCell(fn.description)} | ${escapeCell(fn.web_equivalent)} |`,
    );
  });

  // ----- 4. PANTALLAS ----------------------------------------------------
  L.push('');
  L.push('## 4. Pantallas');
  for (const screen of ficha.screens) {
    L.push('');
    L.push(`### ${screen.name}`);
    L.push('');
    L.push(`- **Qué se ve:** ${screen.what_you_see.map(bulletEscape).join('; ')}`);
    L.push(`- **Qué se puede hacer:** ${screen.what_you_can_do.map(bulletEscape).join('; ')}`);
  }

  // ----- 5. DATOS --------------------------------------------------------
  L.push('');
  L.push('## 5. Datos');
  L.push('');
  L.push(`- **Qué guarda:** ${ficha.data.what_it_stores.map(bulletEscape).join('; ')}`);
  L.push(`- **Dónde:** ${ficha.data.where}`);
  L.push(`- **Datos personales:** ${ficha.data.personal_data}`);

  // ----- 6. PARA MÁS ADELANTE -------------------------------------------
  L.push('');
  L.push('## 6. Para más adelante (fuera de esta versión)');
  L.push('');
  if (ficha.for_later.length === 0) {
    L.push('_(nada pendiente)_');
  } else {
    for (const item of ficha.for_later) {
      L.push(`- ${item}`);
    }
  }

  // ----- 7. EVIDENCIA (TRAZABILIDAD CHISMOSO) ---------------------------
  L.push('');
  L.push('## 7. Evidencia (trazabilidad CHISMOSO)');
  L.push('');
  L.push(`- **Opportunity ID:** \`${ficha.evidence.opportunity_id}\``);
  L.push(`- **Investigation ID:** \`${ficha.evidence.investigation_id}\``);
  if (ficha.evidence.trend_topic) {
    L.push(`- **Trend topic:** ${ficha.evidence.trend_topic}`);
  }
  L.push(`- **Signals count:** ${ficha.evidence.signal_count}`);
  if (ficha.evidence.top_evidence_urls.length > 0) {
    L.push('- **Top evidence:**');
    for (const url of ficha.evidence.top_evidence_urls) {
      L.push(`  - ${url}`);
    }
  } else {
    L.push('- **Top evidence:** _(sin URLs en la evidencia)_');
  }

  // ----- 8. VERACIDAD Y LIMITACIONES -----------------------------------
  L.push('');
  L.push('## 8. Veracidad y limitaciones');
  L.push('');
  L.push(`- **TruthLevel:** ${ficha.truth_level} — esta ficha es una síntesis, no una observación directa.`);
  const confidencePct = typeof ficha.confidence === 'number'
    ? `${Math.round(ficha.confidence * 100)}%`
    : '—';
  L.push(`- **Confianza:** ${confidencePct}`);
  const limitations = ficha.limitations && ficha.limitations.length > 0
    ? ficha.limitations
    : [
        'Esta ficha es una síntesis de señales observadas; no incluye observaciones directas del producto original.',
        'Las funciones se derivan de la oportunidad detectada y deben validarse con usuarios reales antes de programarlas.',
      ];
  L.push(`- **Limitaciones:**`);
  for (const lim of limitations) {
    L.push(`  - ${lim}`);
  }
  L.push('- **Próximo agente sugerido:** AGENTE-MVP (si existe) o equipo de desarrollo humano.');

  // ----- 9. CHECKLIST DE SALA LIMPIA (ClonaKit verbatim) ----------------
  L.push('');
  L.push('## 9. Checklist de sala limpia');
  L.push('');
  L.push('- [ ] Las funciones están descritas con mis palabras; no hay textos copiados del original.');
  L.push('- [ ] No hay capturas, iconos, logos, sonidos ni imágenes del original en este documento.');
  L.push('- [ ] No hay código, pseudocódigo ni nombres internos sacados del informe de investigación.');
  L.push('- [ ] El nombre y la identidad visual son míos y no se confunden con la app original.');
  L.push('- [ ] Ninguna función se salta pagos, licencias, logins o protecciones del original.');

  return L.join('\n');
}

// ---------------------------------------------------------------------------
// SMALL HELPERS
// ---------------------------------------------------------------------------

/**
 * Escape `|` characters in a markdown table cell so they don't break the
 * column layout. Newlines collapse to spaces so a multi-line description
 * stays a single table row.
 */
function escapeCell(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Bullet items joined by "; " — each item still must not contain a
 * newline (the renderer inserts newlines itself). Backticks and pipe
 * chars are left alone since this is a list context, not a table cell.
 */
function bulletEscape(s: string): string {
  return s.replace(/\r?\n/g, ' ').trim();
}
