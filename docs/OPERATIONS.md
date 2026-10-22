# Operations Guide — CHISMOSO V1.5

> Day-to-day operations runbook. For fresh deploys see [DEPLOYMENT.md](./DEPLOYMENT.md). For upgrades + rollbacks see [UPGRADE.md](./UPGRADE.md). For incidents see [§Disaster recovery](#disaster-recovery) below.

---

## Quick reference

| Action | Command |
|---|---|
| View app logs | `docker compose logs -f app` |
| Restart app | `docker compose restart app` |
| Rebuild + restart | `docker compose up -d --build app` |
| Health check | `curl -fsS https://<domain>/api/health` |
| Readiness (14 subsystems) | `curl -fsS https://<domain>/api/doctor` |
| Manual backup | `docker compose exec app /opt/scripts/backup-sqlite.sh` |
| Run a CLI command | `docker compose exec app node chismoso/dist/cli.js <command>` |
| Stack status | `docker compose ps` |
| Resource usage | `docker stats` |

---

## Logs

### Per-service tail

```bash
docker compose logs -f app                    # Next.js + API routes
docker compose logs -f chismoso-scheduler     # TopicScheduler
docker compose logs -f chismoso-backup         # Backup sidecar
docker compose logs -f caddy                  # Edge (TLS)
docker compose logs -f redis                  # Redis
```

### All services, last 200 lines each

```bash
docker compose logs --tail=200
```

### Log rotation

The `docker-compose.prod.yml` override configures `json-file` driver with `max-size: 10m` and `max-file: 3`. So each service's log file maxes out at ~30 MB before the oldest is rotated. Total disk usage for logs across all services is capped at ~180 MB.

To override (e.g. keep more history for `app`):

```yaml
# in docker-compose.override.yml (not committed)
services:
  app:
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "10"
```

### Chismoso scheduler log

The TopicScheduler also writes its own log file at `/data/scheduler.log` inside the `app` container (mapped to the `chismoso_data` volume). This is in addition to Docker's stdout logs:

```bash
docker compose exec app tail -f /data/scheduler.log
```

---

## Restarts

### Soft restart (same image, just restart the process)

```bash
docker compose restart app
```

This sends SIGTERM → Next.js graceful shutdown (waits up to 10s for in-flight requests) → SIGKILL if it doesn't exit → fresh start.

### Hard restart (rebuild image + recreate container)

```bash
docker compose up -d --build app
```

Use this when you've changed code (e.g. pulled a new git commit, or edited a config).

### Full stack restart

```bash
docker compose restart
```

Order: `caddy` → `app` → `chismoso-scheduler` → `chismoso-backup` → `redis`. The dependency graph in `docker-compose.yml` (`depends_on: condition: service_healthy`) makes sure they come back up in the right order.

---

## Updates

### Pull a new release tag + redeploy

```bash
cd /opt/chismoso
git fetch --tags
git checkout v1.6.0   # or whatever the new release is
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The build will:
1. Rebuild Next.js (`.next/standalone/server.js`)
2. Rebuild chismoso TypeScript → `chismoso/dist/`
3. Restart `app`, `chismoso-scheduler`, `chismoso-backup` containers with the new image

In-flight investigations are killed by the restart (no graceful drain yet — that's a P1). Pending scheduler work resumes on the next interval.

For the full upgrade procedure (with backup + rollback), see [UPGRADE.md](./UPGRADE.md).

### Update just the env vars (no code change)

```bash
nano .env.production
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps app
```

`--no-deps` skips recreating dependent containers (redis) that didn't change.

---

## Backups

### Automated (cron sidecar)

The `chismoso-backup` service runs `backup-sqlite.sh` every 6h. The script:

1. Calls `sqlite3 /data/chismoso.db ".backup /data/backups/<timestamp>.db"`.
2. If `BACKUP_GPG_RECIPIENT` is set, encrypts the file with GPG.
3. If `BACKUP_S3_BUCKET` is set, uploads to S3 (with SSE-KMS server-side encryption if `AWS_*` creds are set).
4. Cleans up local backups older than 14 days (`find /data/backups -mtime +14 -delete`).

To verify backups are landing:

```bash
docker compose exec chismoso-backup ls -lh /data/backups
```

### Manual backup

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  exec app /opt/scripts/backup-sqlite.sh
```

Use this before a manual upgrade, schema migration, or any risky operation.

### Restore

To restore a backup (assume `/data/backups/2025-01-15T03-00Z.db`):

```bash
# 1. Stop the app so the SQLite file isn't locked
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop app chismoso-scheduler

# 2. Restore
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm \
  --entrypoint sh app \
  -c "cp /data/backups/2025-01-15T03-00Z.db /data/chismoso.db && sqlite3 /data/chismoso.db 'PRAGMA integrity_check;'"

# 3. Restart
docker compose -f docker-compose.yml -f docker-compose.prod.yml start app chismoso-scheduler

# 4. Verify
curl -fsS https://<domain>/api/doctor | jq .summary
```

If the backup was GPG-encrypted, decrypt first:

```bash
gpg --decrypt /data/backups/2025-01-15T03-00Z.db.gpg > /tmp/restore.db
docker cp /tmp/restore.db chismoso-app:/data/chismoso.db
```

### Backup test (weekly)

Run a restore into a throwaway container, run the doctor, throw it away:

```bash
# Pick the most recent backup
LATEST=$(docker compose run --rm --entrypoint sh app -c 'ls -1t /data/backups/*.db | head -1')

# Restore into a fresh container pointing at a temp DB
docker run --rm -v chismoso_chismoso_backups:/baks:ro \
  -e CHISMOSO_DB_PATH=/tmp/test.db \
  --entrypoint sh chismoso:local \
  -c "cp /baks/$(basename $LATEST) /tmp/test.db && node chismoso/dist/cli.js doctor"
```

If `overall_status` is `OK`, your backups are good.

---

## Scaling

### Vertical (more CPU/RAM for the existing instance)

Edit `docker-compose.prod.yml`:

```yaml
services:
  app:
    deploy:
      resources:
        limits:
          cpus: "4.0"          # was 2.0
          memory: 2G           # was 1G
```

Then:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps app
```

### Horizontal (multiple `app` instances)

CHISMOSO V1.5 ships with **SQLite + in-memory rate-limit + cache**, which means multiple `app` instances will:
- Have **inconsistent state** (each writes to its own SQLite file — no shared writer).
- **Evade the rate-limit** (each process has its own `Map<ip, count>`).

To scale horizontally you need to introduce (each step is independent):

1. **External Postgres for the chismoso store** — the V1.5 stack shipped with a
   Postgres container that was never wired in (Prisma schema was a placeholder
   skeleton removed in Task R2-IMP-OPS). To re-introduce it:
   - Bring up a Postgres 16 instance (managed RDS, Cloud SQL, or `postgres:16-alpine` on a dedicated host — *not* on the app box, to avoid single-point-of-failure).
   - Migrate `chismoso/src/db.ts` from `better-sqlite3` to `pg` (or `pglite`) — needs an abstraction layer (`IStore` interface with `SQLiteStore` + `PostgresStore` implementations).
   - Run `chismoso/dist/cli.js doctor --fix` against the new Postgres to create tables.
2. **Redis for rate-limit + cache** (Redis is already in the stack, just unused — migrate `src/lib/rate-limit.ts` to `@upstash/ratelimit` + `ioredis`, `src/lib/cache.ts` to `ioredis` or `keyv` with a Redis adapter).
3. **Sticky-session-free load balancer** (sessions are JWT-in-cookie, so any LB strategy works: round-robin, least-connections, IP-hash — all fine).

Until those land, scale vertically. The `medium` profile (4 vCPU / 8 GB) supports ~15 concurrent investigations, which is enough for most teams.

> **Baseline**: see [§Load testing](#load-testing) below for k6 scripts that
> measure where the vertical ceiling actually sits on your hardware.

### Adding a mesh agent

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  node chismoso/dist/cli.js mesh subscribe \
    --agent="regional-bot-01" \
    --url="https://my-remote-agent.example.com/hooks/chismoso" \
    --secret="<shared-secret>"
```

The mesh config is persisted in the SQLite DB, so it survives restarts. Verify:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  node chismoso/dist/cli.js mesh list
```

---

## User + token management

### Generate a new token

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  node chismoso/dist/cli.js auth token
```

Append the **hash** to `CHISMOSO_AUTH_TOKENS` (comma-separated) in `.env.production`, then:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps app
```

### Revoke a token

Remove its hash from `CHISMOSO_AUTH_TOKENS` in `.env.production` and restart `app`. The token is immediately invalid on the next request.

### Rotate all tokens

```bash
# 1. Generate N new tokens
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  node chismoso/dist/cli.js auth token   # repeat N times

# 2. Replace the entire CHISMOSO_AUTH_TOKENS line in .env.production with the new hashes
nano .env.production

# 3. Restart app
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps app

# 4. Distribute new plaintext tokens to clients
# 5. (Optional) Audit your client logs for who's still using old tokens
```

---

## Health + readiness

### `/api/livez` — ultra-light liveness

```bash
curl -fsS https://<domain>/api/livez
# {"status":"ok","timestamp":"..."}
```

Returns 200 if the Next.js process is accepting requests. No DB touch (returns immediately). Use for the Docker `HEALTHCHECK` and load balancer liveness probes.

### `/api/health` — DB-aware health

```bash
curl -fsS https://<domain>/api/health | jq
# {
#   "status": "ok",   # or "degraded" if DB read fails
#   "version": "1.5.0",
#   "timestamp": "...",
#   "db": "reachable"
# }
```

Returns 200 + `status=ok` if both Next.js + chismoso SQLite are reachable. Use this for **readiness** probes (Kubernetes, ALB target group).

### `/api/doctor` — 14-subsystem readiness

```bash
curl -fsS https://<domain>/api/doctor | jq .summary
# {
#   "ok": 12,
#   "degraded": 1,
#   "fail": 1,
#   "unknown": 0
# }
```

Each check returns a status. Investigate any `fail` or `degraded`. To get the detail:

```bash
curl -fsS https://<domain>/api/doctor | jq '.checks[] | select(.status != "OK")'
```

To auto-apply safe deterministic fixes (e.g. create missing tables):

```bash
curl -X POST -H "X-Chismoso-Agent: <token>" https://<domain>/api/doctor?fix=true | jq .auto_fixes_applied
```

---

## Monitoring

### Sentry (optional)

If `SENTRY_DSN` is set in `.env.production`, unhandled errors in the Next.js process are reported to Sentry. (Source map upload is a planned P1.)

### Status page

Recommended external status pages:
- [Better Uptime](https://betteruptime.com) — has a free tier + on-call scheduling.
- [Instatus](https://instatus.com) — simpler, faster status page.

Configure them to ping `https://<domain>/api/livez` every 60s. Alert on:
- 3 consecutive non-200 responses (within 3 min).
- Response time >5s for 5 consecutive checks (within 5 min).

### Logs aggregation (optional)

For multi-server deployments, ship logs to a central place:
- [Loki](https://loki.grafana.com) + [Grafana](https://grafana.com) (self-hosted, free).
- [Datadog](https://www.datadoghq.com) (paid — log shipping + metrics + tracing).

The simplest path: tail Docker logs into Loki via [promtail](https://grafana.com/docs/loki/latest/clients/promtail/):

```yaml
# /etc/promtail/config.yml
positions:
  filename: /tmp/positions.yaml
clients:
  - url: http://loki:3100/loki/api/v1/push
scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        filters:
          - containers:
              - chismoso-app
              - chismoso-scheduler
              - chismoso-caddy
    relabel_configs:
      - source_labels: [__meta_docker_container_name]
        target_label: container
```

---

## Disaster recovery

### Scenario: server crash (process killed, host rebooted)

1. Verify the host is back up: `uptime` (should print a recent boot time).
2. `docker compose ps` — all containers should be `Up (healthy)`. If not, `docker compose up -d`.
3. `curl -fsS https://<domain>/api/doctor | jq .summary` — confirm no subsystem is `fail`.
4. If a container is stuck in `Restarting` state, `docker compose logs --tail=200 <service>` to see why.

### Scenario: bad deploy (app is broken after upgrade)

```bash
# 1. Stop the broken app
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop app chismoso-scheduler

# 2. Roll back to the previous image tag
docker tag ghcr.io/albra8/agente-chismoso:<previous-tag> chismoso:local

# 3. Restart with the previous image
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps app chismoso-scheduler

# 4. Verify
curl -fsS https://<domain>/api/health | jq
curl -fsS https://<domain>/api/doctor | jq .summary
```

Full rollback procedure (with DB restore if needed): see [UPGRADE.md](./UPGRADE.md).

### Scenario: SQLite corruption

Symptoms: `/api/health` returns `status=degraded` with `db: "error: database disk image is malformed"`.

```bash
# 1. Stop writers
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop app chismoso-scheduler chismoso-backup

# 2. Try chismoso doctor's --fix flag (safe deterministic repairs)
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm \
  --entrypoint node app chismoso/dist/cli.js doctor --fix

# 3. If --fix doesn't work, restore from backup (see §Backups → Restore)

# 4. If no backup, dump what's recoverable:
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm \
  --entrypoint sh app \
  -c "sqlite3 /data/chismoso.db '.dump' > /data/recoverable-dump.sql && wc -l /data/recoverable-dump.sql"

# Then create a fresh DB from the dump:
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm \
  --entrypoint sh app \
  -c "mv /data/chismoso.db /data/chismoso.db.corrupt && sqlite3 /data/chismoso.db < /data/recoverable-dump.sql"

# 5. Verify
docker compose -f docker-compose.yml -f docker-compose.prod.yml start app
curl -fsS https://<domain>/api/doctor | jq .summary
```

### Scenario: LLM provider outage (Z.ai down)

Symptoms: `/api/investigate/stream` requests hang or return 5xx; the chismoso-scheduler logs show repeated `react_iter_llm_error`.

The orchestrator has a deterministic fallback (see `chismoso/src/orchestrator/planner.ts`) that produces a degraded report without LLM calls. Investigations will still complete but with lower signal quality.

To verify the fallback works:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  node chismoso/dist/cli.js investigate "test objective" --no-mcp
# Should complete (slowly) with a degraded but non-empty report.
```

Once Z.ai recovers, the next investigation cycle will pick up automatically.

### Scenario: Redis down (rate-limit + cache unavailable)

```bash
docker compose logs --tail=200 redis
# Most common: disk full → see docker system df
docker system df
docker system prune -af   # clears unused images + stopped containers
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart redis
```

The `app` container's in-memory rate-limiter (`src/lib/rate-limit.ts`) still
works without Redis — single-instance deploys are unaffected. Only multi-
instance deploys that depend on Redis-backed distributed rate-limiting need
to wait for Redis to come back.

---

## Load testing

CHISMOSO V1.5 ships with [k6](https://k6.io) load-test scripts in
`tests/load/`. Use them to (a) baseline your vertical ceiling before you
need it, (b) catch performance regressions across releases, and (c) decide
when it's time to move from vertical to horizontal scaling.

### Install k6

```bash
# macOS
brew install k6

# Linux (Debian/Ubuntu)
sudo apt-key adv --keyserver hkp://keyserver.ubuntu.com --recv-keys C5AD17F7
echo "deb https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt update && sudo apt install k6

# Or via Docker (no install needed):
alias k6='docker run --rm -i --network host grafana/k6 run -'
```

### Run a load test

The two baseline scripts target the two most expensive endpoints:

```bash
# 1. /api/investigate — the heavy investigation path (spawns chismoso CLI subprocess)
k6 run tests/load/k6-investigate.js

# 2. /api/chat — the ReAct agent loop (multiple Z.ai LLM calls per request)
k6 run tests/load/k6-chat.js
```

Both scripts ramp from 0 → 10 users over 2 minutes, hold for 1 minute,
then ramp back down. Default thresholds:
- `http_req_duration`: p(95) < 10s (investigations can legitimately take
  several seconds — that's an LLM-driven path)
- `http_req_failed`: < 5% (the only "failure" we accept is 429 — the rate
  limiter doing its job when concurrency exceeds capacity)

### Pointing at staging

By default the scripts hit `http://localhost:3000`. To target staging or prod:

```bash
K6_BASE_URL=https://staging.chismoso.example.com \
K6_AUTH_TOKEN=chsm_<agent-token> \
  k6 run tests/load/k6-investigate.js

K6_BASE_URL=https://chismoso.example.com \
K6_AUTH_TOKEN=chsm_<agent-token> \
  k6 run tests/load/k6-chat.js
```

Never load-test production without (a) warning the on-call, (b) lowering
the stages to e.g. 2 → 5 → 2 users, and (c) watching `/api/metrics` for
error-budget burn.

### Capturing a baseline

The first time you run the load test on a healthy stack, save the output
so you can spot regressions later:

```bash
k6 run tests/load/k6-investigate.js | tee tests/load/baselines/$(date -u +%Y-%m-%d)-investigate.txt
k6 run tests/load/k6-chat.js | tee tests/load/baselines/$(date -u +%Y-%m-%d)-chat.txt
```

Key numbers to track per release:
- `http_reqs` (total throughput) — should grow if vertical scaling worked.
- `http_req_duration{p(95)}` — should not regress beyond ±20%.
- `vus_max` (peak virtual users) — should match your `stages[].target`.
- `iteration_duration{p(95)}` — true per-request cost including sleep.

### CI integration (optional)

For per-PR smoke-load tests, add a job to `.github/workflows/ci.yml`:

```yaml
load-smoke:
  needs: build
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: grafana/k6-action@v0.3.1
      with:
        filename: tests/load/k6-chat.js
        flags: --env K6_BASE_URL=http://localhost:3000 --env SMOKE=1
```

Keep CI runs short (≤30s) and use a `SMOKE` env flag in the script to
switch to a 1-user / 5-second profile when set.

---

## Common operations checklist

### Daily

- [ ] Check `docker compose ps` — all services `Up (healthy)`.
- [ ] Check `docker compose logs --tail=50 app` for any unhandled errors.
- [ ] Spot-check `curl -fsS https://<domain>/api/doctor | jq .summary` — `fail` count should be 0.

### Weekly

- [ ] Run a backup restore test (see §Backups → Backup test).
- [ ] Review the [security.yml](../.github/workflows/security.yml) workflow run — open any new high-severity findings.
- [ ] Check disk: `df -h` and `docker system df`. Prune if disk usage >70%.
- [ ] Check cert expiry: `echo | openssl s_client -connect <domain>:443 2>/dev/null | openssl x509 -noout -dates`. Should be >14 days from expiry (Caddy auto-renews at 30 days, so seeing <30 days means auto-renew failed).

### Monthly

- [ ] Rotate auth tokens (optional — paranoia setting).
- [ ] Review access: who has SSH access to the server, who has `chismoso:local` image pull access, who has GHCR write access.
- [ ] Update dependencies: `cd /opt/chismoso && bun update` then `docker compose up -d --build`. Run the [CI pipeline](../.github/workflows/ci.yml) on a PR before merging.

### Quarterly

- [ ] DR drill: simulate `docker compose stop app` during business hours, verify recovery time + the alerting fired.
- [ ] Cost review: `docker stats` average CPU/memory, Cloudflare/Let's Encrypt usage, GHCR storage.
- [ ] Capacity review: are you approaching the `medium` profile limits? Plan an upgrade.
