/**
 * Carga tolerante del SDK z-ai-web-dev-sdk para la app Next.
 * El SDK no está en el registry público npm: la imagen OCI lo construye sin él
 * y los endpoints que lo requieren degradan con error honesto (503) en vez de
 * romper el build. Ver chismoso/src/providers/zai.ts (misma política).
 */
export type ZAIClient = {
  functions: { invoke: (name: string, args: unknown) => Promise<unknown> };
  chat: {
    completions: {
      create: (opts: unknown) => Promise<unknown>;
    };
  };
  embeddings: {
    create: (opts: unknown) => Promise<unknown>;
  };
};

let cached: Promise<ZAIClient> | null = null;

// Especificador opaco para el bundler: Turbopakc/webpack no debe intentar
// resolver el módulo en build-time (no está en el registry público npm).
const SDK_SPECIFIER: string = ['z-ai', 'web-dev', 'sdk'].join('-');

export function loadZAI(): Promise<ZAIClient> {
  if (!cached) {
    cached = import(/* turbopackIgnore: true */ SDK_SPECIFIER)
      .then((mod: { default: { create: () => Promise<ZAIClient> } }) => mod.default.create())
      .catch((e: unknown) => {
        cached = null;
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(`ZAI_SDK_UNAVAILABLE — z-ai-web-dev-sdk no está instalado en este entorno (${detail})`);
      });
  }
  return cached;
}
