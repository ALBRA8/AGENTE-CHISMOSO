# CHISMOSO V1.5 — Alerting rules & SLO/SLI definitions

This document defines the **SLOs** we hold ourselves to, the **SLIs**
that measure them, the **alert rules** that page the on-call when an
SLI is burning through the error budget, and the **runbook** cross-
references for each rule.

Every alert below includes:

- The **PromQL** query (or **LogQL** for log-based alerts).
- The **threshold** + **for** duration.
- The **severity** (`P1` = page, `P2` = ticket, `P3` = dashboard).
- A link to the relevant runbook section in `docs/RUNBOOK.md`.

The alerts assume a Prometheus + Alertmanager stack with the
Prometheus scraper hitting `/api/metrics` every 15s. For log-based
alerts, assume a Loki + Grafana stack ingesting the JSON lines from
`/var/log/chismoso/server.log`.

---

## SLOs (service-level objectives)

CHISMOSO V1.5 commits to the following SLOs over a rolling 30-day
window:

| # | SLO | Target | Window |
|---|-----|--------|--------|
| 1 | **Availability** | 99.5% | 30 days |
| 2 | **API latency** | p95 < 5s on `/api/investigate` | 30 days |
| 3 | **Error rate** | < 1% 5xx on `/api/*` | 30 days |
| 4 | **Investigation success rate** | ≥ 95% of started investigations complete successfully | 30 days |
| 5 | **Doctor OK rate** | `overall_status == OK` ≥ 99% of probes | 30 days |

### Error budget

SLO #1 (99.5% availability) yields an error budget of **0.5% of
monthly requests** = ~3.6 hours of downtime per 30 days (assuming
constant traffic).

| Traffic (RPS) | Monthly requests | Error budget (requests) | Wall-clock downtime |
|---------------|------------------|--------------------------|---------------------|
| 1             | 2.6M             | 13,000                   | 3.6 h               |
| 10            | 26M              | 130,000                  | 3.6 h               |
| 100           | 260M             | 1,300,000                | 3.6 h               |

The wall-clock budget is constant because availability = "fraction of
time the service was healthy", independent of RPS.

**Burn-rate alert**: alert when the budget burn rate exceeds 4x the
ideal over a 1-hour window (fires at ~14 days of budget remaining).
See `slo_burn_rate_fast` and `slo_burn_rate_slow` below.

---

## SLIs (service-level indicators)

These are the time-series we compute to measure the SLOs. All are
exposed via `/api/metrics` (Prometheus format).

| SLI | Metric | Aggregation | Matches SLO |
|-----|--------|-------------|-------------|
| 5xx rate | `chismoso_http_requests_total{status=~"5.."}` | `rate(...[5m]) / rate(chismoso_http_requests_total[5m])` | #3 |
| p95 latency | `chismoso_http_request_duration_seconds` | `histogram_quantile(0.95, rate(...[5m]))` | #2 |
| `/api/readyz` success rate | synthetic probe (see § "Synthetic monitoring") | `1 - rate(probe_failed[5m])` | #1 |
| Investigation success rate | `chismoso_investigations_total{status="COMPLETED"}` / `chismoso_investigations_total` | `rate(success[5m]) / rate(started[5m])` | #4 |
| Doctor OK rate | synthetic probe `GET /api/doctor` | `rate(probe_overall_ok[5m])` | #5 |

---

## Alert rules

Each rule is rendered as a Prometheus alerting rule YAML block. Drop
into `/etc/prometheus/rules/chismoso.yml` and reload Prometheus.

```yaml
groups:
  - name: chismoso
    interval: 30s
    rules:
```

### 1. high_5xx_rate (P1, page)

