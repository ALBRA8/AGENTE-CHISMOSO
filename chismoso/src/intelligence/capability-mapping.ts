/**
 * Capability mapping table — ported from ClonaKit's `herramientas/capacidades.mjs`.
 * Maps native frameworks (Mac, Electron, etc.) to web equivalents.
 *
 * Used by:
 * - normalizer.ts: detect tech mentions in signal snippets, tag in metadata
 * - opportunities.ts: enrich Opportunity with tech_recommendations
 * - ficha/builder.ts: fill web_equivalent in FichaFunction
 *
 * Source: ClonaKit IMP-CLONA-3 — every entry from `FRAMEWORKS` table ported
 * verbatim (purpose text + web_equivalent text). Categories assigned by domain
 * (audio_video, graphics, ui, data, network, security, hardware, ai, system,
 * location, media) — the `storage` slot is reserved for future use.
 */

export type CapabilityCategory =
  | 'audio_video'
  | 'graphics'
  | 'ui'
  | 'data'
  | 'network'
  | 'security'
  | 'hardware'
  | 'ai'
  | 'system'
  | 'storage'
  | 'location'
  | 'media';

export interface CapabilityEntry {
  /** Framework name as it appears in ClonaKit's table (PascalCase). */
  framework: string;
  /** What it does (Spanish, plain-language description from ClonaKit). */
  purpose: string;
  /** How to do it on the web (Spanish, plain-language recommendation). */
  web_equivalent: string;
  /** Domain category, for grouping / stats / UI. */
  category: CapabilityCategory;
}

/**
 * The canonical mapping. Keys are framework names (case-sensitive in the
 * literal, but lookup is case-insensitive via LOWERCASE_INDEX below).
 *
 * Ported verbatim from `/tmp/clonakit-extract/ClonaKit/herramientas/capacidades.mjs`
 * `FRAMEWORKS` export (57 entries).
 */
