# Security Policy — CHISMOSO V1.5

> How to report a vulnerability, what to expect, and what we support.

## Supported versions

CHISMOSO follows a "latest minor + previous minor" support window. Security fixes are backported to the previous minor for 90 days after the new minor ships.

| Version | Supported | Until |
|---|---|---|
| `v1.5.x` (latest) | ✅ Yes | Until `v1.6.0` ships + 90 days |
| `v1.4.x` | ✅ Yes (security only) | 90 days after `v1.5.0` ship date |
| `v1.3.x` and earlier | ❌ No | End of life |

For end-of-life versions, the only supported path is upgrading to the latest release.

---

## Reporting a vulnerability

**DO NOT open a public GitHub issue for a security vulnerability.**

### How to report

Email **security@albra.co** with:

1. A description of the vulnerability (what + why).
2. Steps to reproduce (or proof-of-concept code).
3. Affected versions (if known).
4. Suggested fix (optional but appreciated).

### PGP-encrypted reports (recommended for sensitive reports)

Encrypt your report to our security PGP key:

- **Fingerprint**: `0000 0000 0000 0000 0000 0000 0000 0000 0000 0000` (placeholder — see below)
- **Key ID**: `0x00000000`
- **Keyserver**: `keys.openpgp.org`

> ⚠️ The PGP key fingerprint above is a placeholder until we publish our actual key. Once published, it'll be signed by `security@albra.co` and listed here. Until then, send reports in plaintext — but please don't include sensitive data (passwords, tokens) in the report; reference them by name instead.

To fetch our key (once published):

```bash
gpg --keyserver keys.openpgp.org --recv-keys 0x00000000
gpg --encrypt --recipient security@albra.co --armor your-report.txt
```

### What to include

A good report lets us reproduce in <15 minutes:

- **Environment**: version, OS, Docker Engine version, deployment model (single-node, multi-node, mesh).
- **Reproduction**: minimal steps. A single-file shell script that sets up the vulnerable state is ideal.
- **Impact**: what an attacker could do (RCE, data exfil, DoS, auth bypass).
- **Disclosure preference**: do you want credit in the public advisory? (Default: yes, with your name/handle as you provide it.)

---

## Response timeline

We acknowledge reports in the order they arrive:

| Milestone | Target | What happens |
|---|---|---|
| **Ack** | within 48h | We confirm receipt, assign a tracking ID, and ask any clarifying questions. |
| **Triage** | within 7 days | We reproduce the issue, assess severity (CVSS), and decide on fix vs. mitigation. |
| **Fix or workaround** | within 30 days (high severity) or 90 days (low/medium) | We ship a patched release OR publish a workaround if a patch isn't possible in that window. |
| **Public disclosure** | with the patched release, OR 90 days after the initial report (whichever is sooner) | Coordinated disclosure — we notify you 7 days before we publish. |

### Severity scale

