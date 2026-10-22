# Upgrade Guide — CHISMOSO V1.5

> How to safely upgrade CHISMOSO V1.5 from one release to the next, including rollback. For fresh installs see [DEPLOYMENT.md](./DEPLOYMENT.md). For day-2 ops see [OPERATIONS.md](./OPERATIONS.md).

---

## Pre-upgrade checklist

### 1. Read the release notes

Every release ships with a `CHANGELOG.md` entry (or a GitHub Release body). Pay special attention to:

- **Breaking changes** — marked with 💥. These may require env var changes, schema migration, or config file edits.
- **Deprecations** — features marked deprecated will be removed in the next major release.
- **Required migrations** — schema changes that need chismoso `doctor --fix`.

### 2. Verify the version you're on

```bash
cd /opt/chismoso
git describe --tags --always
# v1.5.0
```

Compare against the [Releases page](https://github.com/ALBRA8/AGENTE-CHISMOSO/releases). If your `git describe` shows a commit hash (not a tag), you're on `main` — **pin to the nearest release tag before upgrading**.

### 3. Check the upgrade path

| From | To | Notes |
|---|---|---|
| `v1.5.0` | `v1.5.x` (patch) | Safe to upgrade in place. No schema changes. |
| `v1.5.x` | `v1.6.0` (minor) | Check release notes for new env vars + schema migrations. |
| `v1.6.x` | `v2.0.0` (major) | Follow the dedicated upgrade guide in the release notes. Major versions may have breaking schema changes. |
| `v1.4.x` | `v1.5.0` | Run `chismoso doctor --fix` after upgrade to apply schema migrations (SCHEMA_V3 → V5). |

### 4. Backup the DB

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  exec app /opt/scripts/backup-sqlite.sh
```

Confirm the backup landed:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  exec chismoso-backup ls -lh /data/backups/ | tail -5
```

### 5. Snapshot the host (optional, recommended for prod)

If your host supports snapshots (DigitalOcean, AWS EC2, Hetzner), take one now. This is your last-resort rollback if everything else fails.

### 6. Notify users

For production upgrades, post a maintenance window in your status page + IM channel:

> "CHISMOSO prod upgrade window: <date> <start>–<end> UTC. Expected downtime: <30s – 2min>."

---

## Upgrade procedure

### Option A: `upgrade.sh` (recommended for self-hosted)

```bash
cd /opt/chismoso
git fetch --tags
git checkout v1.5.1   # or whatever new release you're targeting

bash scripts/upgrade.sh
```

The script does:

1. `git pull` (already done by you checking out the tag).
2. `docker compose -f docker-compose.yml -f docker-compose.prod.yml build` — rebuilds the image.
3. `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` — recreates changed containers.
4. `sleep 10` — gives Next.js time to boot.
5. `curl -f http://localhost:3000/api/livez` — smoke test.
6. If the smoke test fails → `git checkout HEAD~1` (back to previous tag) + rebuild + restart + exit 1.

### Option B: Manual (when you need more control)

```bash
cd /opt/chismoso

# 1. Pull the new code
git fetch --tags
git checkout v1.5.1

# 2. Pull any new env vars
diff <(grep -v '^#' .env.production | sort) <(grep -v '^#' .env.production.example | sort)
# If there are new vars in .env.production.example, copy them to .env.production
nano .env.production

# 3. Build the new image
docker compose -f docker-compose.yml -f docker-compose.prod.yml build app chismoso-scheduler chismoso-backup

# 4. Apply chismoso schema migrations (idempotent — SQLite-only)
#    NOTE: Prisma + Postgres were removed in Task R2-IMP-OPS (audit P0-15).
#    The only remaining migration path is the chismoso `doctor --fix` flow
#    against the better-sqlite3 store at CHISMOSO_DB_PATH.
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm \
  --entrypoint node app chismoso/dist/cli.js doctor --fix

# 5. Recreate containers with the new image
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps app chismoso-scheduler chismoso-backup

# 6. Wait for boot + verify
sleep 10
curl -fsS http://localhost:3000/api/livez || (echo "FAILED — see rollback below"; exit 1)
curl -fsS http://localhost:3000/api/doctor | jq .summary
```

### DB migrations

**chismoso (better-sqlite3)** — schema migrations are baked into the `doctor --fix` flow:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec app \
  node chismoso/dist/cli.js doctor --fix
```

The doctor runs `CREATE TABLE IF NOT EXISTS ...` for any new tables + adds missing columns to existing tables (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). It's safe to run on every upgrade. It's also idempotent — re-running on a healthy DB is a no-op.

The current schema version is `SCHEMA_V5` (see `chismoso/src/db.ts` for the constant).

> **Note on Postgres**: Prisma + Postgres were removed from the stack in Task
> R2-IMP-OPS (audit P0-15) because the Prisma schema was a placeholder
> skeleton (`User`/`Post` from create-next-app) never imported by any route.
> If your deployment has already introduced a real Postgres-backed Prisma
> schema, run your own `prisma migrate deploy` against it; for fresh deploys
> there is nothing to do.

### Verify post-upgrade

```bash
# Liveness
curl -fsS https://<domain>/api/livez
# → {"status":"ok",...}

# Health (DB-aware)
curl -fsS https://<domain>/api/health | jq
# → status=ok, db=reachable

# Readiness (14-subsystem)
curl -fsS https://<domain>/api/doctor | jq
# → overall_status=OK, summary.fail=0

# Version
curl -fsS https://<domain>/api/version
# → should match the new release tag
```

If everything is green, post the all-clear in your status page.

---

## Rollback

### Quick rollback (within 5 min of the failed upgrade)

If `upgrade.sh` itself detected the failure, it already rolled back automatically — just verify:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
curl -fsS http://localhost:3000/api/health | jq
```

If you did the upgrade manually and noticed the failure later:

```bash
# 1. Stop the broken app
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop app chismoso-scheduler chismoso-backup

# 2. Check out the previous release tag
cd /opt/chismoso
git checkout v1.5.0   # or whatever you were on before

# 3. Rebuild the previous image
docker compose -f docker-compose.yml -f docker-compose.prod.yml build app

# 4. Restore the pre-upgrade backup (if schema migrations ran)
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm \
  --entrypoint sh app \
  -c "cp /data/backups/<pre-upgrade-timestamp>.db /data/chismoso.db"

# 5. Recreate containers with the rolled-back image
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps app chismoso-scheduler chismoso-backup

# 6. Verify
sleep 10
curl -fsS http://localhost:3000/api/doctor | jq .summary
```

### Rollback to a known-good Docker image

If you used the CD pipeline, every push to `main` produced a tagged image at `ghcr.io/albra8/agente-chismoso:<sha>`. To roll back to a specific commit:

```bash
docker pull ghcr.io/albra8/agente-chismoso:<previous-sha>
docker tag ghcr.io/albra8/agente-chismoso:<previous-sha> chismoso:local
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps app
```

This is faster than rebuilding from source.

### Rollback caveats

- **Schema migrations are not auto-rolled-back.** If the new release added a column to the chismoso SQLite DB, rolling back to the old code is fine — the old code will just ignore the extra column. But if the new release **renamed** or **dropped** a column, the old code may fail. In that case, you **must** restore the pre-upgrade backup (Step 4 above).

---

## Post-upgrade

1. **Verify** — see §Verify post-upgrade above.
2. **Update the runbook** — if the new release added new env vars, subcommands, or operational considerations, update [OPERATIONS.md](./OPERATIONS.md) accordingly.
3. **Close the maintenance window** — post the all-clear in your status page + IM channel.
4. **Run the doctor** — even if the upgrade was uneventful, run `curl -X POST -H "X-Chismoso-Agent: <token>" https://<domain>/api/doctor?fix=true` to make sure no subsystem silently degraded during the upgrade.
5. **Watch the logs for 1 hour** — `docker compose logs -f --since 1h app chismoso-scheduler`. Look for any new error patterns that didn't exist pre-upgrade.

---

## Special-case upgrades

### Upgrading to a major version (e.g. v1.x → v2.0)

Major versions have their own upgrade guide in the GitHub release body. They may include:

- **Data migrations** — scripts that transform existing rows (e.g. rename a column, normalize a value).
- **Config breaking changes** — env vars renamed or removed.
- **Downtime** — major versions may require the app to be down for several minutes during the migration.

Always read the major-version upgrade guide end-to-end before starting. Test it on a staging copy of your prod DB first.

### Upgrading the host OS

If you're upgrading Ubuntu 22.04 → 24.04 (or any other major OS upgrade):

1. **Snapshot the host**.
2. Stop the CHISMOSO stack: `docker compose down` (don't `docker compose down -v` — that nukes volumes).
3. Upgrade the OS per the Ubuntu release notes.
4. Verify Docker is still working: `docker ps -a` should show all containers (stopped).
5. `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`.
6. Verify health (see §Verify post-upgrade).

### Upgrading Docker Engine

```bash
sudo apt update
sudo apt install --only-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker --version
docker compose version
# No need to restart containers — the new daemon picks them up.
```

If you skip a major Docker version (e.g. 20.x → 25.x), read the Docker release notes — sometimes the daemon config syntax changes (e.g. `~/.docker/config.json`).
