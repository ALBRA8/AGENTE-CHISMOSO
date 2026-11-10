# ALBRA — Modalidad gestionada de AGENTE-CHISMOSO

Esta carpeta contiene lo que el **INSTALADOR ALBRA** consume para instalar,
supervisar y operar Chismoso como agente gestionado (desde el PANEL DE CONTROL).

## Archivos

| Archivo | Función |
|---|---|
| `deployment.json` | Declaración de despliegue (`container-deployment-source/1`): compose, env, secretos generados, imágenes por fijar, persistencia |
| `.env.albra.example` | Documentación REAL de variables: qué genera el instalador, qué aporta el operador |

## Cómo funciona (flujo INSTALADOR → PANEL)

1. El INSTALADOR valida Docker Engine + Compose v2 (fail-closed si faltan).
2. Crea la red administrada `albra-agents` (externa, compartida con el PANEL/gateway).
3. Genera `CHISMOSO_JWT_SECRET` (random 32B) y escribe `.env.albra` con modo **0600** (O_EXCL: nunca rota secretos en silencio).
4. Fija el **digest SHA-256 real** de cada imagen (`docker pull` + `inspect .RepoDigests`): sin digest no hay despliegue.
5. Materializa `compose.albra.yaml` con los digests y ejecuta `compose pull` + `compose up -d`.
6. Espera la salud REAL de los healthchecks de Compose (`/api/livez` → `/api/health`), timeout 180 s.
7. Registra el despliegue (Prisma `ContainerDeployment`) y lo expone al PANEL vía contrato ops EEC (`/api/ops`, Bearer + nonce + expiración).

## Lo que el operador aporta (no se inventa)

- `CHISMOSO_AUTH_TOKENS`: hashes de tokens de máquina (`chismoso auth issue`).
- `CHISMOSO_MESH_SECRETS`: solo si conecta el mesh con otros agentes.

## Modalidades separadas (sin colisiones)

- **Independiente** (este repo, sin ALBRA): `docker-compose.yml` + `docker-compose.prod.yml` + Caddy publicando 80/443.
- **ALBRA** (gestionada): `compose.albra.yaml` — sin Caddy embebido, sin `container_name` fijos, sin puertos al host, red `albra-agents`, secretos del INSTALADOR.

## Backups y datos

Volúmenes dedicados: `chismoso_data` (SQLite), `chismoso_reports`, `chismoso_backups`, `redis_data`.
STOP/UPDATE/ROLLBACK los conservan SIEMPRE. Solo `UNINSTALL` con
`params.purgeData=true` + `dataMode="DELETE"` (confirmación explícita en el PANEL)
elimina volúmenes — y lista los nombres antes de borrarlos.
