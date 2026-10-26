# Deployment Guide — CHISMOSO V1.5

> **TL;DR** — Clone the repo, copy `.env.production.example` → `.env.production`, fill in secrets, `docker compose up -d`, point your DNS A record at the server. Caddy auto-provisions HTTPS.

This guide covers a fresh single-server deploy on Ubuntu 22.04 LTS. For day-2 operations see [OPERATIONS.md](./OPERATIONS.md). For upgrades see [UPGRADE.md](./UPGRADE.md). For vulnerability reporting see [SECURITY.md](../SECURITY.md).

---

## 1. Provision the server

### Recommended specs (per audit PROD-AUDIT-OPS)

| Workload | CPU | RAM | Disk | Use case |
|---|---|---|---|---|
| **Small** (≤5 concurrent investigations) | 2 vCPU | 4 GB | 50 GB SSD | Solo analyst / POC |
| **Medium** (≤15 concurrent) | 4 vCPU | 8 GB | 100 GB SSD | Team of 5–10 |
| **Large** (>15 concurrent) | 8 vCPU | 16 GB | 250 GB SSD | Multi-team — contact us first |

The "small" profile is the default assumption in `docker-compose.prod.yml` resource limits. Scale up `deploy.resources.limits` if you have more headroom.

### OS

**Ubuntu 22.04 LTS** is recommended (audit recommendation). Debian 12 and RHEL 9 also work — adjust the package manager calls in `scripts/install.sh`.

### Swap

Even on a 4 GB box, add 2 GB of swap so the OOM-killer doesn't take out Next.js during a memory spike:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Firewall

Open only the ports Caddy needs:

```bash
sudo ufw allow 22/tcp      # SSH (consider moving off 22 + using ed25519 keys only)
sudo ufw allow 80/tcp      # HTTP (ACME challenge + http→https redirect)
sudo ufw allow 443/tcp     # HTTPS (app)
sudo ufw enable
```

---

## 2. Install Docker + Docker Compose

Easiest path — use the convenience script:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker   # or log out + back in
docker --version          # should print Docker version 24+
docker compose version    # should print v2.20+
```

Or run `bash scripts/install.sh` (also installs Docker if missing — see §6 below).

---

## 3. Clone the repo

```bash
sudo mkdir -p /opt/chismoso
sudo chown $USER:$USER /opt/chismoso
git clone https://github.com/ALBRA8/AGENTE-CHISMOSO.git /opt/chismoso
cd /opt/chismoso
git checkout v1.5.0   # pin to a release tag — never deploy `main` directly to prod
```

> ⚠️ **Branch pinning**: production should always run a tagged release (`vX.Y.Z`). The CD pipeline's `deploy-prod` job is gated by manual approval, but pinning the tag is your second line of defense against an unreviewed `main` commit shipping.

---

## 4. Configure secrets

```bash
cp .env.production.example .env.production
nano .env.production
```

Set **every** placeholder. The most important ones:

| Variable | How to generate | Notes |
|---|---|---|
| `CHISMOSO_JWT_SECRET` | `openssl rand -hex 32` | Signs short-lived JWTs. |
| `CHISMOSO_DOMAIN` | your domain (e.g. `chismoso.example.com`) | Must match the DNS A record you'll set in §7. |
| `CHISMOSO_CORS_ORIGINS` | `https://chismoso.example.com` | Comma-separated list of allowed browser origins. |
| `CHISMOSO_AUTH_TOKENS` | see below | SHA-256 hashes of agent tokens. |

### Generate an auth token

The auth middleware (see `src/lib/auth.ts` + `src/lib/middleware.ts`) requires a valid `X-Chismoso-Agent` header on every POST/PUT/PATCH when `CHISMOSO_AUTH_ENABLED=true`. The token is **never stored in plaintext** — only its SHA-256 hash goes in `.env.production`.

After the stack is up (post step 6), generate a token:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  node chismoso/dist/cli.js auth token
```

This prints:
```
Token:    chsm_<base64url-string>
Hash:     <64-char-hex-sha256>
```

Append the **hash** (not the plaintext) to `CHISMOSO_AUTH_TOKENS` in `.env.production` (comma-separated if you have multiple). Then:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart app
```

Distribute the plaintext token to your agents / API clients over a secure channel (1Password, Bitwarden, signed email). Treat it like a password.

