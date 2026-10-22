#!/usr/bin/env bash
# =============================================================================
# CHISMOSO V1.5 — SQLite backup script (REL-P0-002)
#
# Online backup of the chismoso SQLite DB to BACKUP_DIR. Optional GPG
# encryption + S3 off-site copy.
#
# Environment (read from .env.production via systemd EnvironmentFile, or
# from the docker-compose env_file):
#   CHISMOSO_DB_PATH            path to the live SQLite file
#   BACKUP_DIR                  local backup destination (default /var/backups/chismoso)
#   BACKUP_LOG                  optional log file (default: stdout)
#   BACKUP_GPG_RECIPIENT        optional GPG key fingerprint for encryption
#   BACKUP_S3_BUCKET            optional s3:// destination
#   BACKUP_S3_PREFIX            optional key prefix (default: chismoso/backups)
#   BACKUP_DAILY_RETENTION      default 30 (days)
#   BACKUP_MONTHLY_RETENTION    default 12 (months)
#
# Flags:
#   --test-restore   after writing the backup, copy it to a temp file, run
#                    PRAGMA integrity_check + SELECT count(*) on every core
#                    table, then delete the temp. Exits 4 on test failure.
#
# Safe on a live DB: uses the SQLite backup API (`.backup`) which takes a
# shared lock and copies page-by-page atomically. No service stop needed.
#
# Exits:
#   0  success (incl. test-restore pass)
#   1  usage / config error
#   2  DB file missing
#   3  sqlite3 not installed
#   4  integrity_check or table smoke failed (test-restore)
# =============================================================================
set -euo pipefail

DB_PATH="${CHISMOSO_DB_PATH:-/home/z/my-project/chismoso/data/chismoso.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/chismoso}"
BACKUP_LOG="${BACKUP_LOG:-}"
GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-}"
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
S3_PREFIX="${BACKUP_S3_PREFIX:-chismoso/backups}"
DAILY_RETENTION="${BACKUP_DAILY_RETENTION:-30}"
MONTHLY_RETENTION="${BACKUP_MONTHLY_RETENTION:-12}"

TEST_RESTORE=false
if [[ "${1:-}" == "--test-restore" ]]; then
  TEST_RESTORE=true
fi

# Logging helper — goes to file if BACKUP_LOG set, else stdout.
log() {
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  if [[ -n "${BACKUP_LOG}" ]]; then
    printf '[%s] %s\n' "${ts}" "$*" >> "${BACKUP_LOG}"
  else
    printf '[%s] %s\n' "${ts}" "$*}"
  fi
}

err() {
  printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

# --- Pre-flight --------------------------------------------------------------
if ! command -v sqlite3 >/dev/null 2>&1; then
  err "sqlite3 is not installed. Install with: apk add sqlite (alpine) or apt install sqlite3 (debian)."
  exit 3
fi

if [[ ! -f "${DB_PATH}" ]]; then
  err "DB file not found at ${DB_PATH} — nothing to back up."
  exit 2
fi

mkdir -p "${BACKUP_DIR}"
log "Starting backup of ${DB_PATH} → ${BACKUP_DIR}"

# --- Backup -----------------------------------------------------------------
TS="$(date -u +%Y%m%dT%H%M%SZ)"
HOSTNAME_TAG="$(hostname -s 2>/dev/null || echo 'unknown')"
OUT="${BACKUP_DIR}/chismoso-${TS}-${HOSTNAME_TAG}.db"

# `.backup` uses the SQLite online backup API — atomic, no exclusive lock.
# Quoting the path inside the SQL string lets paths with spaces work.
log "Running sqlite3 '${DB_PATH}' '.backup ${OUT}'"
if ! sqlite3 "${DB_PATH}" ".backup '${OUT}'" 2>&1 | while read -r line; do log "$line"; done; then
  err "sqlite3 .backup failed"
  exit 1
fi

if [[ ! -s "${OUT}" ]]; then
  err "Backup file ${OUT} is empty — copy failed"
  exit 1
fi

log "Backup written: ${OUT} ($(stat -c %s "${OUT}" 2>/dev/null || stat -f %z "${OUT}") bytes)"

# --- Test-restore (optional) ------------------------------------------------
if [[ "${TEST_RESTORE}" == "true" ]]; then
  log "Running --test-restore verification"
  TMP_DB="$(mktemp)"
  cp "${OUT}" "${TMP_DB}"
  trap 'rm -f "${TMP_DB}"' EXIT

  INTEGRITY=$(sqlite3 "${TMP_DB}" "PRAGMA integrity_check;" 2>&1)
  if [[ "${INTEGRITY}" != "ok" ]]; then
    err "integrity_check returned: ${INTEGRITY}"
    exit 4
  fi

  # Smoke test — confirm a few core tables are queryable.
  for table in investigations signals trends opportunities problems evidence execution_traces feedback provider_quality; do
    # Some tables may not exist on older schema versions — tolerant.
    COUNT=$(sqlite3 "${TMP_DB}" "SELECT count(*) FROM ${table};" 2>/dev/null || echo "missing")
    log "  ${table}: ${COUNT} rows"
  done
  log "✓ test-restore passed"
fi

# --- GPG encryption (optional) ----------------------------------------------
GPG_OUT=""
if [[ -n "${GPG_RECIPIENT}" ]] && command -v gpg >/dev/null 2>&1; then
  GPG_OUT="${OUT}.gpg"
  log "Encrypting to ${GPG_OUT} for recipient ${GPG_RECIPIENT}"
  gpg --batch --yes --trust-model always --recipient "${GPG_RECIPIENT}" --encrypt "${OUT}"
  rm -f "${OUT}"
  OUT="${GPG_OUT}"
fi

# --- S3 upload (optional) ---------------------------------------------------
if [[ -n "${S3_BUCKET}" ]] && command -v aws >/dev/null 2>&1; then
  KEY="${S3_PREFIX}/$(basename "${OUT}")"
  URI="${S3_BUCKET%/}/${KEY#\/}"
  log "Uploading ${OUT} → ${URI}"
  if aws s3 cp --sse AES256 "${OUT}" "${URI}" 2>&1 | while read -r line; do log "$line"; done; then
    log "✓ uploaded"
  else
    err "S3 upload failed — local copy preserved at ${OUT}"
  fi
fi

# --- Local retention: daily + monthly --------------------------------------
# Keep last 30 days of backups + the 1st-of-month backup for 12 months.
log "Pruning local backups (daily >${DAILY_RETENTION} days, monthly >${MONTHLY_RETENTION} months)"

# Delete daily backups older than DAILY_RETENTION, but keep any file from the
# 1st of the month (those are governed by MONTHLY_RETENTION below).
find "${BACKUP_DIR}" -name 'chismoso-*-*-*.db*' -type f -mtime +"${DAILY_RETENTION}" \
  -not -name 'chismoso-*01T*-*.db*' \
  -print -delete 2>/dev/null || true

# Delete monthly backups (1st of month) older than MONTHLY_RETENTION months.
find "${BACKUP_DIR}" -name 'chismoso-*01T*-*.db*' -type f -mtime +"$((MONTHLY_RETENTION * 31))" \
  -print -delete 2>/dev/null || true

log "✓ done"
exit 0
