/**
 * CHISMOSO V1.0 — FICHA barrel (Task IMP-CLONA-1)
 *
 * Re-exports the public surface of the FICHA module so callers can
 * `import { buildFicha, renderFichaMarkdown, FICHAS_DIR } from '../ficha/index.js'`
 * without pulling individual files.
 */

export type {
  FichaSpec,
  FichaFunction,
  FichaScreen,
  FichaEvidence,
} from './models.js';

export {
  buildFicha,
  type BuildFichaInput,
} from './builder.js';

export {
  renderFichaMarkdown,
  FICHAS_DIR,
  fichaFilename,
} from './renderer.js';