---

## 5. Boot the stack

```bash
cd /opt/chismoso
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  up -d --build
```

The first build takes ~3–5 minutes (it compiles better-sqlite3 against alpine + runs `next build` + `tsc` for chismoso). Subsequent rebuilds are <1 minute thanks to layer caching.

Verify everything is up:

```bash
docker compose ps
# All services should be "healthy" within ~60s.
```

---

## 6. Configure DNS

At your DNS provider, add an **A record** pointing your apex or subdomain to the server's public IP:

| Type | Host | Value | TTL |
|---|---|---|---|
| A | `chismoso` | `<server-public-IP>` | 3600 (1 hour) |
| AAAA | `chismoso` | `<server-IPv6>` (if available) | 3600 |

Wait for it to resolve:

```bash
dig +short chismoso.example.com
# Should print your server's IP within a minute.
```

---

## 7. Caddy auto-provisions HTTPS

Caddy watches for incoming requests on `chismoso.example.com` and, on first request, runs the ACME HTTP-01 challenge against Let's Encrypt. The cert lands in the `caddy_data` volume (~/.local/share/caddy/ inside the container).

Trigger the first request:

```bash
curl -fsS https://chismoso.example.com/api/livez
# {"status":"ok","timestamp":"2025-01-XX..."}
```

If you see a TLS cert error on the first request, wait 30s and retry — Caddy is still issuing. If it persists >60s, check the Caddy logs:

```bash
docker compose logs caddy | tail -50
```

