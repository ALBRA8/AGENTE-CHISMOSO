# CHISMOSO V1.5 operational scripts

| Script | Purpose | Schedule |
|---|---|---|
| `backup-sqlite.sh` | Online SQLite backup → local dir → optional GPG + S3 | Daily 03:00 via `chismoso-cron.timer` |
| `restore-sqlite.sh` | Restore from a given backup file (runbook script) | Manual |
| `cleanup-reports.sh` | Delete report-*.md / *.json pairs older than 30 days | Daily 04:00 via `chismoso-cleanup.timer` |

## Install

```bash
sudo install -d /opt/chismoso/scripts
sudo install -m 0755 -o chismoso -g chismoso \
  scripts/backup-sqlite.sh \
  scripts/restore-sqlite.sh \
  scripts/cleanup-reports.sh \
  /opt/chismoso/scripts/

# Create log + backup dirs with the right ownership
sudo install -d -m 0750 -o chismoso -g chismoso /var/log/chismoso /var/backups/chismoso
```

## Configuration (env vars)

All scripts read these env vars from `/opt/chismoso/.env.production`
(which is the `EnvironmentFile=` referenced by the systemd units):

| Var | Default | Used by |
|---|---|---|
| `CHISMOSO_DB_PATH` | `/home/z/my-project/chismoso/data/chismoso.db` | backup, restore |
| `CHISMOSO_OUTPUT_DIR` | `/home/z/my-project/download/chismoso` | cleanup |
| `BACKUP_DIR` | `/var/backups/chismoso` | backup, restore |
| `BACKUP_LOG` | `/var/log/chismoso/backup.log` | backup |
| `BACKUP_GPG_RECIPIENT` | *(unset)* | backup (enables encryption when set) |
| `BACKUP_S3_BUCKET` | *(unset)* | backup (enables S3 upload when set) |
| `BACKUP_S3_PREFIX` | `chismoso/backups` | backup |
| `BACKUP_DAILY_RETENTION` | `30` | backup |
| `BACKUP_MONTHLY_RETENTION` | `12` | backup |
| `CHISMOSO_REPORT_RETENTION_DAYS` | `30` | cleanup |
| `CHISMOSO_CLEANUP_LOG` | `/var/log/chismoso/cleanup.log` | cleanup |

## Backup rotation strategy

`backup-sqlite.sh` keeps:
- The last **30 daily** backups (everything from yesterday to 30 days ago)
- The first-of-month backup kept for **12 monthly** rotations

So you always have:
- Yesterday's backup
- A backup from each of the last 30 days
- A backup from the 1st of each of the last 12 months

This matches the standard `logrotate`-style 30+12 strategy. RPO ≤ 24h
(daily backup at 03:00); RTO ~5 min (the restore script is fully
automated: stop service, restore, restart, verify health).

## Test-restore

The backup script has a `--test-restore` flag (enabled by default in the
cron unit) that:
1. Copies the backup to a temp file
2. Decrypts if it's GPG-encrypted
3. Runs `PRAGMA integrity_check` against it
4. Runs `SELECT count(*) FROM <table>` for every core table
5. Deletes the temp file

This is the restore-confidence check — if it passes, the backup is
restorable. If it fails, the cron unit fails and `systemctl status
chismoso-cron.service` shows the failure.

## Restore runbook

```bash
# 1. Identify the backup you want to restore from
ls -la /var/backups/chismoso/

# 2. Stop new traffic at the load balancer / Caddy
#    (or rely on the restore script's `systemctl stop` to drain.)

# 3. Run the restore script as root
sudo /opt/chismoso/scripts/restore-sqlite.sh \
  /var/backups/chismoso/chismoso-20240115-030000.db.gpg

# 4. The script:
#    - stops chismoso-scheduler + chismoso services
#    - waits 35s for in-flight requests to drain
#    - snapshots the current DB aside as a .pre-restore.bak
#    - copies the backup over the live DB path
#    - re-applies WAL pragmas
#    - starts the services back up
#    - waits for /api/health to return 200

# 5. If the script failed mid-way:
#    - The .pre-restore.bak file is your safety net. Copy it back:
#      sudo cp /home/z/my-project/chismoso/data/chismoso.db.pre-restore-*.bak \
#               /home/z/my-project/chismoso/data/chismoso.db
#      sudo systemctl start chismoso
```

## Notes on the SQLite `.backup` command

The backup script uses `sqlite3 "$DB" ".backup '$DEST'"` rather than
`cp`. Why:
- `cp` races the writer — you can copy a half-written page
- `sqlite3 .backup` uses the SQLite backup API which takes a shared
  lock and copies page-by-page atomically
- During the copy, the writer pauses for ~one page write (sub-ms);
  readers continue unaffected because WAL gives them a consistent
  snapshot

No service stop needed. This is the recommended way to back up a
SQLite DB online.
