#!/usr/bin/env bash
# Collects what support needs to understand a problem, without secrets, into one file to send:
#   sudo deploy/support-bundle.sh            # -> /tmp/drone-fleet-support-<host>-<time>.tar.gz
#
# Included: version, OS, Docker, container states, the health report, disk and memory, the last 1000 log lines of
# each service and the names (never the values) of the settings. Passwords, tokens, keys and cookies are blanked.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
. "$HERE/lib.sh"
need_root

name="drone-fleet-support-$(hostname -s)-$(stamp)"
dir="$(mktemp -d)/$name"
mkdir -p "$dir"
redact() {
  sed -E \
    -e 's/(password|passwd|secret|token|apikey|api_key|app_key|appkey|cookie|authorization|license|licence)([^:=]{0,20}[:=][[:space:]"]*)[^[:space:]",&]+/\1\2[redacted]/Ig' \
    -e 's/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/[jwt]/g' \
    -e 's#(rtmps?://[^/[:space:]]+/live/)[^[:space:]"]+#\1[key]#g'
}
{
  echo "version: $(version_of)  (installed $(cat "$STATE_DIR/installed" 2>/dev/null || echo '?'))"
  echo "host: $(hostname)  $(uname -srm)"
  grep PRETTY_NAME /etc/os-release 2>/dev/null
  docker version -f 'docker {{.Server.Version}}' 2>&1
  docker compose version 2>&1 | head -n 1
  echo
  echo "uptime: $(uptime)"
  free -m
  storage="$(env_get STORAGE_HOST_DIR)"
  df -h / /var/lib/docker "${storage:-/srv/drone-fleet-storage}" 2>/dev/null
  # One command that fails (a folder that is not there, an old Docker) must not stop the bundle: || true below.
} >"$dir/system.txt" 2>&1 || true
compose ps -a >"$dir/containers.txt" 2>&1 || true
"$HERE/healthcheck.sh" >"$dir/health.txt" 2>&1 || true
grep -oE '^[A-Z_]+=' "$ENV_FILE" 2>/dev/null | tr -d '=' >"$dir/setting-names.txt" || true
for service in postgres emqx srs api web; do
  compose logs --no-color --tail 1000 "$service" 2>&1 | redact >"$dir/log-$service.txt" || true
done
tail -n 500 "$LOG_FILE" 2>/dev/null | redact >"$dir/operations-log.txt" || true
ls -1t "$BACKUP_DIR" 2>/dev/null | head -n 20 >"$dir/backups.txt" || true
ls -1t "$STATE_DIR/rollback" 2>/dev/null >"$dir/snapshots.txt" || true
out="/tmp/$name.tar.gz"
tar czf "$out" -C "$(dirname "$dir")" "$name"
rm -rf "$(dirname "$dir")"
chmod 600 "$out"
say "Support bundle: $out ($(du -h "$out" | cut -f1)). Look through it before sending: logs can name people and places."