export const CAPABILITY_MAPPING: Record<string, CapabilityEntry> = {
  // --- Audio / Video ---
  AVFoundation: {
    framework: 'AVFoundation',
    purpose: 'Grabar y reproducir audio y vídeo, usar la cámara',
    web_equivalent: 'getUserMedia() y las etiquetas <video>/<audio>',
    category: 'audio_video',
  },
  AVKit: {
    framework: 'AVKit',
    purpose: 'Reproductor de vídeo',
    web_equivalent: '<video controls>',
    category: 'audio_video',
  },
  ScreenCaptureKit: {
    framework: 'ScreenCaptureKit',
    purpose: 'Capturar la pantalla o ventanas',
    web_equivalent: 'getDisplayMedia()',
    category: 'audio_video',
  },
  CoreAudio: {
    framework: 'CoreAudio',
    purpose: 'Audio de bajo nivel (micrófonos, altavoces)',
    web_equivalent: 'Web Audio API',
    category: 'audio_video',
  },
  AudioUnit: {
    framework: 'AudioUnit',
    purpose: 'Efectos y procesado de audio',
    web_equivalent: 'Web Audio API (AudioWorklet)',
    category: 'audio_video',
  },
  AudioToolbox: {
    framework: 'AudioToolbox',
    purpose: 'Codificar y reproducir audio',
    web_equivalent: 'Web Audio API o MediaRecorder',
    category: 'audio_video',
  },
  CoreMedia: {
    framework: 'CoreMedia',
    purpose: 'Manejar fotogramas y muestras de audio/vídeo',
    web_equivalent: 'MediaStream o WebCodecs',
    category: 'audio_video',
  },
  CoreMediaIO: {
    framework: 'CoreMediaIO',
    purpose: 'Cámaras virtuales y dispositivos de vídeo',
    web_equivalent: 'getUserMedia() (en web no se pueden crear cámaras virtuales)',
    category: 'audio_video',
  },
  CoreVideo: {
    framework: 'CoreVideo',
    purpose: 'Imágenes de vídeo en memoria',
    web_equivalent: '<canvas> o WebCodecs (VideoFrame)',
    category: 'audio_video',
  },
  VideoToolbox: {
    framework: 'VideoToolbox',
    purpose: 'Comprimir vídeo con el chip del ordenador (H.264/HEVC)',
    web_equivalent: 'MediaRecorder o WebCodecs (VideoEncoder)',
    category: 'audio_video',
  },
  Speech: {
    framework: 'Speech',
    purpose: 'Reconocimiento de voz',
    web_equivalent: 'Web Speech API',
    category: 'audio_video',
  },

  // --- Graphics ---
  Metal: {
    framework: 'Metal',
    purpose: 'Gráficos y cálculo en la tarjeta gráfica (GPU)',
    web_equivalent: 'WebGL o WebGPU',
    category: 'graphics',
  },
  MetalKit: {
    framework: 'MetalKit',
    purpose: 'Gráficos en la GPU',
    web_equivalent: 'WebGL o WebGPU',
    category: 'graphics',
  },
  OpenGL: {
    framework: 'OpenGL',
    purpose: 'Gráficos 2D/3D en la GPU (tecnología antigua)',
    web_equivalent: 'WebGL',
    category: 'graphics',
  },
  CoreGraphics: {
    framework: 'CoreGraphics',
    purpose: 'Dibujo 2D, pantallas y ventanas',
    web_equivalent: '<canvas> 2D o SVG',
    category: 'graphics',
  },
  CoreImage: {
    framework: 'CoreImage',
    purpose: 'Filtros de imagen',
    web_equivalent: 'Filtros CSS, <canvas> o WebGL',
    category: 'graphics',
  },
  ImageIO: {
    framework: 'ImageIO',
    purpose: 'Leer y guardar imágenes',
    web_equivalent: '<img>, createImageBitmap() y canvas.toBlob()',
    category: 'graphics',
  },
  QuartzCore: {
    framework: 'QuartzCore',
    purpose: 'Animaciones de la interfaz',
    web_equivalent: 'Animaciones CSS o Web Animations API',
    category: 'graphics',
  },
  CoreText: {
    framework: 'CoreText',
    purpose: 'Tipografía',
    web_equivalent: 'Fuentes CSS (@font-face)',
    category: 'graphics',
  },
  ColorSync: {
    framework: 'ColorSync',
    purpose: 'Gestión del color',
    web_equivalent: 'Colores CSS y colorSpace del canvas',
    category: 'graphics',
  },
  PDFKit: {
    framework: 'PDFKit',
    purpose: 'Ver y editar PDF',
    web_equivalent: 'PDF.js',
    category: 'graphics',
  },
  QuickLook: {
    framework: 'QuickLook',
    purpose: 'Vistas previas de archivos',
    web_equivalent: '<img>, <iframe> o PDF.js',
    category: 'graphics',
  },
  QuickLookThumbnailing: {
    framework: 'QuickLookThumbnailing',
    purpose: 'Miniaturas de archivos',
    web_equivalent: '<canvas> o <img>',
    category: 'graphics',
  },
  SpriteKit: {
    framework: 'SpriteKit',
    purpose: 'Juegos 2D',
    web_equivalent: '<canvas> o Phaser',
    category: 'graphics',
  },
  SceneKit: {
    framework: 'SceneKit',
    purpose: 'Gráficos 3D',
    web_equivalent: 'three.js',
    category: 'graphics',
  },
  IOSurface: {
    framework: 'IOSurface',
    purpose: 'Compartir imágenes entre procesos o con la GPU',
    web_equivalent: 'No aplica en web',
    category: 'graphics',
  },
  Accelerate: {
    framework: 'Accelerate',
    purpose: 'Cálculo matemático rápido',
    web_equivalent: 'JavaScript o WebAssembly',
    category: 'graphics',
  },

  // --- UI ---
  AppKit: {
    framework: 'AppKit',
    purpose: 'Interfaz nativa de Mac (ventanas, menús, botones)',
    web_equivalent: 'HTML + CSS',
    category: 'ui',
  },
  Cocoa: {
    framework: 'Cocoa',
    purpose: 'Interfaz nativa de Mac (ventanas, menús, botones)',
    web_equivalent: 'HTML + CSS',
    category: 'ui',
  },
  SwiftUI: {
    framework: 'SwiftUI',
    purpose: 'Interfaz moderna de Apple',
    web_equivalent: 'HTML + CSS (o React, Vue…)',
    category: 'ui',
  },
  WebKit: {
    framework: 'WebKit',
    purpose: 'Mostrar páginas web dentro de la app',
    web_equivalent: 'Un <iframe> o la propia web',
    category: 'ui',
  },
  JavaScriptCore: {
    framework: 'JavaScriptCore',
    purpose: 'Ejecutar JavaScript dentro de la app',
    web_equivalent: 'El JavaScript del navegador',
    category: 'ui',
  },
  UniformTypeIdentifiers: {
    framework: 'UniformTypeIdentifiers',
    purpose: 'Tipos de archivo',
    web_equivalent: '<input type="file" accept="…">',
    category: 'ui',
  },

  // --- Data ---
  Foundation: {
    framework: 'Foundation',
    purpose: 'Base de cualquier app de Apple (texto, fechas, archivos)',
    web_equivalent: 'JavaScript estándar',
    category: 'data',
  },
  CoreFoundation: {
    framework: 'CoreFoundation',
    purpose: 'Base de cualquier app de Apple (texto, fechas, archivos)',
    web_equivalent: 'JavaScript estándar',
    category: 'data',
  },
  CoreData: {
    framework: 'CoreData',
    purpose: 'Base de datos local',
    web_equivalent: 'IndexedDB o localStorage',
    category: 'data',
  },
  CloudKit: {
    framework: 'CloudKit',
    purpose: 'Sincronizar datos en iCloud',
    web_equivalent: 'Un backend (Supabase, Firebase…)',
    category: 'data',
  },
  Combine: {
    framework: 'Combine',
    purpose: 'Reaccionar a cambios de datos',
    web_equivalent: 'Eventos y promesas de JavaScript',
    category: 'data',
  },

  // --- Network ---
  Network: {
    framework: 'Network',
    purpose: 'Conexiones de red',
    web_equivalent: 'fetch() o WebSocket',
    category: 'network',
  },
  CFNetwork: {
    framework: 'CFNetwork',
    purpose: 'Conexiones de red',
    web_equivalent: 'fetch() o WebSocket',
    category: 'network',
  },
  SystemConfiguration: {
    framework: 'SystemConfiguration',
    purpose: 'Estado de la conexión a internet',
    web_equivalent: 'navigator.onLine',
    category: 'network',
  },

  // --- Security ---
  Security: {
    framework: 'Security',
    purpose: 'Llavero, certificados y cifrado',
    web_equivalent: 'Web Crypto API (las contraseñas, mejor en un servidor)',
    category: 'security',
  },
  LocalAuthentication: {
    framework: 'LocalAuthentication',
    purpose: 'Touch ID / Face ID',
    web_equivalent: 'WebAuthn (passkeys)',
    category: 'security',
  },
  AuthenticationServices: {
    framework: 'AuthenticationServices',
    purpose: 'Iniciar sesión con Apple o passkeys',
    web_equivalent: 'WebAuthn u OAuth',
    category: 'security',
  },

  // --- Hardware ---
  CoreBluetooth: {
    framework: 'CoreBluetooth',
    purpose: 'Bluetooth',
    web_equivalent: 'Web Bluetooth (solo Chrome)',
    category: 'hardware',
  },
  IOKit: {
    framework: 'IOKit',
    purpose: 'Hardware: USB, energía, dispositivos',
    web_equivalent: 'WebUSB o WebHID (limitado)',
    category: 'hardware',
  },
  GameController: {
    framework: 'GameController',
    purpose: 'Mandos de juego',
    web_equivalent: 'Gamepad API',
    category: 'hardware',
  },

  // --- AI ---
  CoreML: {
    framework: 'CoreML',
    purpose: 'Inteligencia artificial en el propio ordenador',
    web_equivalent: 'TensorFlow.js, ONNX Runtime Web o una API de IA',
    category: 'ai',
  },
  Vision: {
    framework: 'Vision',
    purpose: 'Reconocer texto, caras u objetos en imágenes',
    web_equivalent: 'Tesseract.js o una API de IA',
    category: 'ai',
  },
  NaturalLanguage: {
    framework: 'NaturalLanguage',
    purpose: 'Analizar texto',
    web_equivalent: 'Una API de IA',
    category: 'ai',
  },

  // --- System (entitlements, extensions, low-level) ---
  DiskArbitration: {
    framework: 'DiskArbitration',
    purpose: 'Detectar discos conectados',
    web_equivalent: 'No disponible en web',
    category: 'system',
  },
  ApplicationServices: {
    framework: 'ApplicationServices',
    purpose: 'Accesibilidad, eventos y control de otras apps',
    web_equivalent: 'No disponible en web (los atajos solo funcionan con la pestaña activa)',
    category: 'system',
  },
  Carbon: {
    framework: 'Carbon',
    purpose: 'APIs antiguas de Mac (p. ej. atajos de teclado globales)',
    web_equivalent: 'No disponible en web',
    category: 'system',
  },
  ServiceManagement: {
    framework: 'ServiceManagement',
    purpose: 'Arrancar al iniciar sesión o lanzar ayudantes',
    web_equivalent: 'No aplica en web',
    category: 'system',
  },
  SystemExtensions: {
    framework: 'SystemExtensions',
    purpose: 'Extensiones del sistema (p. ej. cámara virtual)',
    web_equivalent: 'No disponible en web',
    category: 'system',
  },

  // --- Location ---
  CoreLocation: {
    framework: 'CoreLocation',
    purpose: 'Ubicación',
    web_equivalent: 'navigator.geolocation',
    category: 'location',
  },
  MapKit: {
    framework: 'MapKit',
    purpose: 'Mapas',
    web_equivalent: 'Leaflet + OpenStreetMap',
    category: 'location',
  },

  // --- Media (user data: contacts, calendar, notifications, payments) ---
  Contacts: {
    framework: 'Contacts',
    purpose: 'Contactos del usuario',
    web_equivalent: 'Un formulario propio (la web no puede leer tus contactos)',
    category: 'media',
  },
  EventKit: {
    framework: 'EventKit',
    purpose: 'Calendario y recordatorios',
    web_equivalent: 'Archivos .ics o la API de Google Calendar',
    category: 'media',
  },
  UserNotifications: {
    framework: 'UserNotifications',
    purpose: 'Notificaciones',
    web_equivalent: 'Notifications API',
    category: 'media',
  },
  StoreKit: {
    framework: 'StoreKit',
    purpose: 'Compras dentro de la app',
    web_equivalent: 'Stripe u otra pasarela de pago web',
    category: 'media',
  },
};

