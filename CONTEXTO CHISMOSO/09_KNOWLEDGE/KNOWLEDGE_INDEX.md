# 09_KNOWLEDGE: Glosario y Base de Conocimiento (KNOWLEDGE_INDEX)

Este documento define la terminología, fórmulas de confianza y modelos cuantitativos utilizados por el motor de AGENTE-CHISMOSO.

---

## 1. Glosario de Conceptos SIGINT / OSINT

- **OSINT (Open Source Intelligence):** Inteligencia obtenida a partir de fuentes de acceso público (artículos web, foros, portales de empleo, notas de prensa).
- **SIGINT (Signals Intelligence):** Monitoreo y captura sistemática de señales de mercado cuantitativas y cualitativas.
- **Señal (Signal):** Unidad atómica de información observada en una fuente (ej. una mención de startup, un reporte de crecimiento, una queja en foro).
- **Evidencia (Evidence):** Registro documental (URL, snippet, ranking, fecha) que respalda y valida la existencia de una señal.
- **Tendencia (Trend):** Agrupación o cluster de señales correlacionadas en torno a un tópico emergente.
- **Fricción / Problema (Problem):** Dolor de cliente o barrera de adopción detectada en el lenguaje de las señales.
- **Oportunidad (Opportunity):** Hipótesis de solución de negocio nacida del cruce entre una tendencia emergente y una fricción no resuelta.

---

## 2. Estados de una Tendencia

1. `WEAK_SIGNAL` (Señal Débil): Volumen incipiente de menciones; alta novedad, baja validación estadística.
2. `EMERGING` (Emergente): Crecimiento de menciones constante en varias fuentes independientes.
3. `SURGING` (En Alza Rápida): Crecimiento exponencial de menciones en un periodo corto.
4. `STABLE` (Consolidada): Alto volumen pero velocidad constante o meseta.

---

## 3. Modelo de Confianza Global (Overall Confidence)
La confianza de una investigación se calcula de forma compuesta considerando:
1. **Diversidad de Fuentes (Source Diversity):** Penalización si todas las señales provienen de un solo dominio.
2. **Frescura Temporal (Recency Factor):** Mayor ponderación a observaciones recientes vs históricas.
3. **Consistencia de Evidencias:** Grado de concordancia entre los snippets de diferentes autores y rankings.
