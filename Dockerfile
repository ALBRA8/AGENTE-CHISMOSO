# syntax=docker/dockerfile:1.7
# =============================================================================
# CHISMOSO V1.5 — Production multi-stage Dockerfile
# Task IMP-PROD-OPS, audit PROD-AUDIT-OPS P0-1.
#
# Image layout:
#   Stage 1 (deps)                  — install root Next.js deps with bun
#   Stage 2 (builder)               — `bun run build` → .next/standalone/server.js
#   Stage 3a (chismoso-deps)        — install chismoso deps WITH devDeps (typescript)
#   Stage 3b (chismoso-runtime-deps) — install chismoso deps prod-only (for runtime)
#   Stage 3c (chismoso-builder)     — `bunx tsc` → chismoso/dist/{cli,scheduler/...}.js
#   Stage 4 (runtime)               — node:20-alpine, runs `node server.js` as nextjs:nodejs
#
# Target image size: < 500 MB (audit target).
# Native modules (better-sqlite3) are built for musl in stages 1, 3a, 3b so they
# work in the node:20-alpine runtime without recompilation.
# =============================================================================


# -----------------------------------------------------------------------------
# Stage 1: deps
#   Install ALL root deps (incl. devDeps — Next.js build needs typescript,
#   tailwindcss, eslint). node_modules is cached as a separate layer so
#   source changes don't invalidate the install.
# -----------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS deps

# better-sqlite3 native build needs python3 + make + g++ on alpine (musl).
RUN apk add --no-cache python3 make g++ \
    && ln -sf python3 /usr/bin/python

WORKDIR /app

# Copy lockfile + manifest first for layer caching.
COPY package.json bun.lock ./

# --frozen-lockfile guarantees the lockfile matches package.json. CI/CD should
# catch the build failure if a dep was added without `bun install`.
RUN bun install --frozen-lockfile


# -----------------------------------------------------------------------------
# Stage 2: builder
#   Copy source + deps, run `bun run build` (which is
#   `next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/`).
#   Produces `.next/standalone/server.js` + bundled minimal `node_modules`.
# -----------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# Reuse the deps stage's node_modules without re-installing.
COPY --from=deps /app/node_modules ./node_modules

# Copy the rest of the source. .dockerignore keeps build artifacts, data,
# .git, .env* out of this context.
COPY . .

# Build Next.js. If `output: "standalone"` is missing from next.config.ts the
# build script's build.sh self-heals it; here we trust the committed config.
RUN bun run build


# -----------------------------------------------------------------------------
# Stage 3: chismoso-builder
#   Compile chismoso TypeScript → dist/. Better-sqlite3 is rebuilt for musl here
#   so the node:20-alpine runtime can `require()` it without recompiling.
#
#   We split this into two stages (deps + builder) because the build needs
#   TypeScript (devDep) but the runtime node_modules should be prod-only.
# -----------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS chismoso-deps

RUN apk add --no-cache python3 make g++ \
    && ln -sf python3 /usr/bin/python

WORKDIR /app/chismoso
COPY chismoso/package.json chismoso/bun.lock ./
# Install ALL deps (incl. devDeps — typescript is required for the tsc build).
RUN bun install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 3b: chismoso-runtime-deps
#   Same as chismoso-deps but --production. Used as the source of the
#   runtime node_modules (no typescript, no test framework).
# -----------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS chismoso-runtime-deps

RUN apk add --no-cache python3 make g++ \
    && ln -sf python3 /usr/bin/python

WORKDIR /app/chismoso
COPY chismoso/package.json chismoso/bun.lock ./
RUN bun install --frozen-lockfile --production

# -----------------------------------------------------------------------------
# Stage 3c: chismoso-builder
#   Uses chismoso-deps' node_modules (which has typescript) to compile the TS.
# -----------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS chismoso-builder

WORKDIR /app/chismoso
COPY --from=chismoso-deps /app/chismoso/node_modules ./node_modules
COPY chismoso/tsconfig.json ./
COPY chismoso/src ./src

# Bare `tsc` matches the chismoso/package.json `build` script. Picks up
# tsconfig.json from the working directory.
RUN bunx tsc


# -----------------------------------------------------------------------------
# Stage 4: runtime
#   node:20-alpine base. Runs as non-root user `nextjs:nodejs` (uid/gid 1001).
#   Uses tini for PID 1 signal forwarding (clean SIGTERM → graceful shutdown
#   of Next.js, mini-services, chismoso scheduler subprocess).
#   Healthcheck hits /api/livez (PROD-SEC creates this endpoint; if absent the
#   healthcheck will mark the container unhealthy without crashing it).
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runtime

# tini = PID 1 signal forwarder. curl = healthcheck client.
# addgroup/adduser create a non-root account for the USER directive below.
RUN apk add --no-cache tini curl \
    && addgroup -S -g 1001 nodejs \
    && adduser -S -D -H -u 1001 -G nodejs nextjs

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CHISMOSO_DB_PATH=/data/chismoso.db \
    CHISMOSO_OUTPUT_DIR=/data/reports

# --- Next.js standalone (bundles minimal node_modules + .next/static) ---
# `bun run build` already copied `.next/static` and `public` into
# `.next/standalone/`, so we only need to copy the standalone tree.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs ./public ./public

# --- chismoso CLI + scheduler + native node_modules (better-sqlite3 for musl) ---
# chismoso/dist comes from the builder stage; node_modules comes from the
# runtime-deps stage (prod-only — no typescript, no test framework).
COPY --from=chismoso-builder --chown=nextjs:nodejs /app/chismoso/dist ./chismoso/dist
COPY --from=chismoso-runtime-deps --chown=nextjs:nodejs /app/chismoso/node_modules ./chismoso/node_modules
COPY --chown=nextjs:nodejs ./chismoso/package.json ./chismoso/package.json

# --- ops scripts (backup, healthcheck wrapper) ---
RUN mkdir -p /data /data/reports /opt/scripts
COPY --chown=nextjs:nodejs ./scripts/backup-sqlite.sh /opt/scripts/backup-sqlite.sh
COPY --chown=nextjs:nodejs ./scripts/healthcheck.sh /opt/scripts/healthcheck.sh
RUN chmod +x /opt/scripts/*.sh

USER nextjs

# Next.js standalone server. Bound to 0.0.0.0 so the host (and Caddy reverse
# proxy) can reach it on the docker network.
EXPOSE 3000

# Healthcheck:
#   1. /api/livez (preferred — ultra-light liveness, no DB touch)
#   2. /api/health (fallback — SELECT 1 against chismoso SQLite, still <1ms)
# Both 200 → healthy. Either fails → unhealthy. start-period=20s lets Next.js
# boot + run any `doctor --fix` first-run migrations before being marked down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD /opt/scripts/healthcheck.sh || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
