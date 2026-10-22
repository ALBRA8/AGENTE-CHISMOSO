# CHISMOSO V1.5 — On-call Runbook

This runbook documents the most common production incidents and the
playbook for each. The goal is **time-to-mitigate** — the on-call
should be able to follow these steps mechanically and restore service
without having to debug from scratch.

For real-time diagnosis, the canonical surfaces are:

- `GET /api/health` — lightweight liveness (DB reachable?)
- `GET /api/livez` — process up?
- `GET /api/readyz` — process ready to serve (DB + LLM + env)?
- `GET /api/doctor` — 14-subsystem deep health
- `GET /api/version` — current build (git_commit)
- `GET /api/metrics` — Prometheus exposition (RPS, latency, errors, …)
- `GET /api/audit-log` — who did what, when, from where

For deeper analysis, see `docs/ALERTING.md` for the PromQL/LogQL
queries backing each alert below.

---

## Incident template

Each incident below follows this structure:

1. **Symptoms** — what the operator / user sees.
2. **Diagnosis** — how to confirm the root cause.
3. **Fix procedure** — the steps to mitigate.
4. **Escalation** — who to page if the fix doesn't work.

---

## 1. DB loss / SQLite corruption

### Symptoms

- `/api/health` returns `{ status: 'degraded', db: 'error: ...' }`
  (still HTTP 200 — see category #20 in the audit).
- `/api/readyz` returns `503` with `checks: [{ name: 'db', ok: false, ... }]`.
- Dashboard routes (`/api/alerts`, `/api/anomalies`, `/api/topics`)
  return `500` with `error: 'no such table: alerts'` or
  `SQLITE_CORRUPT`.
- `/api/doctor` returns `overall_status: FAIL` on the `database` check.

### Diagnosis

1. `curl /api/readyz` — confirm `checks[0].name === 'db'` is failing.
2. SSH into the host, run `node /home/z/my-project/chismoso/dist/cli.js
   doctor --check=database --json`. The doctor prints the exact
   `PRAGMA integrity_check` result.
3. Inspect the DB file: `ls -la /home/z/my-project/chismoso/data/`.
   If `chismoso.db` is much smaller than the last backup, you have
   truncation. If `chismoso.db-wal` is unbounded (>1 GB), the WAL
   checkpoint stalled.
4. If `integrity_check` returns anything other than `ok`, the file is
   corrupt.

### Fix procedure

1. Stop the Next.js process: `systemctl stop chismoso` (or
   `pkill -TERM -f 'next dev'` in dev).
2. Stop the chismoso CLI scheduler if running (it shares the DB).
3. Restore from backup:
   ```bash
   cp /var/backups/chismoso/chismoso.db.latest.gz .
   gunzip chismoso.db.latest.gz
   mv chismoso.db.latest chismoso/data/chismoso.db
   ```
   The backup runs hourly via the systemd timer
   `chismoso-backup.timer` (cron alternative: see
   `docs/ALERTING.md` rule `backup_job_failure`).
4. Reset the WAL: `rm chismoso/data/chismoso.db-wal
   chismoso/data/chismoso.db-shm`.
5. Start the process: `systemctl start chismoso`.
6. Smoke test: `curl /api/health` should return `db: 'reachable'`.

### Escalation

- DBA / platform team if the corruption is reproducible (likely a
  disk fault or kernel bug — the backup itself may be corrupt).
- Storage team if `integrity_check` reports
  `disk I/O error` (likely a failing disk).

---

## 2. LLM provider outage

### Symptoms

- `investigate` requests take 30–60s and return
  `status: 'FAILED'` with `errors: ['llm_rate_limited']`.
- `/api/readyz` returns `503` with `checks: [{ name: 'llm', ok: false,
  reason: 'HTTP 429' }]` (or `reason: 'fetch failed'`).
- Prometheus `chismoso_llm_calls_total{status="failed"}` rate spikes
  from ~0 to >1/s.
- Circuit breaker (if configured) opens — see
  `chismoso_llm_calls_total{circuit_state="open"}`.

### Diagnosis

1. `curl /api/readyz` — confirm `checks[2].name === 'llm'` is
   failing. The cached result is 60s old; for a fresh probe, restart
   the Next.js process or wait 60s.
2. From the host: `curl -I $LLM_API_BASE` — if the provider is down,
  you'll get a connection error or 5xx.
3. Check the provider status page (Z.AI: https://status.z.ai).
4. `node /home/z/my-project/chismoso/dist/cli.js doctor --check=providers`
   — surfaces per-provider `success_rate` from the `provider_quality`
   table.

### Fix procedure

1. The circuit breaker in `chismoso/src/circuit-breaker.ts` should
   already be in `OPEN` state, returning immediately instead of
   retrying for 30s. Verify via `chismoso_circuit_breaker_state{breaker="llm"} == 2`.
2. If the outage is brief (<5 min): no action needed. The breaker
   transitions to `HALF_OPEN` after the cooldown and probes with one
   request; if it succeeds, the breaker closes.
3. If the outage is extended (>15 min):
   - Set the env var `CHISMOSO_LLM_FALLBACK_PROVIDER=ollama` (if a
     local Ollama fallback is configured).
   - Or, gracefully degrade by setting
     `CHISMOSO_INVESTIGATE_DISABLED=true` (returns 503 from
     `/api/investigate` with a clear "LLM unavailable" message).
4. Once the provider recovers: the breaker closes automatically. No
   manual action needed.

### Escalation

- LLM provider support (open a ticket — include the trace_id from a
  failing request, visible in `/api/audit-log?action=investigate`).
- Eng manager if the outage exceeds the SLO error budget (see
  `docs/ALERTING.md` § "SLO / error budget").

---

## 3. Process crash / OOM

### Symptoms

- `/api/livez` returns connection refused (process not running).
- `/api/health` returns connection refused.
- systemd reports `Main process exited, status=137` (SIGKILL — likely
  OOM-killer).
- Prometheus `chismoso_active_investigations` drops to 0 mid-run.

### Diagnosis

1. `systemctl status chismoso` — recent restarts visible in
   `Active: active (running) (exited) ... restarts: N`.
2. `journalctl -u chismoso --since '1 hour ago'` — last log lines
   before the crash. An OOM-kill leaves `Killed` in the journal.
3. `dmesg | grep -i 'killed process'` — kernel OOM-killer log entry
   includes the RSS at kill time.
4. Prometheus: `chismoso_process_resident_memory_bytes` 60s before
  the crash — was RSS climbing?

### Fix procedure

1. systemd auto-restarts the process (`Restart=on-failure` in the
   unit file). If it's looping, increase the restart delay:
   ```bash
   systemctl edit chismoso
   # add:
   # [Service]
   # RestartSec=10
   # StartLimitBurst=5
   # StartLimitIntervalSec=60
   ```
2. If RSS is genuinely climbing (leak): capture a heap snapshot
   before the next restart by setting
   `CHISMOSO_HEAPDUMP_ON_SIGNAL=1` and sending `SIGUSR2` to the
   process. The snapshot lands in `/var/log/chismoso/heapdump-*.heapsnapshot`.
3. Temporary relief: cap concurrency by setting
   `CHISMOSO_MAX_CONCURRENT_INVESTIGATIONS=1` (default 3).
4. Long-term: profile the snapshot in Chrome DevTools → Memory tab.
   Look for retained `signal_embeddings`, Prisma `Map` caches, or
   chismoso CLI subprocess stderr buffers.

### Escalation

- Platform team if RSS climbs past 2 GB (the host has 4 GB; the
  Next.js process should sit at ~200-400 MB).
- Memory-profile-aware engineer if a heap snapshot points to a
  chismoso subsystem (the snapshot alone won't say which route caused
  the retention).

---

## 4. Bad deploy / regression

### Symptoms

- 5xx rate on `/api/*` jumps from ~0% to >10% immediately after a
  deploy.
- Sentry gets a flood of `TypeError: Cannot read properties of
  undefined` events with the new release tag.
- `/api/version` shows the new `git_commit` hash.
- All routes 500 with a Turbopack SWC parse error (cascading failure
  mode — see IMP-PROD-OBS worklog for the historic example).

### Diagnosis

1. `curl /api/version` — confirm the `git_commit` matches the deploy.
2. `curl /api/health` — if it returns 500 with a Turbopack parse
   error in the body, this is the SWC parse-error cascade.
3. `journalctl -u chismoso --since '5 min ago' | grep -i error` —
   the compilation error is logged at startup.
4. Sentry: filter by `release: <new git_commit>` — group by
   `exception.type` to see the dominant error.

### Fix procedure

1. **Rollback immediately** — don't try to fix forward:
   ```bash
   cd /home/z/my-project
   git checkout <previous_release_tag>
   bun run build  # rebuild the standalone server
   systemctl restart chismoso
   ```
2. Verify: `curl /api/version` shows the previous `git_commit`.
3. Verify: `curl /api/health` returns `200` with
   `db: 'reachable'`.
4. Investigate the broken build in a staging environment, not in
   production. The most common cause is an ESM `export { X }` form
   that SWC accepts but Turbopack rejects (see IMP-PROD-OBS worklog
   for the historic fix: use `export { X } from 'path'` instead).

### Escalation

- Release manager (the one who shipped the deploy) — they know what
  changed.
- Frontend infra engineer if the root cause is a Turbopack/SWC
  mismatch (rare, but historically has cascaded to ALL routes).

---

## 5. Memory leak (slow RSS growth)

### Symptoms

- `chismoso_process_resident_memory_bytes` climbs monotonically over
  hours/days.
- No single request triggers it — the growth is steady state.
- Eventually the process hits the OOM ceiling and restarts (see
  incident #3).

### Diagnosis

1. Prometheus: `rate(chismoso_process_resident_memory_bytes[1h])` —
   if this is consistently >0, you have a leak.
2. Compare against `rate(chismoso_http_requests_total[1h])` — if the
   leak rate scales with RPS, the leak is per-request (likely a
   closure capturing a large object).
3. `process.memoryUsage()` via `/api/metrics` — compare `heapUsed`
   vs `rss`. If `rss` grows but `heapUsed` is stable, the leak is in
   a Buffer / Array not tracked by V8 (e.g. a chismoso CLI subprocess
   stderr buffer).
4. `lsof -p <pid> | wc -l` — file descriptor leak.

### Fix procedure

1. Capture a heap snapshot for offline analysis:
   ```bash
   kill -USR2 $(pidof node)
   # snapshot lands at /var/log/chismoso/heapdump-*.heapsnapshot
   ```
2. Schedule a restart to buy time: `systemctl restart chismoso`
   (restart clears the leak; the snapshot survives in
   `/var/log/chismoso/`).
3. Open the snapshot in Chrome DevTools (Memory tab → Load). Group
   by "Retained Size" — the largest retainers are the leak.

### Escalation

- Engineer who owns the subsystem with the largest retainer (see
  audit `PROD-AUDIT-OBS` §17 for the suspected culprits:
  `rate-limit.ts` Map, `chat-session.ts` session store, or
  `lastSeenAnomalyIds` Set).

---

## 6. Disk full

### Symptoms

- `df -h /var/log/chismoso` shows `Use%: 99%`.
- New write attempts fail with `ENOSPC` in the journal.
- `/api/investigate` returns 500 with `error: 'write EPIPE'` (the
  chismoso CLI couldn't write its report file).
- SQLite writes start returning `SQLITE_FULL`.

### Diagnosis

1. `df -h` — confirm which mount is full.
2. `du -sh /var/log/chismoso/*` — find the largest offender.
   Usual culprits: `server.log`, `scheduler.log`, `dev.log`,
   `heapdump-*.heapsnapshot`.
3. `du -sh /home/z/my-project/download/chismoso` — old investigation
   reports accumulate here. Each is ~50-500 KB.

### Fix procedure

1. Truncate the live log files (don't `rm` — the process has them
   open):
   ```bash
   truncate -s 0 /var/log/chismoso/server.log
   truncate -s 0 /var/log/chismoso/scheduler.log
   ```
   (`logrotate.d/chismoso` does this automatically — see P0-9 in the
   audit; this runbook is for when logrotate itself failed.)
2. Delete old investigation reports:
   ```bash
   find /home/z/my-project/download/chismoso -name 'report-*.json' \
     -mtime +30 -delete
   find /home/z/my-project/download/chismoso -name 'report-*.md' \
     -mtime +30 -delete
   ```
3. Delete heap snapshots older than 7 days:
   ```bash
   find /var/log/chismoso -name 'heapdump-*.heapsnapshot' \
     -mtime +7 -delete
   ```
4. If still full, extend the disk: `lvextend -l +100%FREE
   /dev/mapper/vg-chismoso` (or contact platform team for cloud
   volumes).

### Escalation

- Platform team if the disk is genuinely too small (the
  `/var/log/chismoso` mount should be at least 20 GB for a 30-day
  retention at the current RPS).
- logrotate config owner if the rotation failed silently (check
  `journalctl -u logrotate`).

---

## 7. High error rate (5xx > 1%)

### Symptoms

- Prometheus alert `high_5xx_rate` fires (see `docs/ALERTING.md`).
- Sentry shows a flood of events with the same stack trace.

### Diagnosis

1. Identify the dominant error: `Sentry → Issues → sort by
   frequency`. Take the top issue's stack trace.
2. Filter Prometheus: `sum by (route) (rate(chismoso_http_requests_total{status=~"5.."}[5m]))`
   — which route is burning?
3. Cross-reference with the deploy log: did the error rate jump at
   the time of the last deploy? (See `/api/version` for the current
   build time.)
4. `curl /api/audit-log?action=investigate` — recent investigations
   show the objective + geography that triggered the failing path.

### Fix procedure

1. If the error is from a recent deploy → rollback (see incident #4).
2. If the error is from a specific user-supplied input (e.g. an
   objective with a 50 KB string), add a stricter validation in
   `src/lib/validation.ts`. The audit log entry will tell you which
   user/IP to follow up with.
3. If the error is a chismoso CLI subprocess crash (e.g. SIGSEGV),
   look at the last 200 lines of `result.stderr` captured in the API
   response payload (`payload.log`).
4. Capture a trace via `curl /api/trace` — ExecutionTrace shows
   `duration_ms`, `tools_used`, `errors` for the failing run.

### Escalation

- Engineer who owns the route identified in step 2.
- LLM provider support if the stack trace ends in a fetch to the LLM
  endpoint.

---

## 8. SQLite DB lock contention (SQLITE_BUSY)

### Symptoms

- `/api/investigate` returns 500 with `error: 'SQLITE_BUSY'` in the
  payload.
- The doctor's `database` check passes (`integrity_check = ok`).
- Prometheus: `rate(chismoso_db_connections[1m])` is steady, but
  `chismoso_http_request_duration_seconds{route="/api/investigate"}_p95`
  spikes > 30s.

### Diagnosis

1. Check `busy_timeout`: `sqlite3 /home/z/my-project/chismoso/data/chismoso.db
   'PRAGMA busy_timeout'` — should return `5000` (5s). If 0, the
   writable singleton lost its pragma.
2. List in-flight transactions:
   ```sql
   SELECT * FROM pragma_database_list;
   -- And:
   SELECT * FROM chismoso_db_locks;  -- (a custom view we'd add in V2)
   ```
   In V1, the only signal is the `SQLITE_BUSY` error itself.
3. Count concurrent writers: `ps aux | grep 'chismoso.*investigate'
   | wc -l` — if >3, you've exceeded the SQLite safe-write ceiling.

### Fix procedure

1. Reduce concurrency: `export CHISMOSO_MAX_CONCURRENT_INVESTIGATIONS=1`
   and `systemctl restart chismoso`.
2. Kill long-running CLI subprocesses:
   ```bash
   pkill -TERM -f 'chismoso.*investigate'
   ```
   (The graceful-shutdown hook will clean up the parent's file
   descriptors.)
3. Check for an orphaned writer: `fuser
   /home/z/my-project/chismoso/data/chismoso.db` lists PIDs holding
   the file. Kill any process that shouldn't be there.
4. If the lock contention is persistent, the only long-term fix is
   moving to Postgres. SQLite is single-writer; >3 concurrent
   writers will always contend.

### Escalation

- Platform team to provision Postgres if this incident recurs >2x
  per month.
- DBA if the lock is held by a process not in the chismoso group
  (some other service is writing to the DB — that's a misconfig).

---

## Reference: standard mitigation order

When paged for an unknown incident:

1. `curl /api/livez` → process alive?
2. `curl /api/readyz` → DB + LLM + env OK?
3. `curl /api/doctor` → 14-subsystem deep health.
4. `curl /api/version` → which build is running?
5. `curl /api/metrics` → RPS, latency, error rate.
6. `journalctl -u chismoso --since '15 min ago'` → recent log lines.
7. Sentry → top issue by frequency.

In ~80% of incidents, step 1-3 already pinpoints the broken subsystem,
and the runbook section above walks through the fix.

For anything not covered here, file an incident report and add a new
section. This document is a living reference — every post-incident
review should add a section for any incident that took >15 min to
diagnose.
