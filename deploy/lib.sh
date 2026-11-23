#!/usr/bin/env bash
# Shared helpers for the scripts in deploy/. Sourced, never run on its own.
#
# Everything an operator sets lives in /etc/default/drone-fleet (written by install.sh): where the install is, where
# backups go, where alerts go. A value in the environment wins over that file.

set -euo pipefail

if [ -r /etc/default/drone-fleet ]; then
  # shellcheck disable=SC1091
  . /etc/default/drone-fleet
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$(cd "$HERE/.." && pwd)"
APP_DIR="${APP_DIR:-$RELEASE_DIR}"
ENV_FILE="$APP_DIR/infra/.env.production"
COMPOSE_FILE="$APP_DIR/infra/docker-compose.prod.yml"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/drone-fleet}"
STATE_DIR="${STATE_DIR:-/var/lib/drone-fleet}"
LOG_FILE="${LOG_FILE:-/var/log/drone-fleet.log}"

if [ -t 1 ]; then
  C_OK=$'\033[32m' C_WARN=$'\033[33m' C_BAD=$'\033[31m' C_DIM=$'\033[2m' C_END=$'\033[0m'
else
  C_OK='' C_WARN='' C_BAD='' C_DIM='' C_END=''
fi

say() { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$C_DIM" "$*" "$C_END"; }
ok() { printf '  %sok%s    %s\n' "$C_OK" "$C_END" "$*"; }
warn() { printf '  %swarn%s  %s\n' "$C_WARN" "$C_END" "$*"; }
bad() { printf '  %sFAIL%s  %s\n' "$C_BAD" "$C_END" "$*"; }
die() {
  printf '\n%sERROR:%s %s\n' "$C_BAD" "$C_END" "$*" >&2
  exit 1
}
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE" 2>/dev/null || true; }

need_root() { [ "$(id -u)" = 0 ] || die "run this as root (sudo $0 ...)"; }

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# A value from the env file, without sourcing it (values may hold spaces or #).
# Always succeeds (an unset key is an empty answer), so `x="$(env_get KEY)"` is safe under `set -e`.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n 1 | cut -d= -f2-
}

# Sets KEY=VALUE in the env file: replaces the line if it is there, appends it if not. Keeps the file root-only.
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" k "=" { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" >"$tmp"
  cat "$tmp" >"$ENV_FILE"
  rm -f "$tmp"
  chmod 600 "$ENV_FILE"
}

# True when a setting still holds the template's placeholder.
is_placeholder() {
  local v
  v="$(env_get "$1")"
  [ -z "$v" ] || [[ "$v" == change-me* ]] || [[ "$v" == *example.com* ]] || [ "$v" = "203.0.113.10" ]
}

random_secret() { openssl rand -hex "${1:-32}"; }

container_id() { { compose ps -q "$1" 2>/dev/null || true; } | head -n 1; }

# healthy / starting / unhealthy for a service with a healthcheck, running / exited / missing otherwise.
service_state() {
  local id
  id="$(container_id "$1")"
  [ -n "$id" ] || {
    echo missing
    return
  }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing
}

# Waits until every named service is healthy (or running, without a healthcheck). Fails after $1 seconds.
wait_healthy() {
  local limit="$1" started now service state all
  shift
  started="$(date +%s)"
  while true; do
    all=1
    for service in "$@"; do
      state="$(service_state "$service")"
      case "$state" in
        healthy | running) ;;
        *) all=0 ;;
      esac
    done
    [ "$all" = 1 ] && return 0
    now="$(date +%s)"
    [ $((now - started)) -ge "$limit" ] && return 1
    sleep 3
  done
}

# The API's own health answer, asked from inside its container (no port of the API is published).
api_health() {
  local id
  id="$(container_id api)"
  [ -n "$id" ] || return 1
  docker exec "$id" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(t=>{process.stdout.write(t)}).catch(()=>process.exit(1))"
}

db_user() {
  local u
  u="$(env_get POSTGRES_USER)"
  echo "${u:-dji}"
}

db_name() {
  local d
  d="$(env_get POSTGRES_DB)"
  echo "${d:-dji}"
}

# One SQL statement against the app's database (or the database named in $2), answers as plain lines.
psql_q() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$(db_user)" -d "${2:-$(db_name)}" -At -c "$1" </dev/null
}

latest_dump() { ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null | head -n 1; }

stamp() { date -u +%Y%m%d-%H%M%S; }

version_of() { cat "${1:-$APP_DIR}/VERSION" 2>/dev/null || echo unknown; }
# The certificate folder the compose file mounts (CERT_DIR, relative to infra/ unless absolute).
cert_dir() {
  local d
  d="$(env_get CERT_DIR)"
  d="${d:-./certs}"
  case "$d" in
    /*) printf '%s\n' "$d" ;;
    *) printf '%s\n' "$APP_DIR/infra/${d#./}" ;;
  esac
}
