#!/usr/bin/env bash
# Tests or restores a backup made by drone-fleet-backup.
#
#   sudo deploy/restore.sh --list                    # the backups on this server
#   sudo deploy/restore.sh --verify [STAMP]          # restore into a scratch database, count, drop: the live one is untouched
#   sudo deploy/restore.sh --restore STAMP [--yes]   # replace the live database and screenshots with that backup
#
# STAMP is the part of the file names after db-, for example 20261120-023000. --verify without one takes the newest.
# A full restore stops the dashboard for a minute and loses everything recorded after that backup.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
. "$HERE/lib.sh"
need_root

MODE='' STAMP='' YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE=list ;;
    --verify) MODE=verify; [ $# -gt 1 ] && [[ "$2" != --* ]] && { STAMP="$2"; shift; } ;;
    --restore) MODE=restore; STAMP="${2:-}"; shift ;;
    --yes | -y) YES=1 ;;
    -h | --help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
[ -n "$MODE" ] || die "say --list, --verify or --restore (see --help)"

if [ "$MODE" = list ]; then
  say "Backups in $BACKUP_DIR:"
  for dump in $(ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null); do
    s="$(basename "$dump" .sql.gz)"
    s="${s#db-}"
    extra=''
    [ -f "$BACKUP_DIR/screenshots-$s.tgz" ] && extra="$extra screenshots"
    [ -f "$BACKUP_DIR/config-$s.tgz" ] && extra="$extra settings"
    say "  $s  $(du -h "$dump" | cut -f1)  database$extra"
  done
  exit 0
fi

if [ -z "$STAMP" ]; then
  DUMP="$(latest_dump)"
  [ -n "$DUMP" ] || die "no backup in $BACKUP_DIR"
  STAMP="$(basename "$DUMP" .sql.gz)"
  STAMP="${STAMP#db-}"
fi
DUMP="$BACKUP_DIR/db-$STAMP.sql.gz"
SHOTS="$BACKUP_DIR/screenshots-$STAMP.tgz"
[ -f "$DUMP" ] || die "no $DUMP (see --list)"
gzip -t "$DUMP" || die "$DUMP is damaged"

USER_="$(db_user)"
counts() {
  psql_q "SELECT 'users ' || (SELECT count(*) FROM users) || ', drones ' || (SELECT count(*) FROM devices)
    || ', screenshots ' || (SELECT count(*) FROM screenshots) || ', zones ' || (SELECT count(*) FROM zones)
    || ', recordings ' || (SELECT count(*) FROM recordings) || ', audit lines ' || (SELECT count(*) FROM audit_log)" "$1"
}

if [ "$MODE" = verify ]; then
  step "Verifying backup $STAMP (the live database is not touched)"
  scratch="drone_fleet_verify_$$"
  psql_q "CREATE DATABASE $scratch" postgres >/dev/null
  trap 'psql_q "DROP DATABASE IF EXISTS '"$scratch"' WITH (FORCE)" postgres >/dev/null 2>&1 || true' EXIT
  gunzip -c "$DUMP" | compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U "$USER_" -d "$scratch" >/dev/null
  ok "the dump restores cleanly"
  ok "it holds: $(counts "$scratch")"
  ok "the live database holds: $(counts "$(db_name)")"
  if [ -f "$SHOTS" ]; then
    ok "screenshots archive readable: $(tar tzf "$SHOTS" | grep -v '/\.thumbs/' | grep -c '\.\(jpg\|png\)$' || true) pictures"
  else
    warn "no screenshots archive for $STAMP"
  fi
  [ -f "$BACKUP_DIR/config-$STAMP.tgz" ] && ok "settings and certificates archived" || warn "no settings archive for $STAMP (made by older backups)"
  log "backup $STAMP verified"
  exit 0
fi

# --- a full restore ----------------------------------------------------------------------------------------------
[ -f "$SHOTS" ] || warn "no screenshots archive for $STAMP: only the database is restored"
say "This replaces the live database$([ -f "$SHOTS" ] && echo ' and screenshots') with the backup of $STAMP."
say "Everything recorded after it (accounts, zones, screenshots, the audit trail) is lost. The dashboard stops for a minute."
if [ "$YES" != 1 ]; then
  read -r -p "Type RESTORE to go on: " answer
  [ "$answer" = RESTORE ] || die "nothing was changed"
fi

step "A safety copy of the current state first"
/usr/local/bin/drone-fleet-backup || "$APP_DIR/infra/backup.sh"

step "Restoring $STAMP"
compose stop web api >/dev/null
DB="$(db_name)"
psql_q "DROP DATABASE IF EXISTS $DB WITH (FORCE)" postgres >/dev/null
psql_q "CREATE DATABASE $DB OWNER $USER_" postgres >/dev/null
gunzip -c "$DUMP" | compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U "$USER_" -d "$DB" >/dev/null
ok "database restored: $(counts "$DB")"
if [ -f "$SHOTS" ]; then
  compose run --rm --no-deps -T --entrypoint sh api -c 'rm -rf /data/screenshots/* /data/screenshots/.thumbs && tar xzf - -C /data/screenshots' <"$SHOTS"
  ok "screenshots restored"
fi
compose up -d api web >/dev/null
wait_healthy 240 api web || die "the services did not come back: deploy/support-bundle.sh"
ok "back up: $(api_health)"
log "restored backup $STAMP"
