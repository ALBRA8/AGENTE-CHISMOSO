#!/usr/bin/env sh
# =============================================================================
# CHISMOSO V1.5 — Docker HEALTHCHECK wrapper
# Task IMP-PROD-OPS, audit PROD-AUDIT-OPS P0-1.
#
# Used by the Dockerfile's HEALTHCHECK directive. Hits /api/livez first; if
# that 404s (because the image is from before PROD-SEC created the livez route),
# falls back to /api/health which exists from day one.
#
# Exits 0 on success, 1 on failure. Docker marks the container unhealthy after
# `retries` consecutive 1s (see Dockerfile).
# =============================================================================
set -eu

PORT="${PORT:-3000}"
HOST="127.0.0.1"

# Try /api/livez first — preferred (no DB touch, ultra-fast).
if curl -fsS --max-time 3 "http://${HOST}:${PORT}/api/livez" >/dev/null 2>&1; then
  exit 0
fi

# Fall back to /api/health (does SELECT 1 against SQLite — still <1ms on a
# warm cache, but exercises the DB connection).
if curl -fsS --max-time 5 "http://${HOST}:${PORT}/api/health" >/dev/null 2>&1; then
  exit 0
fi

# Both failed. Container is unhealthy.
exit 1
