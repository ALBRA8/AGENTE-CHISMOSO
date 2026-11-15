/**
 * Carga tolerante del SDK z-ai-web-dev-sdk.
 *
 * El SDK solo está disponible en entornos ALBRA que lo proveen: NO está en el
 * registry público de npm, así que la imagen OCI (construida en CI) no lo
 * incluye. Su ausencia DEGRADA el provider con un error honesto — nunca un
 * crash del proceso ni una búsqueda simulada. Los providers que lo requieren
 * reportan ZAI_SDK_UNAVAILABLE y el orquestador los marca no disponibles.
 */

export type ZAIClient = {
  functions: {
    invoke: (name: string, args: unknown) => Promise<unknown>;
  };
  chat: {
    completions: {
      create: (opts: unknown) => Promise<unknown>;
    };
  };
};

let cached: Promise<ZAIClient> | null = null;

// Especificador opaco: ningun bundler resuelve esto en build-time.
const SDK_SPECIFIER: string = ['z-ai', 'web-dev', 'sdk'].join('-');

export function loadZAI(): Promise<ZAIClient> {
  if (!cached) {
    cached = import(/* turbopackIgnore: true */ SDK_SPECIFIER)
      .then((mod: { default: { create: () => Promise<ZAIClient> } }) => mod.default.create())
      .catch((e: unknown) => {
        cached = null;
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(`ZAI_SDK_UNAVAILABLE — z-ai-web-dev-sdk no está instalado en este entorno; provider no disponible (${detail})`);
      });
  }
  return cached;
}