// ---------------------------------------------------------------------------
// Reverse index for case-insensitive lookup. Built once at module load.
// ---------------------------------------------------------------------------
const LOWERCASE_INDEX: Map<string, CapabilityEntry> = new Map();
for (const [key, entry] of Object.entries(CAPABILITY_MAPPING)) {
  LOWERCASE_INDEX.set(key.toLowerCase(), entry);
}

/**
 * Look up a framework by name (case-insensitive).
 * Returns undefined if not in the table.
 *
 * @example lookupCapability('AVFoundation') // → entry
 * @example lookupCapability('avfoundation') // → same entry (case-insensitive)
 * @example lookupCapability('UnknownFramework') // → undefined
 */
export function lookupCapability(framework: string): CapabilityEntry | undefined {
  if (!framework) return undefined;
  return LOWERCASE_INDEX.get(framework.toLowerCase());
}

/**
 * Scan a text snippet for mentions of known frameworks.
 * Returns the entries found, with their character positions in the text
 * (positions refer to the lowercased input — useful for highlighting in UIs).
 *
 * Uses word-boundary matching to avoid false positives (e.g. "Network" should
 * match the standalone word, not "networking"). All matching is case-insensitive.
 *
 * @example detectTechMentions('This app uses AVFoundation and CoreData')
 *           // → [{ entry: AVFoundationEntry, positions: [14] },
 *           //    { entry: CoreDataEntry, positions: [29] }]
 */