We use the [CVSS v3.1](https://www.first.org/cvss/) base score:

| Severity | CVSS range | Examples |
|---|---|---|
| **Critical** | 9.0 – 10.0 | RCE on a public endpoint, auth bypass |
| **High** | 7.0 – 8.9 | SQL injection (limited scope), SSRF via the reverse proxy |
| **Medium** | 4.0 – 6.9 | Stored XSS (operator-only view), info disclosure of secrets in logs |
| **Low** | 0.1 – 3.9 | Missing security header, minor DoS |

Critical + High trigger the 30-day fix target. Medium + Low the 90-day target.

---

## Disclosure policy

**Coordinated disclosure (90 days).** We publish an advisory when:

1. A patched release is available, OR
2. 90 days have passed since the initial report — whichever comes first.

We notify the reporter 7 days before public disclosure (with the advisory draft for review). If the reporter asks for more time, we'll extend up to 30 additional days (120 total) at our discretion.

**Exceptions:**
- If a vulnerability is being actively exploited in the wild, we may disclose early to protect users.
- If the reporter publishes before the coordinated date, we'll publish our advisory immediately.

---

## Threat model

CHISMOSO V1.5 is a single-tenant intelligence analysis tool. The implicit trust boundary:

| Actor | Trust level | Access |
|---|---|---|
| **Operator** (server admin) | Full | SSH, Docker, all env vars, all data. |
| **Agent** (CHISMOSO user with a token) | Authenticated | API endpoints under `/api/*` (subject to `CHISMOSO_AUTH_ENABLED`). |
| **Anonymous** (internet) | Untrusted | Edge (Caddy) only — never reaches the app directly. |
| **LLM provider** (Z.ai) | Trusted for content | Receives investigation objectives — treat as a sub-processor (see [Privacy Policy](../src/app/legal/privacy/page.tsx)). |

Out of scope:
- **Operator compromise** — if an attacker has root on the server, CHISMOSO can't defend itself.
- **Token theft** — operators are responsible for distributing tokens over secure channels (1Password, Bitwarden, signed email).
- **Vulnerable dependencies in `node_modules`** — we run `npm audit` in CI, but transitive vulns in deps we don't directly control are reported to the upstream package.

---

## Security measures in V1.5

### Process

- **Multi-stage Dockerfile** — minimal runtime image (`node:20-alpine`), no build tools, runs as non-root `nextjs:1001`.
- **`security_opt: no-new-privileges`** — kernel hardening prevents setuid escalation.
- **`tini` PID 1** — proper signal forwarding, no zombie processes.
- **Resource limits** in `docker-compose.prod.yml` — caps CPU + memory per service to prevent runaway processes from taking down the host.
- **Log rotation** — `json-file` driver with `max-size: 10m` + `max-file: 3` prevents disk-fill DoS.

### Network

- **Caddy auto-HTTPS** — Let's Encrypt certs auto-provisioned + auto-renewed.
- **HSTS + security headers** — enforced at the edge by Caddy (when configured per the audit recommendation).
- **No ports exposed externally except 80 + 443** — `app`, `postgres`, `redis` are only reachable on the `chismoso_net` Docker network.
- **`/api/livez` + `/api/health`** — unauthenticated health probes (safe to expose, no sensitive data).

### AuthN/AuthZ

- **Token-based auth middleware** (`src/lib/auth.ts` + `src/lib/middleware.ts`):
  - SHA-256 hashed tokens (never stored in plaintext).
  - Constant-time comparison (`crypto.timingSafeEqual`).
  - Opt-in via `CHISMOSO_AUTH_ENABLED=true` — defaults to off in dev.
  - Required on every POST/PUT/PATCH endpoint.
  - 401 with canonical `{error, details:{reason}}` shape on failure.

### Data

- **SQLite at `chismoso/data/`** — only the `nextjs` user has read/write. Backups in `chismoso_backups` volume, optionally GPG-encrypted + S3-offloaded.
- **Prisma DB URL** — Postgres in prod (not SQLite), username/password from `.env.production`.
- **`.env.production`** — gitignored (`.gitignore` rule `.env*`).
- **Secrets in CI** — GitHub Actions secrets, scoped per-environment.

### Audit

- **Execution trace** — every investigation writes a row per `addTool`/`addError` event, so a crash mid-run still leaves an accurate audit row.
- **Audit log** — all writes go through `withAuth` middleware, which logs the auth result + token hash (not plaintext).

---

## Known limitations (audit backlog)

These are tracked in `agent-ctx/PROD-AUDIT-*.md`. We're working through them in priority order:

- **In-memory rate-limit + cache** — single-process; bypassed by multi-instance deployments. Mitigation: stay single-instance until Postgres + Redis migration (P1).
- **`XTransformPort` query-param routing** — Caddyfile legacy handler that allows SSRF to localhost. Will be removed in the security hardening pass (PROD-SEC).
- **No source map upload to Sentry** — error reports won't have full stack traces until source map upload is configured (P1).
- **`better-sqlite3` on alpine** — native module compiled in the build stage; if the chismoso `tsc` upgrade bumps `better-sqlite3` to a version without prebuilt alpine binaries, the build will need `python3 + make + g++` installed (already done in the Dockerfile).

For the full audit, see [`agent-ctx/PROD-AUDIT-SEC.md`](../agent-ctx/PROD-AUDIT-SEC.md).

---

## Contact

- **Security reports**: security@albra.co
- **General security questions**: open a [GitHub Discussion](https://github.com/ALBRA8/AGENTE-CHISMOSO/discussions) with the `security` label.
- **PGP** (placeholder until key published): fingerprint listed above once available.

---

## Acknowledgements

We thank security researchers who report vulnerabilities responsibly. Reporters will be acknowledged in the public advisory (with their consent) unless they prefer to remain anonymous.
