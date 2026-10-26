import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = {
  title: "Términos de servicio — CHISMOSO",
  description:
    "Términos y condiciones de uso de CHISMOSO, el agente de inteligencia de señales y oportunidades de negocio.",
};

const LAST_UPDATED = "2025-01-15";

export default function TermsPage() {
  return (
    <main className="flex-1 min-h-screen bg-background text-foreground">
      <article className="container mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
        <header className="mb-10 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary">Legal</Badge>
            <Badge variant="outline">v1.5.0</Badge>
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Términos de servicio
          </h1>
          <p className="text-sm text-muted-foreground">
            Última actualización: {LAST_UPDATED} · Vigente desde: {LAST_UPDATED}
          </p>
        </header>

        <div className="space-y-8">
          <section className="space-y-3">
            <h2 className="text-xl font-semibold">1. Aceptación de los términos</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Al acceder o usar CHISMOSO (&ldquo;el Servicio&rdquo;), aceptas
              quedar vinculado por estos Términos de Servicio (&ldquo;los
              Términos&rdquo;). Si no estás de acuerdo con alguna parte, no
              uses el Servicio. Si eres menor de edad o no tienes capacidad
              legal para celebrar contratos en tu jurisdicción, no puedes usar
              el Servicio.
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              ALBRA Labs (&ldquo;nosotros&rdquo;, &ldquo;el Proveedor&rdquo;)
              puede modificar estos Términos en cualquier momento. La versión
              vigente es la publicada en esta página con la fecha de
              actualización. El uso continuado del Servicio después de un
              cambio constituye aceptación de los nuevos Términos.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">2. Definiciones</h2>
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li>
                <strong>Servicio:</strong> el software CHISMOSO V1.5, incluyendo
                la aplicación web, la API REST, los proveedores de datos y los
                flujos de inteligencia automatizados.
              </li>
              <li>
                <strong>Usuario:</strong> la persona o entidad que accede al
                Servicio, ya sea como operador autenticado o como cliente final
                de una implementación gestionada.
              </li>
              <li>
                <strong>Investigación:</strong> el proceso de generación de
                inteligencia disparado por un objetivo textual del Usuario.
              </li>
              <li>
                <strong>Señales:</strong> los datos crudos recuperados de
                fuentes públicas durante una Investigación.
              </li>
              <li>
                <strong>Oportunidades:</strong> el análisis estructurado
                producido a partir de las Señales por el Servicio.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">3. Descripción del servicio</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              CHISMOSO es un agente de inteligencia que detecta señales
              tempranas, tendencias, problemas emergentes y oportunidades de
              negocio a partir de fuentes públicas (Reddit, Google Trends,
              web general). El Servicio:
            </p>
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li>Recibe un objetivo textual del Usuario.</li>
              <li>Recupera Señales de fuentes públicas usando sus proveedores de datos.</li>
              <li>Sintetiza las Señales en Oportunidades usando un modelo de lenguaje (LLM).</li>
              <li>Persiste Señales + Oportunidades + log de auditoría en una base de datos local.</li>
              <li>Expone las Oportunidades vía dashboard web + API REST.</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              El Servicio <strong>no</strong> es un servicio de asesoría
              financiera, legal, ni de inversión. Las Oportunidades son
              hipótesis de negocio generadas automáticamente; el Usuario es
              responsable de validarlas antes de actuar sobre ellas.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">4. Política de uso aceptable</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              El Usuario se compromete a usar el Servicio únicamente para fines
              lícitos. <strong>Está prohibido:</strong>
            </p>
            <div className="space-y-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">4.1 Usos prohibidos</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  <ul className="list-disc space-y-1 pl-5">
                    <li>Usar el Servicio para acosar, difamar o dañar a terceros.</li>
                    <li>
                      Recopilar datos personales de fuentes públicas sin base
                      legal (consentimiento, interés legítimo, etc.).
                    </li>
                    <li>
                      Realizar ingeniería inversa, descompilar o extraer el
                      código fuente del Servicio sin autorización.
                    </li>
                    <li>
                      Intentar evadir los límites de tasa (rate-limit),
                      credenciales o cualquier control de acceso.
                    </li>
                    <li>
                      Usar el Servicio para generar contenido ilegal, fraudulento
                      o que infrinja derechos de propiedad intelectual de terceros.
                    </li>
                    <li>
                      Re-vender, sublicenciar o redistribuir las Oportunidades
                      como un servicio competidor sin autorización expresa.
                    </li>
                  </ul>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">4.2 Límites técnicos</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  El Servicio impone límites de concurrencia (por defecto, 3
                  investigaciones simultáneas, configurable vía{" "}
                  <code className="font-mono">CHISMOSO_MAX_CONCURRENT_INVESTIGATIONS</code>)
                  y de tasa por IP. El Proveedor puede modificar estos límites
                  sin previo aviso para proteger la estabilidad del sistema.
                </CardContent>
              </Card>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">5. Cuentas y autenticación</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              El acceso al Servicio se realiza mediante tokens de autenticación
              cuando <code className="font-mono">CHISMOSO_AUTH_ENABLED=true</code>.
              El Usuario es responsable de:
            </p>
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li>Mantener la confidencialidad de sus tokens.</li>
              <li>Notificar inmediatamente al Proveedor si un token se compromete.</li>
              <li>Todas las actividades realizadas con su token.</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              El Proveedor puede revocar tokens en cualquier momento si detecta
              uso anómalo o violación de los Términos.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">6. Propiedad intelectual</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              El código fuente de CHISMOSO se publica bajo licencia open source
              en <a
                className="font-medium text-foreground underline underline-offset-4 hover:opacity-80"
                href="https://github.com/ALBRA8/AGENTE-CHISMOSO"
                target="_blank"
                rel="noreferrer"
              >github.com/ALBRA8/AGENTE-CHISMOSO</a>.
              Ver el archivo <code className="font-mono">LICENSE</code> en el
              repositorio para los términos exactos.
            </p>
            <p className="text-sm text-muted-foreground">
              Las Señales recuperadas de fuentes públicas siguen la propiedad
              intelectual de sus respectivos autores. El Servicio las cita con
              atribución cuando es posible.
            </p>
            <p className="text-sm text-muted-foreground">
              Las Oportunidades generadas por el Servicio son del Usuario que
              disparó la investigación. El Usuario puede usarlas, modificarlas
              y distribuirlas conforme a estos Términos.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">7. Sin garantía (&ldquo;as is&rdquo;)</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              EL SERVICIO SE PROPORCIONA &ldquo;TAL CUAL&rdquo; Y &ldquo;SEGÚN
              DISPONIBILIDAD&rdquo;, SIN GARANTÍAS DE NINGÚN TIPO, EXPRESAS O
              IMPLÍCITAS, INCLUYENDO PERO NO LIMITÁNDOSE A GARANTÍAS DE
              COMERCIABILIDAD, ADECUACIÓN PARA UN PROPÓSITO PARTICULAR O NO
              INFRACCIÓN.
            </p>
            <p className="text-sm text-muted-foreground">
              El Proveedor no garantiza que:
            </p>
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li>Las Oportunidades sean precisas, completas o accionables.</li>
              <li>El Servicio funcione ininterrumpidamente o libre de errores.</li>
              <li>Los proveedores de datos (Reddit, Google, etc.) sigan siendo accesibles.</li>
              <li>El proveedor de LLM mantenga la disponibilidad o calidad esperada.</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              El Usuario debe validar las Oportunidades con fuentes adicionales
              antes de tomar decisiones de negocio.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">8. Limitación de responsabilidad</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              EN LA MÁXIMA MEDIDA PERMITIDA POR LA LEY APLICABLE, EN NINGÚN
              CASO EL PROVEEDOR SERÁ RESPONSABLE ANTE EL USUARIO POR DAÑOS
              INDIRECTOS, INCIDENTALES, ESPECIALES, CONSECUENCIALES O PUNITIVOS,
              INCLUYENDO PERO NO LIMITÁNDOSE A PÉRDIDA DE GANANCIAS, PÉRDIDA DE
              DATOS, PÉRDIDA DE OPORTUNIDADES DE NEGOCIO O INTERRUPCIÓN DE
              NEGOCIO, DERIVADOS DEL USO O IMPOSIBILIDAD DE USO DEL SERVICIO.
            </p>
            <p className="text-sm text-muted-foreground">
              La responsabilidad agregada del Proveedor, sea cual sea la causa,
              no excederá el monto pagado por el Usuario al Proveedor por el
              Servicio en los 12 meses anteriores al evento que origina la
              reclamación.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">9. Indemnidad</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              El Usuario acuerda indemnizar y exonerar al Proveedor, sus
              directores, empleados y afiliados de cualquier reclamación,
              pérdida, daño o gasto (incluyendo honorarios legales) derivados
              de:
            </p>
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li>El uso del Servicio por parte del Usuario en violación de estos Términos.</li>
              <li>La violación de derechos de terceros (incluyendo propiedad intelectual).</li>
              <li>El contenido de los objetivos de investigación enviados al Servicio.</li>
              <li>Las decisiones de negocio tomadas a partir de las Oportunidades generadas.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">10. Suspensión y terminación</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              El Proveedor puede suspender o terminar el acceso del Usuario al
              Servicio en cualquier momento, con o sin causa, con o sin
              preaviso. El Usuario puede dejar de usar el Servicio en cualquier
              momento; la terminación no exime del pago de facturas pendientes
              (si aplica un modelo de suscripción).
            </p>
            <p className="text-sm text-muted-foreground">
              Tras la terminación, el Usuario puede exportar sus datos (Señales
              + Oportunidades + log de auditoría) durante 30 días. Ver{" "}
              <Link
                href="/legal/privacy"
                className="font-medium text-foreground underline underline-offset-4 hover:opacity-80"
              >Política de privacidad</Link> §6.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">11. Ley aplicable y jurisdicción</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Estos Términos se rigen por las leyes de la República de Colombia,
              sin dar efecto a sus principios de conflicto de leyes.
            </p>
            <p className="text-sm text-muted-foreground">
              Cualquier disputa derivada de o relacionada con estos Términos
              se someterá a la jurisdicción exclusiva de los tribunales de
              Bogotá D.C., Colombia, sin perjuicio de los derechos del
              consumidor que le asistan al Usuario en su jurisdicción de
              residencia.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">12. Disposiciones generales</h2>
            <ul className="list-disc space-y-2 pl-6 text-sm text-muted-foreground">
              <li>
                <strong>Acuerdo completo:</strong> estos Términos, junto con la{" "}
                <Link
                  href="/legal/privacy"
                  className="font-medium text-foreground underline underline-offset-4 hover:opacity-80"
                >Política de privacidad</Link> y la{" "}
                <Link
                  href="/SECURITY.md"
                  className="font-medium text-foreground underline underline-offset-4 hover:opacity-80"
                >Política de seguridad</Link>, constituyen el acuerdo completo
                entre el Proveedor y el Usuario sobre el Servicio.
              </li>
              <li>
                <strong>Divisibilidad:</strong> si una disposición se declara
                inválida, las demás permanecen en vigor.
              </li>
              <li>
                <strong>Renuncia:</strong> la no exigencia de un derecho no
                constituye renuncia al mismo.
              </li>
              <li>
                <strong>Cesión:</strong> el Usuario no puede ceder estos
                Términos sin consentimiento del Proveedor. El Proveedor puede
                cederlos libremente en caso de fusión, adquisición o venta de
                activos.
              </li>
              <li>
                <strong>Acuerdos de nivel de servicio (SLA):</strong> no se
                aplica al Servicio self-hosted. Para instancias gestionadas con
                SLA, los términos se documentan en el contrato comercial
                correspondiente.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">13. Contacto</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Para preguntas sobre estos Términos:{" "}
              <a
                className="font-medium text-foreground underline underline-offset-4 hover:opacity-80"
                href="mailto:legal@albra.co"
              >
                legal@albra.co
              </a>
              . Para reportes de vulnerabilidades de seguridad, ver{" "}
              <Link
                href="/SECURITY.md"
                className="font-medium text-foreground underline underline-offset-4 hover:opacity-80"
              >Política de seguridad</Link>
              .
            </p>
          </section>
        </div>

        <footer className="mt-12 border-t pt-6 text-xs text-muted-foreground">
          <p>
            Documento generado para CHISMOSO V1.5.0 · Última revisión: {LAST_UPDATED} ·
            Proveedor: ALBRA Labs · Ley aplicable: Colombia · Contacto: legal@albra.co
          </p>
        </footer>
      </article>
    </main>
  );
}
