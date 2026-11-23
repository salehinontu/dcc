#!/usr/bin/env bash
#
# One-command launcher: installs anything missing (Node, pnpm, workspace dependencies,
# MediaMTX, .env) and then starts the development stack.
#
#   ./run.sh          full host stack (broker, API, MediaMTX, dashboard, simulator)
#   ./run.sh --core   broker, API and simulator only
#   ./run.sh --docker full Docker stack (Postgres, EMQX, SRS, API, Vite, simulator)
#
# On Windows run it from Git Bash. Anything already present is left untouched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PNPM_VERSION="10.20.0"
MEDIAMTX_VERSION="1.21.2"
MIN_NODE_MAJOR=22

log() { printf '[run] %s\n' "$*"; }
warn() { printf '[run] warning: %s\n' "$*" >&2; }
die() { printf '[run] error: %s\n' "$*" >&2; exit 1; }

# Docker mode does not install Node, pnpm or MediaMTX. The preflight is optional when
# Node happens to be available.
if [ "${1:-}" = "--docker" ]; then
  shift
  command -v docker >/dev/null 2>&1 ||
    die "Docker is required; install Docker Desktop or Docker Engine and retry"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
  docker compose version >/dev/null 2>&1 ||
    die "the Docker Compose plugin is required (docker compose version failed)"
  running="$(docker compose -f infra/docker-compose.dev.yml ps --services --status running 2>/dev/null || true)"
  if [ -n "$running" ]; then
    log "the Docker dev stack is already running; skipping the preflight"
  elif command -v node >/dev/null 2>&1; then
    log "running the Docker dev preflight checks"
    node tools/docker/preflight.mjs --dev || die "preflight failed; fix the errors above"
  else
    log "node is not installed; skipping the optional preflight"
  fi
  log "opening the Docker dev stack — dashboard on http://localhost:5174"
  exec docker compose -f infra/docker-compose.dev.yml watch "$@"
fi

platform() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) echo windows ;;
    Linux) echo linux ;;
    Darwin) echo darwin ;;
    *) echo unknown ;;
  esac
}

arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo amd64 ;;
    arm64 | aarch64) echo arm64 ;;
    *) echo unknown ;;
  esac
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
      log "node $(node -v) is installed"
      return
    fi
    die "node $(node -v) is too old; this project needs Node $MIN_NODE_MAJOR or newer"
  fi

  log "node is not installed; attempting to install it"
  case "$(platform)" in
    windows)
      command -v winget >/dev/null 2>&1 ||
        die "install Node $MIN_NODE_MAJOR+ from https://nodejs.org and rerun"
      winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
      export PATH="/c/Program Files/nodejs:$PATH"
      ;;
    darwin)
      command -v brew >/dev/null 2>&1 ||
        die "install Node $MIN_NODE_MAJOR+ from https://nodejs.org and rerun"
      brew install node@22
      export PATH="$(brew --prefix node@22)/bin:$PATH"
      ;;
    *)
      die "install Node $MIN_NODE_MAJOR+ from https://nodejs.org and rerun"
      ;;
  esac

  command -v node >/dev/null 2>&1 ||
    die "node was installed but is not on PATH; open a new shell and rerun"
  log "node $(node -v) installed"
}

ensure_pnpm() {
  # Also checks that the command actually runs: a stale nvm/corepack shim can exist
  # without a pnpm behind it.
  if command -v pnpm >/dev/null 2>&1 && pnpm -v >/dev/null 2>&1; then
    log "pnpm $(pnpm -v) is installed"
    return
  fi

  log "pnpm is missing or not working; installing pnpm $PNPM_VERSION"
  if command -v npm >/dev/null 2>&1 && npm install -g "pnpm@$PNPM_VERSION"; then
    :
  elif command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare "pnpm@$PNPM_VERSION" --activate
  else
    die "cannot install pnpm: neither npm nor corepack is available"
  fi

  command -v pnpm >/dev/null 2>&1 && pnpm -v >/dev/null 2>&1 ||
    die "pnpm was installed but is not usable in this shell; open a new shell and rerun"
  log "pnpm $(pnpm -v) installed"
}

ensure_env() {
  if [ -f .env ]; then
    log ".env is present"
    return
  fi
  [ -f .env.example ] || die ".env and .env.example are both missing"
  cp .env.example .env
  log "created .env from .env.example (edit it before using real hardware)"
}

ensure_deps() {
  # Skip only when the install is complete and the lockfile has not changed since.
  if [ -d node_modules/.pnpm ] && [ -f node_modules/.pnpm/lock.yaml ] &&
    [ ! pnpm-lock.yaml -nt node_modules/.pnpm/lock.yaml ]; then
    log "workspace dependencies are up to date"
    return
  fi
  log "installing workspace dependencies"
  pnpm install --frozen-lockfile
}

ensure_mediamtx() {
  local os arch bin legacy asset archive url tmp
  os="$(platform)"
  arch="$(arch)"
  bin=".data/mediamtx/mediamtx"
  legacy="tools/media/mediamtx/mediamtx"
  if [ "$os" = "windows" ]; then
    bin="$bin.exe"
    legacy="$legacy.exe"
  fi

  if [ -f "$bin" ]; then
    log "MediaMTX is installed"
    return
  fi

  # Older checkouts kept the binary under tools/. Move it unless it is in use.
  if [ -f "$legacy" ]; then
    mkdir -p .data/mediamtx
    if mv "$legacy" "$bin" 2>/dev/null; then
      [ "$os" = "windows" ] || chmod +x "$bin"
      log "moved MediaMTX into .data/mediamtx"
      return
    fi
    log "MediaMTX is running from the legacy path; it will move on the next start"
    return
  fi

  if [ "$os" = "unknown" ] || [ "$arch" = "unknown" ]; then
    warn "unknown platform; skipping MediaMTX (video will be disabled)"
    return
  fi

  asset="mediamtx_v${MEDIAMTX_VERSION}_${os}_${arch}"
  archive="$asset.tar.gz"
  [ "$os" = "windows" ] && archive="$asset.zip"
  url="https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/${archive}"
  tmp=".data/$archive"

  log "downloading MediaMTX v$MEDIAMTX_VERSION"
  mkdir -p .data/mediamtx
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$tmp" || {
      warn "could not download MediaMTX; continuing without video"
      rm -f "$tmp"
      return
    }
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$tmp" || {
      warn "could not download MediaMTX; continuing without video"
      rm -f "$tmp"
      return
    }
  else
    warn "neither curl nor wget is available; continuing without video"
    return
  fi

  if [ "$os" = "windows" ]; then
    if command -v unzip >/dev/null 2>&1; then
      unzip -oq "$tmp" -d .data/mediamtx
    else
      powershell.exe -NoProfile -Command \
        "Expand-Archive -LiteralPath '$(cygpath -w "$tmp")' -DestinationPath '$(cygpath -w .data/mediamtx)' -Force"
    fi
  else
    tar -xzf "$tmp" -C .data/mediamtx
    chmod +x "$bin"
  fi

  rm -f "$tmp"
  log "MediaMTX installed"
}

ensure_people_model() {
  # About 217 MB, once. Without it the dashboard still runs; only people counting is off.
  pnpm models:fetch || warn "the people-counting model could not be installed; counting stays off"
}

ensure_node
ensure_pnpm
ensure_env
ensure_deps
ensure_mediamtx
ensure_people_model

if [ "${1:-}" = "--core" ]; then
  log "starting the core stack (broker, API, simulator)"
  exec pnpm dev:core
fi

log "starting the full stack — dashboard on http://localhost:5173"
exec pnpm dev
