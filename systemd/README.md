# CHISMOSO systemd units

This directory contains the systemd unit + timer files that turn CHISMOSO
from "starts when someone runs start.sh" into "supervised, auto-restarts
on crash, nightly backups, nightly report cleanup."

## Units

| File | Type | Purpose |
|---|---|---|
| `chismoso.service` | long-running | Next.js production server (port 3000, 127.0.0.1) |
| `chismoso-scheduler.service` | long-running | Continuous topic re-investigation (`chismoso/src/scheduler/run.ts`) |
| `chismoso-cron.service` | oneshot | Nightly SQLite backup (`scripts/backup-sqlite.sh`) |
| `chismoso-cron.timer` | timer | Triggers `chismoso-cron.service` daily at 03:00 |
| `chismoso-cleanup.service` | oneshot | Nightly report cleanup (`scripts/cleanup-reports.sh`) |
| `chismoso-cleanup.timer` | timer | Triggers `chismoso-cleanup.service` daily at 04:00 |

## Install

```bash
# As root, on the production host:
install -d /etc/systemd/system
install -m 0644 -o root -g root \
  systemd/chismoso.service \
  systemd/chismoso-scheduler.service \
  systemd/chismoso-cron.service \
  systemd/chismoso-cron.timer \
  systemd/chismoso-cleanup.service \
  systemd/chismoso-cleanup.timer \
  /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now chismoso.service
systemctl enable --now chismoso-scheduler.service
systemctl enable --now chismoso-cron.timer
systemctl enable --now chismoso-cleanup.timer

# Verify
systemctl status chismoso.service
journalctl -u chismoso.service -f
```

## Operational notes

### Restart policy
`chismoso.service` uses `Restart=on-failure` with a 5-restart-per-minute
burst cap. If the Next.js process crashes 5× in 60s (e.g. a corrupt native
module on boot), systemd gives up — operator intervention required. The
scheduler is similar but with a longer RestartSec because it doesn't
need to come back as fast as the request-serving process.

### Graceful shutdown
`TimeoutStopSec=30s` matches the internal drain budget in
`src/lib/graceful-shutdown.ts`. The Next.js process receives SIGTERM,
flips `isShuttingDown()`, kills any in-flight `child.kill('SIGTERM')`
spawns (see `src/app/api/investigate/route.ts`), and exits within 30s.
systemd SIGKILLs if we exceed the budget.

### Permissions
Units run as user `chismoso` (no sudo, no shell). `ProtectSystem=strict`
makes most of the filesystem readonly; only the data, download, log,
and backup paths are writable. `NoNewPrivileges=yes` blocks setuid
escalation. These are defense-in-depth measures so an exploited route
can't trivially pivot into the host.

### Backups
The backup timer runs the `scripts/backup-sqlite.sh` script. See that
file for the off-site (S3) and encryption (GPG) options.