Common causes:
- DNS not yet pointing at the server (Caddy can't complete the HTTP-01 challenge without a resolving A record).
- Port 80 firewalled (ACME HTTP-01 needs 80 open — even if you only serve on 443).
- Rate limit from Let's Encrypt (5 fails per account per hostname per hour — usually a misconfigured Caddyfile). Use the staging CA while debugging.

---

## 8. Verify

```bash
# Liveness (returns 200 + status=ok once Next.js is up + DB reachable)
curl -fsS https://chismoso.example.com/api/livez | jq

# Health (same as livez, plus DB SELECT 1)
curl -fsS https://chismoso.example.com/api/health | jq

# Doctor (14-subsystem readiness — 200 + summary.ok=N)
curl -fsS https://chismoso.example.com/api/doctor | jq .summary
```

All three should return `200 OK` with sensible JSON.

If `/api/doctor` reports `degraded` or `fail` checks, follow the runbook in [OPERATIONS.md](./OPERATIONS.md#doctor-failures).

---

## 9. Create your first admin agent

> **Note**: chismoso V1.5 doesn't ship with a `users add` CLI subcommand yet. Authentication is **token-based** (one token per agent / API client). See `SECURITY.md` for the threat model.

To create your first agent token (assumes `CHISMOSO_AUTH_ENABLED=true` and the stack is up):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  node chismoso/dist/cli.js auth token
```

Copy the `Hash:` field, append it to `CHISMOSO_AUTH_TOKENS` in `.env.production` (comma-separated), restart:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps app
```

Then verify a protected endpoint rejects unauthenticated calls and accepts the new token:

```bash
# Should return 401:
curl -X POST https://chismoso.example.com/api/doctor

# Should return 200:
curl -X POST -H "X-Chismoso-Agent: <plaintext-token>" \
  https://chismoso.example.com/api/doctor?fix=true
```

---

## 10. Subscribe a mesh agent (optional)

If you have remote agents pushing signals to your CHISMOSO via the mesh:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  node chismoso/dist/cli.js mesh subscribe \
    --agent="regional-bot-01" \
    --url="https://my-remote-agent.example.com/hooks/chismoso" \
    --secret="<shared-secret>"
```

The mesh config is persisted in the chismoso SQLite DB (mounted via `chismoso_data` volume). Survives restarts.

---

## 11. Set up backups

The `chismoso-backup` sidecar already runs `backup-sqlite.sh` every 6h, writing timestamped copies to the `chismoso_backups` volume. For off-site:

### Option A: S3 with GPG encryption (recommended)

```bash
# In .env.production:
BACKUP_S3_BUCKET=s3://my-chismoso-backups
BACKUP_GPG_RECIPIENT=<fingerprint-of-your-key>
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
AWS_DEFAULT_REGION=us-east-1
```

Then restart the backup sidecar:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps chismoso-backup
```

The script will `gpg --encrypt --recipient <fingerprint>` each backup before uploading to S3. The private key never leaves your workstation.

### Option B: rsync to a remote box (simple)

Add a cron on a separate machine:

```cron
0 */6 * * * rsync -az -e ssh deploy@chismoso.example.com:/var/lib/docker/volumes/chismoso_chismoso_backups/_data/ /backups/chismoso/
```

---

## CI/CD setup (optional but recommended)

The `.github/workflows/` directory contains three pipelines:

1. **ci.yml** — runs on every PR + push to `main`. Lint, typecheck, unit + e2e tests, build verification, dependency audit. **Required to pass before merge.**
2. **deploy.yml** — triggered when `ci.yml` passes on `main`. Builds the Docker image, pushes to GHCR, auto-deploys to staging, then waits for manual approval to deploy to prod.
3. **security.yml** — weekly + on push. Runs Semgrep SAST, gitleaks secrets scan, and `npm audit`.

### Setup

1. **Branch protection** (repo Settings → Branches → Add rule for `main`):
   - Require status checks to pass: `lint`, `typecheck`, `test-unit`, `test-e2e`, `build`, `security-scan`.
   - Require 2 approving reviews.
   - Require branches to be up to date before merging.
   - Dismiss stale reviews when new commits are pushed.

2. **GHCR auth** — create a PAT (or use `GITHUB_TOKEN` with `packages: write` permission via repo settings).

3. **Secrets** (repo Settings → Secrets and variables → Actions):
   - `GHCR_TOKEN`
   - `DEPLOY_SSH_KEY_STAGING`, `DEPLOY_SSH_KEY_PROD`
   - `DEPLOY_HOST_STAGING`, `DEPLOY_HOST_PROD`
   - `DEPLOY_USER_STAGING`, `DEPLOY_USER_PROD`

4. **Environments** — create `staging` (auto-deploys) and `production` (requires manual reviewers).

Once set up, the deploy workflow runs end-to-end on the next push to `main`.

---

## Troubleshooting

### Container is `unhealthy` after 60s

```bash
docker compose logs --tail=200 app
```

Most common causes:
- `chismoso_data` volume owned by root (the runtime user `nextjs:1001` can't write). Fix: `sudo chown -R 1001:1001 /var/lib/docker/volumes/chismoso_chismoso_data/`.
- Out of memory: `docker stats` — if any container is near its `memory` limit, bump `deploy.resources.limits.memory` in `docker-compose.prod.yml`.

> **Note on Postgres / Prisma**: the stack no longer ships a Postgres
> container. Prisma + Postgres were removed in Task R2-IMP-OPS (audit
> P0-15) because the Prisma schema was a placeholder skeleton never
> imported by any route. The chismoso intelligence store uses
> `better-sqlite3` exclusively against the `chismoso_data` volume. For
> horizontal scaling, operators must reintroduce an external Postgres
> (or `pglite`/`pg` abstraction) — see [OPERATIONS.md §Scaling](./OPERATIONS.md#scaling).

### Caddy returns 502/503

```bash
docker compose logs caddy | tail -50
docker compose logs app | tail -50
```

502 = Caddy can't reach `app:3000`. Check that the `app` container is `Up` and the `chismoso_net` network exists.
503 = upstream timeout (Next.js is up but the request is taking >30s — likely an LLM call stuck).

### First request takes 30s+

This is normal — Next.js standalone does a first-request JIT compile of any route that hasn't been hit yet. Subsequent requests to the same route are <100ms.

### Let's Encrypt rate limit

If you've been testing with a real domain and hit the rate limit, switch to the staging CA while debugging:

```caddyfile
chismoso.example.com {
  acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
  ...
}
```

Switch back to prod CA only when you've confirmed staging cert issuance works.

---

## Next steps

- Read [OPERATIONS.md](./OPERATIONS.md) for the day-2 runbook (logs, restarts, scaling).
- Read [UPGRADE.md](./UPGRADE.md) for the upgrade + rollback procedure.
- Read [SECURITY.md](../SECURITY.md) for the vulnerability disclosure policy.
- Configure monitoring + alerting (Sentry, status page) — see [OPERATIONS.md §Monitoring](./OPERATIONS.md#monitoring).
