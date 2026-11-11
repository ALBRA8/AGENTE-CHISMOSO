/**
 * Ambient type declaration for `pdf-parse` — the package ships without
 * its own .d.ts and `@types/pdf-parse` has dependency conflicts with the
 * parent project's package.json (uuid override).
 *
 * The real surface is small: `pdfParse(buffer)` returns a Promise that
 * resolves to an object with `text`, `numpages`, `info`, `metadata`,
 * `version`. We model the three fields we actually use and let the rest
 * flow through as `any`.
 */
declare module 'pdf-parse' {
  interface PdfData {
    text: string;
    numpages: number;
    info?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    version?: string;
  }
  function pdfParse(data: Buffer | string): Promise<PdfData>;
  export default pdfParse;
}
