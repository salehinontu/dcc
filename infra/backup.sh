#!/usr/bin/env bash
#
# Nightly backup of a Drone Fleet install: the Postgres database, the screenshots, and the settings and certificates
# needed to bring it back (root-only). Installed as /usr/local/bin/drone-fleet-backup by deploy/install.sh (or by hand,
# see docs/deployment.md) and run from cron.
#
# Settings come from /etc/default/drone-fleet (or the environment):
#   APP_DIR            the install (default /opt/drone-fleet)
#   BACKUP_DIR         where backups are written on this server (default /var/backups/drone-fleet)
#   KEEP_DAYS          days kept here (default 14)
#   BACKUP_TARGET      a second copy elsewhere: a mounted NAS folder, or user@host:/path (rsync over SSH)
#   BACKUP_RECORDINGS  1 also copies the video archive to BACKUP_TARGET, incrementally (large)
#
# Restore with deploy/restore.sh. A backup that is never tested is a hope: deploy/restore.sh --verify restores the
# newest dump into a scratch database and counts what is in it, without touching the live one.
set -euo pipefail

if [ -r /etc/default/drone-fleet ]; then
  # shellcheck disable=SC1091
  . /etc/default/drone-fleet
fi
APP_DIR="${APP_DIR:-/opt/drone-fleet}"
OUT="${BACKUP_DIR:-/var/backups/drone-fleet}"
KEEP_DAYS="${KEEP_DAYS:-14}"
BACKUP_TARGET="${BACKUP_TARGET:-}"
BACKUP_RECORDINGS="${BACKUP_RECORDINGS:-0}"
STATE_DIR="${STATE_DIR:-/var/lib/drone-fleet}"
STAMP="$(date +%Y%m%d-%H%M%S)"

COMPOSE=(docker compose --env-file "$APP_DIR/infra/.env.production" -f "$APP_DIR/infra/docker-compose.prod.yml")

umask 077
mkdir -p "$OUT" "$STATE_DIR"

# Database: a consistent logical dump, compressed.
"${COMPOSE[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' \
  </dev/null | gzip -9 >"$OUT/db-$STAMP.sql.gz"

# Screenshots: the files the database rows point at.
"${COMPOSE[@]}" exec -T api tar czf - -C /data/screenshots . </dev/null >"$OUT/screenshots-$STAMP.tgz"

# The settings, certificates and logo: without them a restored database cannot be opened the same way (the secrets
# that seal two-step sign-in live in the settings). Root-only, like everything here.
tar czf "$OUT/config-$STAMP.tgz" -C "$APP_DIR/infra" .env.production certs $([ -d "$APP_DIR/infra/branding" ] && echo branding) 2>/dev/null

# A truncated dump is worse than none: check every archive before keeping it.
gzip -t "$OUT/db-$STAMP.sql.gz"
tar tzf "$OUT/screenshots-$STAMP.tgz" >/dev/null
tar tzf "$OUT/config-$STAMP.tgz" >/dev/null

# crew-*.tgz are pilot-photo archives from older releases; they age out with the rest.
find "$OUT" -type f \( -name 'db-*.sql.gz' -o -name 'screenshots-*.tgz' -o -name 'config-*.tgz' -o -name 'crew-*.tgz' \) \
  -mtime +"$KEEP_DAYS" -delete

# A second copy somewhere else: a backup that dies with the server is no backup.
copied='no second copy (set BACKUP_TARGET)'
if [ -n "$BACKUP_TARGET" ]; then
  if [[ "$BACKUP_TARGET" != *:* ]]; then
    mkdir -p "$BACKUP_TARGET"
  fi
  rsync -a "$OUT/db-$STAMP.sql.gz" "$OUT/screenshots-$STAMP.tgz" "$OUT/config-$STAMP.tgz" "$BACKUP_TARGET/"
  if [[ "$BACKUP_TARGET" != *:* ]]; then
    find "$BACKUP_TARGET" -maxdepth 1 -type f \( -name 'db-*.sql.gz' -o -name 'screenshots-*.tgz' -o -name 'config-*.tgz' \) \
      -mtime +"$KEEP_DAYS" -delete
  fi
  copied="copied to $BACKUP_TARGET"
  if [ "$BACKUP_RECORDINGS" = 1 ]; then
    # The video archive is too big to pack every night: mirror it, so only new clips travel.
    api="$("${COMPOSE[@]}" ps -q api | head -n 1)"
    for mount in /data/recordings /storage; do
      source="$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$mount\"}}{{.Source}}{{end}}{{end}}" "$api")"
      [ -n "$source" ] && [ -d "$source" ] || continue
      rsync -a "$source/" "$BACKUP_TARGET/video${mount//\//-}/"
    done
    copied="$copied, video archive included"
  fi
fi

date -u +%FT%TZ >"$STATE_DIR/last-backup"
echo "backup ok: $OUT/db-$STAMP.sql.gz ($(du -h "$OUT/db-$STAMP.sql.gz" | cut -f1)), screenshots-$STAMP.tgz ($(du -h "$OUT/screenshots-$STAMP.tgz" | cut -f1)), config-$STAMP.tgz; $copied"
