/**
 * Wildcard ambient declaration for all chismoso/dist/* runtime imports.
 *
 * The chismoso agent is a separate TypeScript project compiled to dist/.
 * API routes in the Next.js dashboard import from it at runtime, but
 * at type-check time the dist/ may not exist (it's built separately).
 * This wildcard declaration silences all TS2307 errors for these paths.
 *
 * The actual types ship in chismoso/src/ — for type-safe development,
 * run `cd chismoso && npx tsc` first to generate dist/ with .d.ts files.
 */
declare module '*/chismoso/dist/*.js' {
  const _default: any;
  export = _default;
}
