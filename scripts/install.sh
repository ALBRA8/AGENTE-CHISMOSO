#!/usr/bin/env bash
# =============================================================================
# CHISMOSO V1.5 — one-shot install on a fresh server
# Task IMP-PROD-OPS, audit PROD-AUDIT-OPS P0-10.
#
# Usage (as root or sudo-capable user):
#   curl -fsSL https://raw.githubusercontent.com/ALBRA8/AGENTE-CHISMOSO/main/scripts/install.sh | sudo bash
#
# Or, on a clone of the repo:
#   sudo bash scripts/install.sh
#
# What it does:
#   1. Detect OS (Ubuntu/Debian/CentOS/RHEL).
#   2. Install Docker + Docker Compose if missing.
#   3. Clone the repo to /opt/chismoso (or use the current dir if invoked from
#      a clone).
#   4. Copy .env.production.example → .env.production, prompt for required
#      secrets interactively.
#   5. docker compose up -d --build.
#   6. Print URL + admin instructions.
#
# Idempotent: re-running detects existing install + skips setup steps.
# =============================================================================
set -euo pipefail

# --- Output helpers ----------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
err()  { printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
die()  { err "$*"; exit 1; }

# --- Detect OS ---------------------------------------------------------------
detect_os() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    echo "${ID:-unknown}"
  else
    die "Cannot detect OS — /etc/os-release missing. Edit scripts/install.sh to support your platform."
  fi
}

OS_ID="$(detect_os)"
log "Detected OS: ${OS_ID}"

case "${OS_ID}" in
  ubuntu|debian)
    PKG_MGR="apt-get"
    PKG_INSTALL="apt-get update -y && apt-get install -y"
    ;;
  centos|rhel|fedora|rocky|almalinux)
    PKG_MGR="dnf"
    PKG_INSTALL="dnf install -y"
    ;;
  *)
    die "Unsupported OS: ${OS_ID}. Edit scripts/install.sh to support your platform."
    ;;
esac

# --- Must be root ------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  die "This script must run as root. Try: sudo bash scripts/install.sh"
fi

INSTALL_DIR="${INSTALL_DIR:-/opt/chismoso}"
REPO_URL="${REPO_URL:-https://github.com/ALBRA8/AGENTE-CHISMOSO.git}"
RELEASE_TAG="${RELEASE_TAG:-v1.5.0}"

# --- Step 1: install Docker + Docker Compose ---------------------------------
install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker + Docker Compose already installed:"
    docker --version
    docker compose version
    return 0
  fi

  log "Installing Docker via convenience script (get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  log "Docker installed: $(docker --version)"
}

install_docker

# --- Step 2: clone (or use existing) repo -----------------------------------
clone_repo() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Repo already cloned at ${INSTALL_DIR} — fetching + checking out ${RELEASE_TAG}."
    cd "${INSTALL_DIR}"
    git fetch --tags --quiet
    git checkout "${RELEASE_TAG}" 2>/dev/null || {
      log "Tag ${RELEASE_TAG} not found — staying on current branch."
      git log -1 --oneline
    }
    return 0
  fi

  log "Cloning ${REPO_URL} → ${INSTALL_DIR}…"
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  git clone --branch "${RELEASE_TAG}" --depth 1 "${REPO_URL}" "${INSTALL_DIR}" 2>/dev/null || {
    # --branch fails if the tag doesn't exist on a shallow clone. Fall back to
    # cloning main + checking out the tag.
    git clone "${REPO_URL}" "${INSTALL_DIR}"
    cd "${INSTALL_DIR}"
    git fetch --tags --quiet
    git checkout "${RELEASE_TAG}"
  }
  cd "${INSTALL_DIR}"
  log "Repo checked out at $(git describe --tags --always 2>/dev/null || echo 'unknown')."
}

clone_repo
cd "${INSTALL_DIR}"

