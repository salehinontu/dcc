#!/usr/bin/env bash
# Puts back the version that ran before an upgrade: its code and its images.
#
#   sudo deploy/rollback.sh --list
#   sudo deploy/rollback.sh [STAMP] [--with-database] [--yes]
#
# Without STAMP, the newest snapshot. The database is left as it is (upgrades only add tables and columns, and the
# older code ignores them); --with-database also restores the backup taken at that snapshot, which loses everything
# recorded since.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
. "$HERE/lib.sh"
need_root

STAMP='' WITH_DB=0 YES=0 LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST=1 ;;
    --with-database) WITH_DB=1 ;;
    --yes | -y) YES=1 ;;
    -h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) die "unknown option $1 (see --help)" ;;
    *) STAMP="$1" ;;
  esac
  shift
done

if [ "$LIST" = 1 ]; then
  say "Snapshots (newest first):"
  for rec in $(ls -1t "$STATE_DIR"/rollback/*.env 2>/dev/null); do
    # shellcheck disable=SC1090
    (. "$rec" && say "  $STAMP  $VERSION_FROM -> $VERSION_TO")
  done
  exit 0
fi

if [ -z "$STAMP" ]; then
  rec="$(ls -1t "$STATE_DIR"/rollback/*.env 2>/dev/null | head -n 1)"
  [ -n "$rec" ] || die "no snapshot in $STATE_DIR/rollback (see --list)"
else
  rec="$STATE_DIR/rollback/$STAMP.env"
  [ -f "$rec" ] || die "no snapshot $STAMP (see --list)"
fi
# shellcheck disable=SC1090
. "$rec"
[ -f "$CODE_TAR" ] || die "the code of snapshot $STAMP is missing ($CODE_TAR)"
docker image inspect "$API_IMAGE:pre-$STAMP" >/dev/null 2>&1 || die "the image $API_IMAGE:pre-$STAMP is gone"

say "Roll back to $VERSION_FROM (snapshot $STAMP)$([ "$WITH_DB" = 1 ] && echo ', database included')."
if [ "$YES" != 1 ] && [ -t 0 ]; then
  read -r -p "Go on? [y/N] " answer
  [[ "$answer" =~ ^[yY] ]] || die "nothing was changed"
fi

step "Code"
tmp="$(mktemp -d)"
tar xzf "$CODE_TAR" -C "$tmp"
for dir in apps packages tools docs deploy; do
  [ -d "$tmp/$dir" ] && rsync -a --delete --exclude=node_modules --exclude=dist --exclude=.data "$tmp/$dir/" "$APP_DIR/$dir/"
done
rsync -a --exclude=.env.production --exclude=certs/ --exclude=branding/ "$tmp/infra/" "$APP_DIR/infra/"
for file in VERSION package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json run.sh README.md CLAUDE.md; do
  [ -f "$tmp/$file" ] && cp "$tmp/$file" "$APP_DIR/$file"
done
rm -rf "$tmp"
env_set APP_VERSION "$VERSION_FROM"
ok "code of $VERSION_FROM back in $APP_DIR"

step "Images"
docker tag "$API_IMAGE:pre-$STAMP" "$API_IMAGE:latest"
docker tag "$WEB_IMAGE:pre-$STAMP" "$WEB_IMAGE:latest"
ok "images of $VERSION_FROM back"

if [ "$WITH_DB" = 1 ]; then
  step "Database"
  "$HERE/restore.sh" --restore "$STAMP" --yes
fi

step "Start"
compose up -d --no-build >/dev/null 2>&1
wait_healthy 300 postgres emqx api web || die "the old version did not come up healthy either: deploy/support-bundle.sh"
ok "running: $(api_health)"
printf '%s\n' "$VERSION_FROM" >"$STATE_DIR/version"
log "rolled back to $VERSION_FROM (snapshot $STAMP)"
