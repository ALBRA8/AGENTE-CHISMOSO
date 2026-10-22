#!/usr/bin/env bash
# =============================================================================
# CHISMOSO V1.5 — pull + build + restart + smoke test
# Task IMP-PROD-OPS, audit PROD-AUDIT-OPS P0-10.
#
# Usage (on the production host):
#   bash scripts/upgrade.sh                    # upgrade to the latest tag
#   bash scripts/upgrade.sh v1.5.1             # upgrade to a specific tag
#   bash scripts/upgrade.sh main               # upgrade to a branch (NOT recommended for prod)
#
# What it does:
#   1. cd /opt/chismoso (or the current working directory).
#   2. Take a pre-upgrade SQLite backup (best-effort).
#  3. git fetch --tags + checkout the requested ref.
#   4. docker compose build (rebuild the image with new code).
#   5. docker compose up -d (recreate containers that changed).
#   6. sleep 10 — give Next.js time to boot.
#   7. curl -f /api/livez OR /api/health — smoke test.
#   8. If smoke test fails → git checkout HEAD~1 + rebuild + restart + exit 1.
#
# Designed to be safe to re-run. Safe to run from cron.
# =============================================================================
set -euo pipefail

# --- Output helpers ----------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
err()  { printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
die()  { err "$*"; exit 1; }

# --- Locate the install dir --------------------------------------------------
INSTALL_DIR="${CHISMOSO_INSTALL_DIR:-/opt/chismoso}"
if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
  # Fall back to the current working directory if it's a git repo.
  if [[ -d "$(pwd)/.git" ]]; then
    INSTALL_DIR="$(pwd)"
    log "Using current directory as install dir: ${INSTALL_DIR}"
  else
    die "Cannot find install dir. Set CHISMOSO_INSTALL_DIR or run from a clone of the repo."
  fi
fi

cd "${INSTALL_DIR}"
log "Working directory: ${INSTALL_DIR}"

# --- Detect previous ref (for rollback) --------------------------------------
PREV_REF="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
log "Previous ref: ${PREV_REF}"

# --- Target ref --------------------------------------------------------------
TARGET_REF="${1:-}"
if [[ -z "${TARGET_REF}" ]]; then
  # Default: stay on the current branch + pull. Operators should pin tags in
  # prod but we don't enforce that here.
  TARGET_REF="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')"
  log "No target ref given — staying on branch ${TARGET_REF} and pulling."
fi
log "Target ref: ${TARGET_REF}"

# --- Pre-upgrade backup (best-effort) ----------------------------------------
log "Taking pre-upgrade backup (best-effort)…"
if docker compose -f docker-compose.yml -f docker-compose.prod.yml ps app 2>/dev/null | grep -q 'Up'; then
  docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    exec -T app /opt/scripts/backup-sqlite.sh 2>&1 | tail -1 || \
    log "⚠️  Pre-upgrade backup failed — continuing anyway."
else
  log "App container not running — skipping backup (DB might not be ready yet)."
fi

# --- Pull + checkout ---------------------------------------------------------
log "Fetching tags + checking out ${TARGET_REF}…"
git fetch --tags --quiet
if ! git checkout "${TARGET_REF}" 2>&1; then
  die "Failed to checkout ${TARGET_REF} — does the ref exist in the repo?"
fi

# Pull if we checked out a branch (tags don't need to be pulled).
if git symbolic-ref -q HEAD >/dev/null 2>&1; then
  git pull --ff-only 2>&1 || log "⚠️  git pull failed (maybe offline?) — continuing with what's checked out."
fi

CURRENT_REF="$(git rev-parse --short HEAD)"
log "Now at ref: ${CURRENT_REF}"

if [[ "${CURRENT_REF}" == "${PREV_REF}" ]]; then
  log "Already at ${CURRENT_REF} — no upgrade needed. Exiting."
  exit 0
fi

# --- Build + restart ---------------------------------------------------------
log "Building the new Docker image…"
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  build app chismoso-scheduler chismoso-backup

log "Recreating changed containers…"
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  up -d --no-deps app chismoso-scheduler chismoso-backup

# --- Smoke test -------------------------------------------------------------
log "Waiting for the app to come up (max 60s)…"
SMOKE_OK=false
for i in {1..30}; do
  if docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T app \
      curl -fsS http://127.0.0.1:3000/api/livez 2>/dev/null | grep -q '"status"'; then
    SMOKE_OK=true
    log "✓ /api/livez returned ok."
    break
  fi
  if docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T app \
      curl -fsS http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"status"'; then
    SMOKE_OK=true
    log "✓ /api/health returned ok (fallback for images without /api/livez yet)."
    break
  fi
  sleep 2
done

if [[ "${SMOKE_OK}" != "true" ]]; then
  err "Health check failed after upgrade. Rolling back to ${PREV_REF}."
  docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    logs --tail=50 app chismoso-scheduler 2>&1 || true
  git checkout "${PREV_REF}"
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.prod.yml \
    build app chismoso-scheduler chismoso-backup
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.prod.yml \
    up -d --no-deps app chismoso-scheduler chismoso-backup
  # Give the rollback a few seconds to come up.
  sleep 10
  err "Rollback complete. The app is back at ${PREV_REF}. Investigate the logs above before retrying."
  exit 1
fi

# --- Done -------------------------------------------------------------------
log "✓ Upgrade complete."
log "Now at ref: ${CURRENT_REF} (was ${PREV_REF})."
echo
echo "Next: verify the doctor endpoint:"
echo "  curl -fsS https://\${CHISMOSO_DOMAIN}/api/doctor | jq .summary"
echo
echo "If anything looks wrong, roll back manually:"
echo "  cd ${INSTALL_DIR}"
echo "  git checkout ${PREV_REF}"
echo "  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build"
exit 0
