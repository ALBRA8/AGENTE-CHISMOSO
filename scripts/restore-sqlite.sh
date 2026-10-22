#!/bin/bash
# ============================================================================
#  CHISMOSO V1.5 — SQLite restore runbook script (REL-P0-002)
#
#  What it does
#  ------------
#  1. Stops the chismoso Next.js service (so no new writes hit the DB
#     while we're restoring).
#  2. Verifies the backup file: integrity_check + the same per-table
#     SELECT count(*) smoke that backup-sqlite.sh's --test-restore runs.
#  3. Copies the current DB aside as a safety net (.pre-restore.bak).
#  4. Restores the backup over the live DB path. If the backup is GPG-
#     encrypted (.gpg), decrypts it first.
#  5. Re-applies WAL pragmas (the backup file is a snapshot — it doesn't
#     carry the live connection's pragma state).
#  6. Starts the chismoso service back up.
#  7. Verifies the new live DB by hitting /api/health.
#
#  Usage
#  -----
#    sudo scripts/restore-sqlite.sh /var/backups/chismoso/chismoso-20240115-030000.db
#    sudo scripts/restore-sqlite.sh /var/backups/chismoso/chismoso-20240115-030000.db.gpg
#
#  Exit codes
#  ----------
#    0  success
#    1  usage / argument error
#    2  backup file missing or unreadable
#    3  integrity_check failed on backup
#    4  table smoke check failed
#    5  service stop/start failed
#    6  copy / restore failed
#    7  post-restore health check failed
# ============================================================================

set -euo pipefail

CHISMOSO_DB_PATH="${CHISMOSO_DB_PATH:-/home/z/my-project/chismoso/data/chismoso.db}"
SERVICE_NAME="${CHISMOSO_SERVICE_NAME:-chismoso}"
BACKUP_LOG="${BACKUP_LOG:-/var/log/chismoso/restore.log}"
SCHEDULER_SERVICE_NAME="${CHISMOSO_SCHEDULER_SERVICE_NAME:-chismoso-scheduler}"

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <backup-file>[.gpg]" >&2
  exit 1
fi
BACKUP_FILE="$1"

mkdir -p "$(dirname "$BACKUP_LOG")"
TS="$(date +%Y%m%d-%H%M%S)"
LOG_PREFIX="[chismoso-restore $TS]"

log() {
  echo "$(date -Iseconds) $LOG_PREFIX $*" | tee -a "$BACKUP_LOG" >&2
}

if [[ ! -f "$BACKUP_FILE" ]]; then
  log "FATAL: backup file not found: $BACKUP_FILE"
  exit 2
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  log "FATAL: sqlite3 not installed"
  exit 1
fi

# --- 1. Decrypt if GPG-encrypted ----------------------------------------
WORK_DB="/tmp/chismoso-restore-$TS.db"
if [[ "$BACKUP_FILE" == *.gpg ]]; then
  if ! command -v gpg >/dev/null 2>&1; then
    log "FATAL: backup is GPG-encrypted but gpg not installed"
    exit 2
  fi
  log "decrypting $BACKUP_FILE -> $WORK_DB"
  if ! gpg --batch --yes --output "$WORK_DB" --decrypt "$BACKUP_FILE" 2>>"$BACKUP_LOG"; then
    log "FATAL: gpg decrypt failed"
    rm -f "$WORK_DB"
    exit 2
  fi
else
  cp "$BACKUP_FILE" "$WORK_DB"
fi

# --- 2. Pre-restore verification ----------------------------------------
INTEGRITY=$(sqlite3 "$WORK_DB" "PRAGMA integrity_check;" 2>&1 | head -1)
if [[ "$INTEGRITY" != "ok" ]]; then
  log "FATAL: backup integrity_check returned '$INTEGRITY'"
  rm -f "$WORK_DB"
  exit 3
fi
log "backup integrity_check ok"

for table in topics signals evidence trends problems opportunities \
             investigations provider_runs topic_observations alerts \
             memories skills execution_traces feedback provider_quality; do
  COUNT=$(sqlite3 "$WORK_DB" "SELECT count(*) FROM $table;" 2>&1) || {
    log "FATAL: SELECT count(*) FROM $table failed: $COUNT"
    rm -f "$WORK_DB"
    exit 4
  }
  log "backup $table -> $COUNT rows"
done