# --- Step 3: write .env.production (interactive) ----------------------------
setup_env() {
  local env_file="${INSTALL_DIR}/.env.production"
  if [[ -f "${env_file}" ]]; then
    log ".env.production already exists — leaving it untouched."
    log "If you want to reconfigure, delete it and re-run this script."
    return 0
  fi

  log "Copying .env.production.example → .env.production"
  cp .env.production.example "${env_file}"
  chmod 600 "${env_file}"

  # Interactive prompts for the most critical secrets.
  echo
  echo "==============================================================="
  echo " CHISMOSO — interactive setup"
  echo "==============================================================="
  echo "Fill in the following secrets. Press <Enter> to keep the example value."
  echo

  prompt_value() {
    local var_name="$1"
    local prompt="$2"
    local is_secret="${3:-false}"
    local current
    current=$(grep "^${var_name}=" "${env_file}" 2>/dev/null | head -1 | cut -d= -f2-)
    if [[ "${is_secret}" == "true" ]]; then
      read -r -s -p "  ${prompt} [hidden]: " value </dev/tty
      echo
    else
      read -r -p "  ${prompt} [${current}]: " value </dev/tty
    fi
    if [[ -n "${value}" ]]; then
      # Use a delimiter that won't be confused with sed's regex. `|` is rare
      # in random base64 strings but to be safe we escape it.
      local escaped
      escaped=$(printf '%s\n' "${value}" | sed 's/[&/\]/\\&/g')
      if grep -q "^${var_name}=" "${env_file}"; then
        sed -i "s|^${var_name}=.*|${var_name}=${escaped}|" "${env_file}"
      else
        printf '%s=%s\n' "${var_name}" "${value}" >> "${env_file}"
      fi
    fi
  }

  prompt_value "POSTGRES_PASSWORD" "Postgres password (used by DB + DATABASE_URL)" true
  if [[ -z "$(grep '^POSTGRES_PASSWORD=[^ ]' "${env_file}")" ]]; then
    # Auto-generate a random password if the user left it blank.
    local pw
    pw=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)
    sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${pw}|" "${env_file}"
    sed -i "s|postgresql://chismoso:CHANGE_ME@postgres|postgresql://chismoso:${pw}@postgres|" "${env_file}"
    log "Auto-generated POSTGRES_PASSWORD."
  else
    # Sync DATABASE_URL to use the password the user typed.
    local pw
    pw=$(grep '^POSTGRES_PASSWORD=' "${env_file}" | cut -d= -f2-)
    sed -i "s|postgresql://chismoso:.*@postgres|postgresql://chismoso:${pw}@postgres|" "${env_file}"
  fi

  prompt_value "CHISMOSO_JWT_SECRET" "JWT secret (signs short-lived JWTs)" true
  if [[ -z "$(grep '^CHISMOSO_JWT_SECRET=[^ ]' "${env_file}")" ]]; then
    local jwt
    jwt=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64)
    sed -i "s|^CHISMOSO_JWT_SECRET=.*|CHISMOSO_JWT_SECRET=${jwt}|" "${env_file}"
    log "Auto-generated CHISMOSO_JWT_SECRET."
  fi

  prompt_value "CHISMOSO_DOMAIN" "Public domain (e.g. chismoso.example.com)"
  prompt_value "CHISMOSO_CORS_ORIGINS" "Allowed CORS origins (https://chismoso.example.com)"

  echo
  echo "Done. Other optional vars (SENTRY_DSN, BACKUP_*) can be set later by"
  echo "editing ${env_file}."
  echo "==============================================================="
}

setup_env

# --- Step 4: docker compose up ----------------------------------------------
log "Building + starting the stack…"
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  up -d --build

log "Waiting for app to come up…"
for i in {1..30}; do
  if docker compose exec -T app curl -fsS http://127.0.0.1:3000/api/livez >/dev/null 2>&1 \
      || docker compose exec -T app curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    log "✓ App is up."
    break
  fi
  sleep 2
done

# --- Step 5: print admin instructions ---------------------------------------
DOMAIN=$(grep '^CHISMOSO_DOMAIN=' "${INSTALL_DIR}/.env.production" | cut -d= -f2-)
DOMAIN="${DOMAIN:-localhost}"

echo
echo "==============================================================="
echo " ✓ CHISMOSO installed successfully"
echo "==============================================================="
echo
echo " Stack status:"
docker compose -f "${INSTALL_DIR}/docker-compose.yml" -f "${INSTALL_DIR}/docker-compose.prod.yml" ps --format 'table {{.Name}}\t{{.Status}}'
echo
echo " Next steps:"
echo
echo " 1. Point your DNS A record for ${DOMAIN} at this server's public IP."
echo
echo " 2. Wait for DNS to propagate (dig +short ${DOMAIN})."
echo
echo " 3. Hit the health endpoint to trigger Caddy's first Let's Encrypt cert:"
echo "      curl -fsS https://${DOMAIN}/api/livez"
echo
echo " 4. Generate your first auth token:"
echo "      docker compose -f ${INSTALL_DIR}/docker-compose.yml \\"
echo "        -f ${INSTALL_DIR}/docker-compose.prod.yml exec app \\"
echo "        node chismoso/dist/cli.js auth token"
echo "    Then append the hash to CHISMOSO_AUTH_TOKENS in .env.production"
echo "    and restart the app."
echo
echo " 5. Read the docs:"
echo "      - ${INSTALL_DIR}/docs/DEPLOYMENT.md"
echo "      - ${INSTALL_DIR}/docs/OPERATIONS.md"
echo "      - ${INSTALL_DIR}/SECURITY.md"
echo
echo " Done. The app is reachable at https://${DOMAIN} once DNS + cert land."
echo "==============================================================="