Fires when 5xx responses exceed 1% of total over 5 min. This is the
core availability SLO (#3).

```yaml
      - alert: high_5xx_rate
        expr: |
          (
            sum(rate(chismoso_http_requests_total{status=~"5.."}[5m]))
            /
            clamp_min(sum(rate(chismoso_http_requests_total[5m])), 0.001)
          ) > 0.01
        for: 5m
        labels:
          severity: P1
          team: chismoso
        annotations:
          summary: "5xx rate > 1% for 5 min"
          description: "5xx responses are {{ $value | humanizePercentage }} of total over the last 5 min."
          runbook: "docs/RUNBOOK.md#7-high-error-rate-5xx--1"
```

### 2. high_p95_latency (P1, page)

Fires when the p95 latency on `/api/investigate` exceeds 5s for 5 min.

```yaml
      - alert: high_p95_latency
        expr: |
          histogram_quantile(
            0.95,
            sum by (le) (
              rate(chismoso_http_request_duration_seconds_bucket{route="/api/investigate"}[5m])
            )
          ) > 5
        for: 5m
        labels:
          severity: P1
          team: chismoso
        annotations:
          summary: "p95 latency on /api/investigate > 5s"
          description: "p95 = {{ $value }}s over the last 5 min (SLO: 5s)."
          runbook: "docs/RUNBOOK.md#8-sqlite-db-lock-contention-sqlite_busy"
```

### 3. db_connections_saturated (P2, ticket)

Fires when the active DB connection gauge hits 10 (well above the
expected 1-2 for a SQLite singleton). This is a leading indicator of
connection leaks.

```yaml
      - alert: db_connections_saturated
        expr: chismoso_db_connections > 10
        for: 5m
        labels:
          severity: P2
          team: chismoso
        annotations:
          summary: "DB connection count > 10"
          description: "{{ $value }} connections open (expected 1-2)."
          runbook: "docs/RUNBOOK.md#5-memory-leak-slow-rss-growth"
```

### 4. circuit_breaker_open (P1, page)

Fires when the LLM circuit breaker is in `OPEN` state (value 2) for
> 60s. This means the LLM provider is unreachable AND we've already
trip-failed 50% of recent calls.

```yaml
      - alert: circuit_breaker_open
        expr: chismoso_circuit_breaker_state{breaker="llm"} == 2
        for: 60s
        labels:
          severity: P1
          team: chismoso
        annotations:
          summary: "LLM circuit breaker OPEN for > 60s"
          description: "LLM provider is unreachable; investigations are failing fast."
          runbook: "docs/RUNBOOK.md#2-llm-provider-outage"
```

### 5. readyz_failing (P1, page)

Fires when `/api/readyz` returns 503 for > 2 min. The load balancer
should already have stopped routing traffic, but this catches the
case where the readiness probe isn't wired into the LB.

```yaml
      - alert: readyz_failing
        expr: |
          chismoso_readyz_probe_success == 0
        for: 2m
        labels:
          severity: P1
          team: chismoso
        annotations:
          summary: "/api/readyz returning 503 for > 2 min"
          description: "Process is alive (livez OK) but not ready to serve."
          runbook: "docs/RUNBOOK.md#1-db-loss--sqlite-corruption"
```

(`chismoso_readyz_probe_success` is emitted by the synthetic probe
— see § "Synthetic monitoring" below.)

### 6. backup_job_failure (P2, ticket)

Fires when the hourly DB backup job hasn't succeeded in 90 min. The
backup is the only defense against DB corruption (incident #1 in the
runbook) — a missing backup is a P2 because it doesn't break the
user-facing SLO, but it removes the safety net.

```yaml
      - alert: backup_job_failure
        expr: |
          time() - chismoso_backup_job_last_success_timestamp_seconds > 5400
        for: 5m
        labels:
          severity: P2
          team: chismoso
        annotations:
          summary: "DB backup job hasn't succeeded in > 90 min"
          description: "Last successful backup: {{ $value | humanizeDuration }} ago."
          runbook: "docs/RUNBOOK.md#1-db-loss--sqlite-corruption"
```

(Implement by having the backup cron emit
`chismoso_backup_job_last_success_timestamp_seconds` via a textfile
collector — see `node_exporter --collector.textfile`.)

### 7. disk_usage_high (P2, ticket)

Fires when the disk hosting `/var/log/chismoso` exceeds 80%.
Disk-full is incident #6 in the runbook and takes the whole process
down; this is the leading indicator.

```yaml
      - alert: disk_usage_high
        expr: |
          (1 - node_filesystem_avail_bytes{mountpoint="/var/log/chismoso"}
               / node_filesystem_size_bytes{mountpoint="/var/log/chismoso"}) > 0.80
        for: 5m
        labels:
          severity: P2
          team: chismoso
        annotations:
          summary: "Disk usage on /var/log/chismoso > 80%"
          description: "{{ $value | humanizePercentage }} used (SLO threshold: 80%)."
          runbook: "docs/RUNBOOK.md#6-disk-full"
```

### 8. slo_burn_rate_fast (P1, page)

Fires when the error-budget burn rate exceeds 14.4x over 1 hour.
14.4x = 2% of monthly budget per hour → fires at ~14 days of budget
remaining. This is the **fast** burn-rate alert; it catches acute
outages that don't trip `high_5xx_rate` because the overall rate is
low.

```yaml
      - alert: slo_burn_rate_fast
        expr: |
          (
            sum(rate(chismoso_http_requests_total{status=~"5.."}[1h]))
            /
            clamp_min(sum(rate(chismoso_http_requests_total[1h])), 0.001)
          ) > 0.144
        for: 5m
        labels:
          severity: P1
          team: chismoso
        annotations:
          summary: "SLO burn rate > 14.4x over 1h"
          description: "At this rate, the monthly error budget is exhausted in ~14 days."
          runbook: "docs/RUNBOOK.md#7-high-error-rate-5xx--1"
```

### 9. slo_burn_rate_slow (P2, ticket)

Fires when the burn rate exceeds 3x over 3 days. This catches
chronic degradation (a slow leak, a slow provider regression).

```yaml
      - alert: slo_burn_rate_slow
        expr: |
          (
            sum(rate(chismoso_http_requests_total{status=~"5.."}[3d]))
            /
            clamp_min(sum(rate(chismoso_http_requests_total[3d])), 0.001)
          ) > 0.03
        for: 30m
        labels:
          severity: P2
          team: chismoso
        annotations:
          summary: "SLO burn rate > 3x over 3 days"
          description: "Chronic 5xx rate — investigate the cause before it burns the full budget."
          runbook: "docs/RUNBOOK.md#7-high-error-rate-5xx--1"
```

### 10. process_down (P1, page)

Fires when Prometheus can't scrape `/api/metrics` for 2 min. This
means either the Next.js process is dead, or the host is unreachable.

```yaml
      - alert: process_down
        expr: up{job="chismoso"} == 0
        for: 2m
        labels:
          severity: P1
          team: chismoso
        annotations:
          summary: "CHISMOSO process unreachable for 2 min"
          description: "Prometheus can't scrape /api/metrics. Check livez + readyz."
          runbook: "docs/RUNBOOK.md#3-process-crash--oom"
```

---

## Synthetic monitoring

Some SLIs can't be computed from Prometheus metrics alone — they
need an external probe. We use the Blackbox Exporter to probe:

1. `GET /api/livez` every 30s — emits `probe_success` (1 if HTTP 200).
2. `GET /api/readyz` every 30s — emits `chismoso_readyz_probe_success` (1 if HTTP 200, 0 if 503).
3. `GET /api/doctor` every 5m — emits `chismoso_doctor_overall_ok` (1 if `overall_status == OK`).
4. `POST /api/investigate` every 5m with a fixed objective — emits
   `chismoso_investigate_probe_success` (1 if HTTP 200 with
   `status: 'COMPLETED'`).

The Blackbox Exporter config:

```yaml
modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      method: GET
      valid_http_versions: ["HTTP/1.1", "HTTP/2.0"]
      valid_status_codes: [200]

  http_2xx_or_503:
    prober: http
    timeout: 5s
    http:
      valid_status_codes: [200, 503]
```

Job config in `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: chismoso_blackbox_livez
    metrics_path: /probe
    params:
      module: [http_2xx]
      target: [http://localhost:3000/api/livez]
    static_configs:
      - targets: ['localhost:9115']  # blackbox exporter

  - job_name: chismoso_blackbox_readyz
    metrics_path: /probe
    params:
      module: [http_2xx_or_503]
      target: [http://localhost:3000/api/readyz]
    static_configs:
      - targets: ['localhost:9115']

  - job_name: chismoso
    metrics_path: /api/metrics
    static_configs:
      - targets: ['localhost:3000']
    # Apply trace_id label so the trace propagates to the scraper.
    # (Blackbox doesn't propagate trace_ids — that's fine, the scrape
    # itself isn't a "user request" we need to correlate.)
```

---

## Log-based alerts (Loki / LogQL)

For alerts that need log content (not just metric values), use Loki
+ Grafana alerting:

### L1. unhandled_promise_rejection (P1)

```logql
{job="chismoso"} |= "unhandled_rejection" | json
```

Fires on any unhandled promise rejection. These are sentinels for
the process being in a corrupted state — see incident #3 in the
runbook.

### L2. sqlite_busy (P2)

```logql
sum by (route) (
  count_over_time(
    {job="chismoso"} |= "SQLITE_BUSY" | json [5m]
  )
) > 5
```

Fires when >5 SQLITE_BUSY errors in 5 min on any single route.

### L3. audit_log_write_failed (P2)

```logql
{job="chismoso"} |= "audit_log_append_failed" | json
```

Audit log writes are fire-and-forget; failure means we're losing
compliance trail. Investigate immediately (the SQLite writer might
be locked, the disk might be full, etc.).

---

## Alertmanager routing

```yaml
route:
  receiver: default
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers: ['severity="P1"']
      receiver: pagerduty-chismoso
      group_wait: 0s
      repeat_interval: 1h
    - matchers: ['severity="P2"']
      receiver: slack-chismoso
      group_wait: 5m
      repeat_interval: 12h
    - matchers: ['severity="P3"']
      receiver: slack-chismoso
      group_wait: 30m

receivers:
  - name: default
    slack_configs:
      - channel: '#chismoso-alerts'
  - name: pagerduty-chismoso
    pagerduty_configs:
      - service_key: '$PAGERDUTY_CHISMOSO_KEY'
        severity: critical
  - name: slack-chismoso
    slack_configs:
      - channel: '#chismoso-alerts'
        send_resolved: true
```

---

## Operator checklist

Before each on-call shift:

1. `curl /api/readyz` — confirm the system is currently healthy.
2. `curl /api/metrics | grep chismoso_investigations_total` — eyeball
   the recent investigation volume.
3. Open Sentry → Releases → current release. Confirm the error
   count is in the expected range.
4. Skim `docs/RUNBOOK.md` for any new sections added since last
   shift.

Before each deploy:

1. `curl /api/version` — note the current `git_commit` (so you can
   rollback to it).
2. Pause P1 alert routing in Alertmanager (`/api/v2/silences`) for
   10 min to absorb the deploy bump.
3. After deploy: `curl /api/livez /api/readyz /api/health` — all
   three should return 200 within 60s.
4. Unsilence P1 alerts.
