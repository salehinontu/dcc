#!/usr/bin/env bash
# Vendor side: packs a release to take to a customer's server.
#
#   deploy/release.sh                 # source release: drone-fleet-<version>.tar.gz + .sha256 (the server builds it)
#   deploy/release.sh --with-images   # also the built images, for a server without internet (needs Docker here)
#
# The version comes from the VERSION file. Settings, certificates, local data and development files are never
# included. Output goes to ./releases/.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="$(cat VERSION)"
NAME="drone-fleet-$VERSION"
OUT="$ROOT/releases"
WITH_IMAGES=0
[ "${1:-}" = --with-images ] && WITH_IMAGES=1

mkdir -p "$OUT"
stage="$(mktemp -d)/$NAME"
mkdir -p "$stage"
# Every file git knows, and new ones not yet committed, minus what must never travel.
git ls-files --cached --others --exclude-standard -z |
  grep -zvE '^(infra/\.env\.production$|infra/certs/|infra/branding/|\.data/|releases/|node_modules/|apps/[^/]+/dist/|\.github/|tools/e2e/|\.claude/|\.opencode/|\.vscode/|CLAUDE\.md$|AGENTS\.md$)' |
  while IFS= read -r -d '' file; do
    # Only the guides a customer's team uses; internal papers (security reports, plans, tenders) stay home.
    case "$file" in
      docs/user-manual.md | docs/operator-guide.md | docs/on-premise.md | docs/deployment.md | docs/client-install.md | docs/api.md | \
        docs/access-control.md | docs/tutorial-bn.md | docs/hardware-bring-up.md | docs/rc-login.md | docs/screenshots/*) ;;
      docs/*) continue ;;
    esac
    [ -f "$file" ] && printf '%s\0' "$file"
  done |
  tar --null -T - -cf - | tar -xf - -C "$stage"
# A file that must not be there, if it ever was: the build would ship a secret.
for forbidden in infra/.env.production infra/certs/privkey.pem .env; do
  [ ! -e "$stage/$forbidden" ] || { echo "refusing: $forbidden would be in the release" >&2; exit 1; }
done

if [ "$WITH_IMAGES" = 1 ]; then
  command -v docker >/dev/null 2>&1 || { echo "--with-images needs Docker on this machine" >&2; exit 1; }
  env_file="$(mktemp)"
  cp infra/.env.production.example "$env_file"
  docker compose --env-file "$env_file" -f infra/docker-compose.prod.yml build api web
  docker compose --env-file "$env_file" -f infra/docker-compose.prod.yml pull postgres emqx srs
  docker save dji-fleet-prod-api dji-fleet-prod-web postgres:16-alpine emqx/emqx:5.8.0 ossrs/srs:6 |
    gzip -1 >"$stage/images-$VERSION.tar.gz"
  rm -f "$env_file"
fi

tar czf "$OUT/$NAME.tar.gz" -C "$(dirname "$stage")" "$NAME"
rm -rf "$(dirname "$stage")"
(cd "$OUT" && shasum -a 256 "$NAME.tar.gz" >"$NAME.tar.gz.sha256")
echo "Release $VERSION: $OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"
echo "Checksum:        $OUT/$NAME.tar.gz.sha256"
