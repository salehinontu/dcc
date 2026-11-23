#!/usr/bin/env bash
# Upgrades an install to the release this script belongs to, safely:
#   snapshot (backup, code, images) -> copy the new code -> build -> test the database change on a copy ->
#   test the Nginx config -> switch -> check -> roll back by itself if the new version does not come up healthy.
#
#   sudo /path/to/new-release/deploy/upgrade.sh [--app-dir /opt/drone-fleet] [--yes]
#
# Run from the new release's folder (unpacked next to the install), or from the install itself after its code was
# replaced by hand. Nothing the customer set is touched: settings, certificates, logo, data and videos stay.
# Going back later: deploy/rollback.sh.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
. "$HERE/lib.sh"
need_root

YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir) APP_DIR="$(cd "$2" && pwd)"; ENV_FILE="$APP_DIR/infra/.env.production"; COMPOSE_FILE="$APP_DIR/infra/docker-compose.prod.yml"; shift ;;
    --yes | -y) YES=1 ;;
    -h | --help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
[ -f "$ENV_FILE" ] || die "no install at $APP_DIR (no infra/.env.production); install it with deploy/install.sh"

FROM="$(cat "$STATE_DIR/version" 2>/dev/null || version_of "$APP_DIR")"
TO="$(version_of "$RELEASE_DIR")"
STAMP="$(stamp)"
say "Upgrade $APP_DIR: $FROM -> $TO (snapshot $STAMP)"
if [ "$YES" != 1 ] && [ -t 0 ]; then
  read -r -p "Go on? [y/N] " answer
  [[ "$answer" =~ ^[yY] ]] || die "nothing was changed"
fi

# --- 1. snapshot: everything needed to come back ---------------------------------------------------------------
step "Snapshot"
/usr/local/bin/drone-fleet-backup 2>/dev/null || APP_DIR="$APP_DIR" "$APP_DIR/infra/backup.sh"
ok "database, screenshots and settings backed up"
mkdir -p "$BACKUP_DIR" "$STATE_DIR/rollback"
code_parts=()
for part in apps packages tools docs deploy infra VERSION package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json run.sh README.md CLAUDE.md; do
  [ -e "$APP_DIR/$part" ] && code_parts+=("$part")
done
tar czf "$BACKUP_DIR/code-$STAMP.tgz" --exclude=node_modules --exclude=dist --exclude=.data \
  --exclude=infra/.env.production --exclude=infra/certs --exclude=infra/branding -C "$APP_DIR" "${code_parts[@]}"
ok "code saved: $BACKUP_DIR/code-$STAMP.tgz"
image_of() {
  local id
  id="$(container_id "$1")"
  [ -n "$id" ] && docker inspect -f '{{.Config.Image}}' "$id"
}
API_IMAGE="$(image_of api || true)"
WEB_IMAGE="$(image_of web || true)"
[ -n "$API_IMAGE" ] && [ -n "$WEB_IMAGE" ] || die "the install is not running: start it first (docker compose ... up -d)"
API_IMAGE="${API_IMAGE%:latest}"
WEB_IMAGE="${WEB_IMAGE%:latest}"
docker tag "$API_IMAGE:latest" "$API_IMAGE:pre-$STAMP"
docker tag "$WEB_IMAGE:latest" "$WEB_IMAGE:pre-$STAMP"
cat >"$STATE_DIR/rollback/$STAMP.env" <<REC
STAMP=$STAMP
VERSION_FROM=$FROM
VERSION_TO=$TO
CODE_TAR=$BACKUP_DIR/code-$STAMP.tgz
API_IMAGE=$API_IMAGE
WEB_IMAGE=$WEB_IMAGE
REC
ok "images kept as $API_IMAGE:pre-$STAMP and $WEB_IMAGE:pre-$STAMP"
log "upgrade $FROM -> $TO: snapshot $STAMP"

rollback_now() {
  bad "$1"
  say "  Rolling back to $FROM ..."
  "$APP_DIR/deploy/rollback.sh" "$STAMP" --yes || "$RELEASE_DIR/deploy/rollback.sh" "$STAMP" --yes
  die "the upgrade to $TO failed and was rolled back ($1). Logs: deploy/support-bundle.sh"
}

# --- 2. the new code ---------------------------------------------------------------------------------------------
step "New code"
if [ "$RELEASE_DIR" != "$APP_DIR" ]; then
  for dir in apps packages tools docs deploy; do
    [ -d "$RELEASE_DIR/$dir" ] && rsync -a --delete --exclude=node_modules --exclude=dist --exclude=.data \
      "$RELEASE_DIR/$dir/" "$APP_DIR/$dir/"
  done
  rsync -a --exclude=.env.production --exclude=certs/ --exclude=branding/ "$RELEASE_DIR/infra/" "$APP_DIR/infra/"
  for file in VERSION package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json run.sh README.md CLAUDE.md; do
    [ -f "$RELEASE_DIR/$file" ] && cp "$RELEASE_DIR/$file" "$APP_DIR/$file"
  done
  ok "copied into $APP_DIR (settings, certificates and logo untouched)"
