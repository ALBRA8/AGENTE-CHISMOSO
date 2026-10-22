import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = {
  title: "Política de privacidad — CHISMOSO",
  description:
    "Cómo CHISMOSO recopila, usa y protege los datos de las investigaciones de inteligencia de señales y oportunidades.",
};

const LAST_UPDATED = "2025-01-15";

export default function PrivacyPage() {
  return (
    <main className="flex-1 min-h-screen bg-background text-foreground">
      <article className="container mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
        <header className="mb-10 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary">Legal</Badge>
            <Badge variant="outline">v1.5.0</Badge>
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Política de privacidad
          </h1>
          <p className="text-sm text-muted-foreground">
            Última actualización: {LAST_UPDATED} · Vigente desde: {LAST_UPDATED}
          </p>
        </header>

        <div className="space-y-8">
          <section className="space-y-3">
            <h2 className="text-xl font-semibold">1. Responsable del tratamiento</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              ALBRA Labs (&ldquo;nosotros&rdquo;, &ldquo;el responsable&rdquo;) opera
              CHISMOSO, un agente de inteligencia de señales, tendencias,
              problemas y oportunidades de negocio. Si tienes preguntas sobre
              esta política o quieres ejercer tus derechos, escríbenos a
              <a
                className="ml-1 font-medium text-foreground underline underline-offset-4 hover:opacity-80"
                href="mailto:privacy@albra.co"
              >
                privacy@albra.co
              </a>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">2. Datos que recopilamos</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              CHISMOSO recopila los siguientes datos para generar inteligencia
              de negocio. Todos se almacenan en una base de datos local
              (SQLite) en el servidor donde se despliega el sistema.
            </p>
            <div className="space-y-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">2.1 Objetivos de investigación</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  El texto libre que envías al agente cuando lanzas una
                  investigación (&ldquo;¿qué oportunidades hay en X sector?&rdquo;).
                  Se usa como input para la generación de inteligencia.
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">2.2 Señales y evidencia</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  URLs, fragmentos de texto y metadatos de fuentes públicas
                  (Reddit, Google Trends, web general) que el agente recupera
                  durante la investigación. Pueden incluir nombres de usuarios
                  públicos de dichas plataformas.
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">2.3 Oportunidades y tendencias</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  El análisis estructurado (oportunidades, tendencias, problemas)
                  que el agente produce a partir de las señales. Es el output
                  principal del sistema.
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">2.4 Log de auditoría</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Cada llamada a una herramienta y cada error se registran en
                  la tabla <code className="font-mono">execution_trace</code> con
                  timestamp, tipo de operación y resultado. Esto permite
                  reproducir investigaciones y diagnosticar fallos.
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">2.5 Tokens de autenticación</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Si activas la autenticación (<code className="font-mono">CHISMOSO_AUTH_ENABLED=true</code>),
                  almacenamos únicamente el <strong>hash SHA-256</strong> del
                  token que usas para acceder a la API. El token en texto plano
                  nunca se almacena.
                </CardContent>
              </Card>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">3. Cómo usamos los datos</h2>
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li>
                <strong>Generación de inteligencia:</strong> los objetivos +
                señales se envían al modelo de lenguaje (LLM) del proveedor
                configurado (ver §4) para sintetizar el análisis final.
              </li>
              <li>
                <strong>Mejora del sistema:</strong> los logs de auditoría y el
                feedback explícito (útil / no útil) que envíes sobre las
                oportunidades sirven para ajustar la priorización futura.
              </li>
              <li>
                <strong>Operación técnica:</strong> métricas de latencia y
                tasa de éxito por proveedor de datos se usan para detectar
                degradación y rutas alternativas.
              </li>
            </ul>
            <p className="text-sm text-muted-foreground">
              <strong>No</strong> usamos tus datos para: publicidad, entrenar
              modelos propios, ni vender a terceros.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">4. Terceros con acceso a los datos</h2>
            <div className="space-y-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">4.1 Proveedor de LLM</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  CHISMOSO usa el SDK de <code className="font-mono">z-ai-web-dev-sdk</code>{" "}
                  para acceder al LLM. El objetivo de tu investigación + las
                  señales recopiladas se envían al proveedor para generar el
                  análisis. El proveedor actúa como <strong>encargado del
                  tratamiento</strong> bajo sus propios términos.
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">4.2 Proveedor de hosting</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Si despliegas CHISMOSO en un cloud (AWS, GCP, Hetzner, etc.),
                  ese proveedor tiene acceso físico a los discos donde se
                  almacenan los datos. Aplican sus propias políticas de
                  privacidad.
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">4.3 Sentry (opcional)</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Si configuras <code className="font-mono">SENTRY_DSN</code>,
                  los errores no controlados se envían a Sentry para depuración.
                  Recomendamos configurar <code className="font-mono">beforeSend</code>{" "}
                  para sanitizar datos sensibles (objetivos, URLs) antes del
                  envío.
                </CardContent>
              </Card>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">5. Base legal del tratamiento</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Tratamos tus datos bajo las siguientes bases legales (Reglamento
              General de Protección de Datos — Ley 1581 de 2012 Colombia — y,
              si aplicas, GDPR UE):
            </p>
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li>
                <strong>Ejecución de un contrato (art. 7 GDPR / art. 10 Ley 1581):</strong>{" "}
                los datos necesarios para generar la inteligencia que solicitaste.
              </li>
              <li>
                <strong>Interés legítimo (art. 6.1.f GDPR):</strong> los logs de
                auditoría para asegurar la integridad + reproducibilidad del
                análisis.
              </li>
              <li>
                <strong>Consentimiento:</strong> el feedback explícito que envíes
                sobre oportunidades. Puedes retirarlo en cualquier momento.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">6. Tus derechos</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Como titular de los datos, puedes ejercer en cualquier momento los
              siguientes derechos escribiendo a{" "}
              <a
                className="font-medium text-foreground underline underline-offset-4 hover:opacity-80"
                href="mailto:privacy@albra.co"
              >
                privacy@albra.co
              </a>
              :
            </p>
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li><strong>Acceso</strong> — qué datos tenemos sobre ti.</li>
              <li><strong>Rectificación</strong> — corregir datos inexactos.</li>
              <li><strong>Supresión</strong> — borrar tus datos (&ldquo;derecho al olvido&rdquo;).</li>
              <li><strong>Exportación</strong> — recibir una copia en formato estructurado (JSON + Markdown).</li>
              <li><strong>Oposición</strong> — no usar tus datos para fines específicos.</li>
              <li><strong>Limitación</strong> — bloquear el tratamiento mientras se verifica una solicitud.</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              Respondemos en un máximo de 30 días calendario. Si no estás
              conforme, puedes presentar una reclamación ante la Superintendencia
              de Industria y Comercio (Colombia) o ante la autoridad de
              protección de datos de tu jurisdicción.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">7. Retención de datos</h2>
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li>
                <strong>Investigaciones + señales + oportunidades:</strong> se
                conservan mientras tu suscripción esté activa. Al cancelarla,
                se eliminan en 30 días salvo obligación legal de retención.
              </li>
              <li>
                <strong>Logs de auditoría:</strong> 12 meses. Tras ello,
                eliminación automática (cron programado).
              </li>
              <li>
                <strong>Feedback:</strong> se conserva hasta que el usuario lo
                retire.
              </li>
              <li>
                <strong>Backups cifrados:</strong> 90 días en S3, luego rotación
                automática.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">8. Cookies</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              CHISMOSO usa cookies mínimas, estrictamente necesarias para el
              funcionamiento del sistema. Ver el banner de consentimiento abajo
              en la pantalla. No usamos cookies de seguimiento ni de
              publicidad. Detalle en{" "}
              <Link
                href="/legal/terms"
                className="font-medium text-foreground underline underline-offset-4 hover:opacity-80"
              >
                Términos de servicio
              </Link>{" "}
              §5.
            </p>
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li>
                <code className="font-mono">chismoso_session</code> — mantiene tu
                sesión autenticada (si auth habilitado). Cierre del navegador =
                cookie caduca.
              </li>
              <li>
                <code className="font-mono">chismoso_theme</code> — preferencia
                de tema claro/oscuro. Persistente.
              </li>
              <li>
                <code className="font-mono">chismoso_cookie_consent</code> —
                registro de tu consentimiento. 12 meses.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">9. Medidas de seguridad</h2>
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li>Cifrado en tránsito (TLS 1.3 vía Caddy + Let&rsquo;s Encrypt).</li>
              <li>Hash SHA-256 para tokens de autenticación (nunca se almacenan en texto plano).</li>
              <li>Rate-limiting por IP + por endpoint.</li>
              <li>Backups cifrados con GPG + opción de off-site S3.</li>
              <li>Contenedor runtime como usuario no-root (<code className="font-mono">nextjs:1001</code>).</li>
              <li>Aislamiento por Docker network — los servicios internos (Postgres, Redis) no se exponen a Internet.</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              Para reportar una vulnerabilidad, ver{" "}
              <Link
                href="/SECURITY.md"
                className="font-medium text-foreground underline underline-offset-4 hover:opacity-80"
              >
                política de seguridad
              </Link>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">10. Cambios a esta política</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Podemos actualizar esta política cuando el sistema cambie
              materialmente. Publicaremos la nueva versión aquí con la fecha
              actualizada. Si un cambio reduce tus derechos, te notificaremos
              por email (si tenemos tu dirección) con al menos 30 días de
              antelación.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">11. Contacto</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Para cualquier pregunta sobre privacidad:{" "}
              <a
                className="font-medium text-foreground underline underline-offset-4 hover:opacity-80"
                href="mailto:privacy@albra.co"
              >
                privacy@albra.co
              </a>
              .
            </p>
          </section>
        </div>

        <footer className="mt-12 border-t pt-6 text-xs text-muted-foreground">
          <p>
            Documento generado para CHISMOSO V1.5.0 · Última revisión: {LAST_UPDATED} ·
            Responsable: ALBRA Labs · Contacto: privacy@albra.co
          </p>
        </footer>
      </article>
    </main>
  );
}
