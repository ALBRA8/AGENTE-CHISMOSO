#!/bin/bash
# ============================================================================
#  CHISMOSO V1.5 — Cleanup old reports (REL-P0-002, REL-P2-035)
#
#  The /api/investigate endpoint saves every report pair to
#  $CHISMOSO_OUTPUT_DIR:
#     report-<investigationId>.md
#     report-<investigationId>.json
#
#  Each pair is ~20-200 KB (markdown + structured JSON). Over a year of
#  daily scheduler runs + user-triggered investigations that's
#  ~30-100 MB of dead reports. Operators running the scheduler on a 1-hour
#  cadence will fill 24 reports/day = ~5 MB/day = ~1.8 GB/year.
#
#  This script deletes report pairs older than $RETENTION_DAYS (default
#  30). It is run by the chismoso-cleanup.{service,timer} systemd units
#  at 04:00 daily, after the backup job has finished.
#
#  Exit codes
#  ----------
#    0  success (even if zero files were deleted — that's a valid run)
#    1  config error (output dir missing)
#    2  find/rm error
# ============================================================================

set -euo pipefail

OUTPUT_DIR="${CHISMOSO_OUTPUT_DIR:-/home/z/my-project/download/chismoso}"
RETENTION_DAYS="${CHISMOSO_REPORT_RETENTION_DAYS:-30}"
LOG_FILE="${CHISMOSO_CLEANUP_LOG:-/var/log/chismoso/cleanup.log}"

mkdir -p "$(dirname "$LOG_FILE")"
TS="$(date -Iseconds)"
LOG_PREFIX="[chismoso-cleanup $TS]"

log() {
  echo "$LOG_PREFIX $*" | tee -a "$LOG_FILE" >&2
}

if [[ ! -d "$OUTPUT_DIR" ]]; then
  log "FATAL: output dir not found: $OUTPUT_DIR (nothing to clean)"
  exit 1
fi

# Files matching `report-inv_*.md` or `report-inv_*.json` older than
# $RETENTION_DAYS days are deleted. Both members of a pair are deleted
# together because they share the same modified-time (the CLI writes
# them within microseconds of each other via the same fsync).
log "deleting report-*.{md,json} older than $RETENTION_DAYS days in $OUTPUT_DIR"

# Use -print -delete so we get a count of what was deleted in the log.
DELETED_COUNT=0
while IFS= read -r -d '' f; do
  rm -f "$f"
  DELETED_COUNT=$((DELETED_COUNT + 1))
done < <(find "$OUTPUT_DIR" \
            -maxdepth 1 \
            -type f \
            \( -name 'report-inv_*.md' -o -name 'report-inv_*.json' \) \
            -mtime +$RETENTION_DAYS \
            -print0)

# Also clean up any orphan files (only one half of a pair — the partner
# was deleted above or never existed).
log "deleted $DELETED_COUNT files older than $RETENTION_DAYS days"

# Sanity check: report the disk space saved.
DISK_USAGE=$(du -sh "$OUTPUT_DIR" 2>/dev/null | awk '{print $1}')
log "current $OUTPUT_DIR disk usage: $DISK_USAGE"

log "DONE"
exit 0