else
  ok "running in place: the code in $APP_DIR is the new one"
fi
missing="$(comm -23 <(grep -oE '^[A-Z_]+=' "$APP_DIR/infra/.env.production.example" | sort -u) <(grep -oE '^[A-Z_]+=' "$ENV_FILE" | sort -u) | tr -d '=' | tr '\n' ' ')"
[ -n "${missing// /}" ] && warn "new settings this version knows (defaults apply until set): $missing"
env_set APP_VERSION "$TO"

# --- 3. build and test, with the running site untouched ----------------------------------------------------------
step "Build (the site keeps running)"
LOADED=0
if ls "$RELEASE_DIR"/images-*.tar* >/dev/null 2>&1; then
  for archive in "$RELEASE_DIR"/images-*.tar*; do
    case "$archive" in
      *.gz) gunzip -c "$archive" | docker load >/dev/null ;;
      *) docker load -i "$archive" >/dev/null ;;
    esac
  done
  LOADED=1
  ok "images loaded from the release"
else
  compose build api web >"$STATE_DIR/upgrade-build.log" 2>&1 || {
    tail -n 25 "$STATE_DIR/upgrade-build.log"
    die "the build failed; nothing was switched (log: $STATE_DIR/upgrade-build.log). The old version still runs."
  }
  ok "images built"
fi

step "The database change, tried on a copy first"
DUMP="$(latest_dump)"
scratch="drone_fleet_upgrade_$$"
psql_q "CREATE DATABASE $scratch" postgres >/dev/null
gunzip -c "$DUMP" | compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U "$(db_user)" -d "$scratch" >/dev/null
for pass in 1 2; do
  if ! compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U "$(db_user)" -d "$scratch" <"$APP_DIR/apps/api/schema.sql" >"$STATE_DIR/upgrade-schema.log" 2>&1; then
    psql_q "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" postgres >/dev/null || true
    tail -n 10 "$STATE_DIR/upgrade-schema.log"
    die "the new database schema fails on a copy of the data (run $pass); nothing was switched. The old version still runs."
  fi
done
psql_q "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" postgres >/dev/null
ok "applied twice to a copy of today's data without error"

step "Nginx config of the new web image"
domain="$(env_get APP_DOMAIN)"
certs="$(cert_dir)"
if ! docker run --rm -e APP_DOMAIN="$domain" -e APP_DOMAIN_ALIASES="$(env_get APP_DOMAIN_ALIASES)" -v "$certs":/etc/nginx/certs:ro \
  -v "$APP_DIR/infra/nginx/rtmps.conf":/etc/nginx/stream.d/rtmps.conf:ro --entrypoint sh "$WEB_IMAGE:latest" \
  -c '/docker-entrypoint.d/20-envsubst-on-templates.sh >/dev/null 2>&1; nginx -t' >"$STATE_DIR/upgrade-nginx.log" 2>&1; then
  cat "$STATE_DIR/upgrade-nginx.log"
  die "the new Nginx configuration is invalid; nothing was switched. The old version still runs."
fi
ok "nginx -t passes with this server's certificate"

# --- 4. switch and check -------------------------------------------------------------------------------------------
step "Switch"
compose up -d --no-build >"$STATE_DIR/upgrade-up.log" 2>&1 || rollback_now "the new containers did not start"
wait_healthy 300 postgres emqx api web || rollback_now "a service did not become healthy"
for _ in $(seq 1 30); do
  health="$(api_health 2>/dev/null || true)"
  case "$health" in *'"mqtt":true'*) break ;; esac
  sleep 3
done
case "$health" in
  *'"ok":true'*'"mqtt":true'*) ok "API healthy and connected to MQTT" ;;
  *) rollback_now "the API is not healthy or not connected to MQTT: $health" ;;
esac
code="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$domain:443:127.0.0.1" "https://$domain/" || true)"
[ "$code" = 200 ] || rollback_now "the dashboard answers $code instead of 200"
code="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$domain:443:127.0.0.1" "https://$domain/internal/mqtt/auth" || true)"
[ "$code" = 404 ] || rollback_now "/internal answers $code instead of 404"
ok "dashboard 200, /internal closed"

printf '%s\n' "$TO" >"$STATE_DIR/version"
# Keep the last five snapshots' images and code; older ones only take space.
for old in $(ls -1t "$STATE_DIR"/rollback/*.env 2>/dev/null | tail -n +6); do
  s="$(basename "$old" .env)"
  docker rmi "$API_IMAGE:pre-$s" "$WEB_IMAGE:pre-$s" >/dev/null 2>&1 || true
  rm -f "$BACKUP_DIR/code-$s.tgz" "$old"
done
log "upgrade $FROM -> $TO done (snapshot $STAMP)"
step "Done: $TO is running"
say "  Back to $FROM if needed: sudo $APP_DIR/deploy/rollback.sh $STAMP"