# --- 3. Stop services ---------------------------------------------------
log "stopping $SCHEDULER_SERVICE_NAME (it holds a writer connection)"
systemctl stop "$SCHEDULER_SERVICE_NAME" 2>>"$BACKUP_LOG" || {
  log "WARN: scheduler stop failed — continuing"
}
log "stopping $SERVICE_NAME"
if ! systemctl stop "$SERVICE_NAME" 2>>"$BACKUP_LOG"; then
  log "FATAL: could not stop $SERVICE_NAME"
  rm -f "$WORK_DB"
  exit 5
fi

# Give in-flight requests a moment to drain. graceful-shutdown.ts gives
# 30s; we wait 35s to be safe before we touch the DB file.
log "waiting 35s for graceful drain"
sleep 35

# --- 4. Snapshot current DB aside as safety net -------------------------
if [[ -f "$CHISMOSO_DB_PATH" ]]; then
  PRE_RESTORE="${CHISMOSO_DB_PATH}.pre-restore-$TS.bak"
  log "snapshotting current DB -> $PRE_RESTORE"
  cp -p "$CHISMOSO_DB_PATH" "$PRE_RESTORE"
  # Also keep its WAL/SHM so the snapshot is fully consistent.
  [[ -f "${CHISMOSO_DB_PATH}-wal" ]] && cp -p "${CHISMOSO_DB_PATH}-wal" "${PRE_RESTORE}-wal" || true
  [[ -f "${CHISMOSO_DB_PATH}-shm" ]] && cp -p "${CHISMOSO_DB_PATH}-shm" "${PRE_RESTORE}-shm" || true
fi

# --- 5. Restore over live DB path --------------------------------------
# Remove the live DB, WAL, SHM so SQLite doesn't replay an old WAL on top
# of our restore. (WAL replay would silently undo the restore.)
rm -f "${CHISMOSO_DB_PATH}" "${CHISMOSO_DB_PATH}-wal" "${CHISMOSO_DB_PATH}-shm"
log "copying $WORK_DB -> $CHISMOSO_DB_PATH"
if ! cp "$WORK_DB" "$CHISMOSO_DB_PATH"; then
  log "FATAL: restore copy failed"
  rm -f "$WORK_DB"
  # Try to roll back to the pre-restore snapshot.
  if [[ -f "${CHISMOSO_DB_PATH}.pre-restore-$TS.bak" ]]; then
    cp "${CHISMOSO_DB_PATH}.pre-restore-$TS.bak" "$CHISMOSO_DB_PATH" || true
  fi
  exit 6
fi
chown chismoso:chismoso "$CHISMOSO_DB_PATH" 2>/dev/null || true
chmod 0640 "$CHISMOSO_DB_PATH"

# --- 6. Re-apply WAL pragmas so the live DB starts in the right mode ---
# (The backup file may have been taken from a connection that didn't
# have WAL set; re-applied pragmas survive across re-opens.)
sqlite3 "$CHISMOSO_DB_PATH" "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;" 2>>"$BACKUP_LOG" || {
  log "WARN: could not re-apply pragmas — chismoso CLI will re-apply on next start"
}

# --- 7. Restart services + health check --------------------------------
log "starting $SERVICE_NAME"
if ! systemctl start "$SERVICE_NAME" 2>>"$BACKUP_LOG"; then
  log "FATAL: could not start $SERVICE_NAME"
  exit 5
fi
log "starting $SCHEDULER_SERVICE_NAME"
systemctl start "$SCHEDULER_SERVICE_NAME" 2>>"$BACKUP_LOG" || {
  log "WARN: scheduler start failed — check manually"
}

# Wait for Next.js to come up + serve /api/health. Up to 30 retries (15s).
log "waiting for /api/health"
for i in $(seq 1 30); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null || echo "000")
  if [[ "$CODE" == "200" ]]; then
    log "/api/health 200 (after ${i} retries)"
    break
  fi
  sleep 0.5
done
if [[ "$CODE" != "200" ]]; then
  log "FATAL: /api/health did not return 200 (last code: $CODE)"
  exit 7
fi

# Confirm DB really did change — pull the schema_meta.version row.
VERSION=$(sqlite3 "$CHISMOSO_DB_PATH" "SELECT value FROM schema_meta WHERE key='version';" 2>&1 || echo "ERR")
log "post-restore schema_meta.version=$VERSION"

rm -f "$WORK_DB"
log "DONE"
exit 0