export interface TechMention {
  entry: CapabilityEntry;
  /** Character offsets where the framework name was found (lowercased text). */
  positions: number[];
}

export function detectTechMentions(text: string): TechMention[] {
  if (!text) return [];
  const lowerText = text.toLowerCase();
  const found = new Map<string, TechMention>();

  for (const [key, entry] of LOWERCASE_INDEX) {
    // Word-boundary regex to avoid matching substrings inside other words
    // (e.g. "Network" inside "networking", or "Vision" inside "television").
    // `key` is already lowercased, so no 'i' flag needed for matching against
    // lowerText — but we keep the global flag to find every occurrence.
    const regex = new RegExp(`\\b${escapeRegex(key)}\\b`, 'g');
    const positions: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(lowerText)) !== null) {
      positions.push(match.index);
      // Defensive against zero-length matches (shouldn't happen with \b, but)
      if (match.index === regex.lastIndex) regex.lastIndex++;
    }
    if (positions.length > 0) {
      found.set(key, { entry, positions });
    }
  }

  return Array.from(found.values());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get all frameworks in a category.
 */
export function listByCategory(category: CapabilityCategory): CapabilityEntry[] {
  return Object.values(CAPABILITY_MAPPING).filter((e) => e.category === category);
}

/**
 * Get all categories with counts (for UI / docs / dashboards).
 *
 * Categories with zero entries (e.g. `storage`) are still returned with a
 * count of 0 so callers can render a stable category list.
 */
export function categoryStats(): Record<CapabilityCategory, number> {
  const stats: Partial<Record<CapabilityCategory, number>> = {};
  // Initialise every known category to 0 so the return shape is stable.
  const allCategories: CapabilityCategory[] = [
    'audio_video', 'graphics', 'ui', 'data', 'network', 'security',
    'hardware', 'ai', 'system', 'storage', 'location', 'media',
  ];
  for (const c of allCategories) stats[c] = 0;
  for (const entry of Object.values(CAPABILITY_MAPPING)) {
    stats[entry.category] = (stats[entry.category] ?? 0) + 1;
  }
  return stats as Record<CapabilityCategory, number>;
}

/**
 * Total number of frameworks in the table (for diagnostics / docs).
 */
export const CAPABILITY_COUNT: number = Object.keys(CAPABILITY_MAPPING).length;
