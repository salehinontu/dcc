#!/usr/bin/env bash
# Is the install healthy? Services, the API, disk, certificate, backups and the clock.
#
#   deploy/healthcheck.sh          # a readable report; exit 0 all good, 1 a warning, 2 a problem
#   deploy/healthcheck.sh --cron   # quiet: logs to /var/log/drone-fleet.log and alerts only when the state changes
#
# Alerts go to ALERT_WEBHOOK_URL (Slack, Microsoft Teams, Google Chat, Mattermost or Discord incoming webhook) from
# /etc/default/drone-fleet. Installed in cron (every five minutes) by deploy/install.sh.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
. "$HERE/lib.sh"

CRON=0
[ "${1:-}" = --cron ] && CRON=1
LEVEL=0
REPORT=()
note() {
  # $1: 0 ok, 1 warn, 2 problem
  [ "$1" -gt "$LEVEL" ] && LEVEL="$1"
  case "$1" in
    0) REPORT+=("ok    $2") ;;
    1) REPORT+=("warn  $2") ;;
    *) REPORT+=("FAIL  $2") ;;
  esac
}

# Services.
for service in postgres emqx srs api web; do
  state="$(service_state "$service")"
  case "$state" in
    healthy | running) note 0 "$service $state" ;;
    starting) note 1 "$service starting" ;;
    *) note 2 "$service $state" ;;
  esac
done

# The API's own view: up, and connected to the MQTT broker the controllers use.
health="$(api_health 2>/dev/null || true)"
case "$health" in
  *'"ok":true'*'"mqtt":true'*) note 0 "API answers, MQTT connected" ;;
  *'"ok":true'*) note 2 "API answers but is not connected to MQTT: controllers cannot report" ;;
  *) note 2 "API does not answer its health check" ;;
esac

# Disk: where the app and the database live, and where the videos go.
disk_check() {
  local path="$1" label="$2" used
  [ -d "$path" ] || return 0
  used="$(df --output=pcent "$path" | tail -n 1 | tr -dc 0-9)"
  if [ "$used" -ge 95 ]; then
    note 2 "$label disk ${used}% full"
  elif [ "$used" -ge 85 ]; then
    note 1 "$label disk ${used}% full"
  else
    note 0 "$label disk ${used}% used"
  fi
}
disk_check / "system"
disk_check /var/lib/docker "Docker (database, video volume)"
storage="$(env_get STORAGE_HOST_DIR)"
storage="${storage:-/srv/drone-fleet-storage}"
[ -n "$storage" ] && disk_check "$storage" "video storage folder"

# Certificate.
cert="$(cert_dir)/fullchain.pem"
if [ -f "$cert" ]; then
  end="$(openssl x509 -enddate -noout -in "$cert" 2>/dev/null | cut -d= -f2)"
  days=$((($(date -d "$end" +%s) - $(date +%s)) / 86400))
  if [ "$days" -lt 7 ]; then
    note 2 "TLS certificate expires in $days days"
  elif [ "$days" -lt 21 ]; then
    note 1 "TLS certificate expires in $days days"
  else
    note 0 "TLS certificate valid $days more days"
  fi
else
  note 2 "no TLS certificate at $cert"
fi

# Backups.
newest="$(latest_dump)"
if [ -z "$newest" ]; then
  note 1 "no backup yet in $BACKUP_DIR"
else
  age_h=$((($(date +%s) - $(stat -c %Y "$newest")) / 3600))
  if [ "$age_h" -gt 48 ]; then
    note 2 "newest backup is ${age_h} hours old"
  elif [ "$age_h" -gt 30 ]; then
    note 1 "newest backup is ${age_h} hours old"
  else
    note 0 "newest backup ${age_h} hours old$([ -z "${BACKUP_TARGET:-}" ] && echo ', but only on this server (set BACKUP_TARGET)')"
  fi
fi

# Clock: two-step sign-in codes are only right with the right time.
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)" = yes ]; then
  note 0 "clock synchronised"
else
  note 1 "clock not synchronised (two-step sign-in codes may fail)"
fi

summary="$(printf '%s\n' "${REPORT[@]}")"
status=$([ "$LEVEL" = 0 ] && echo OK || { [ "$LEVEL" = 1 ] && echo WARNING || echo PROBLEM; })

if [ "$CRON" = 0 ]; then
  say "Drone Fleet $(version_of) on $(hostname): $status"
  printf '  %s\n' "${REPORT[@]}"
  exit "$LEVEL"
fi

# Cron: write the state, and speak only when it changes (no alert every five minutes for the same thing).
mkdir -p "$STATE_DIR"
previous="$(cat "$STATE_DIR/health" 2>/dev/null || echo OK)"
problems="$(printf '%s\n' "${REPORT[@]}" | grep -v '^ok' || true)"
printf '%s\n' "$status" >"$STATE_DIR/health"
printf '%s\n' "$summary" >"$STATE_DIR/health-report"
if [ "$status" != "$previous" ] || { [ "$status" != OK ] && [ "$(find "$STATE_DIR/health-alerted" -mmin -360 2>/dev/null)" = '' ]; }; then
  log "health $status${problems:+: $(echo "$problems" | tr '\n' ';')}"
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    text="Drone Fleet on $(hostname): $status"
    [ -n "$problems" ] && text="$text"$'\n'"$problems"
    [ "$status" = OK ] && text="$text (recovered)"
    body="$(printf '%s' "$text" | python3 -c 'import json,sys; t=sys.stdin.read(); print(json.dumps({"text": t, "content": t}))' 2>/dev/null ||
      printf '{"text":"%s"}' "$status")"
    curl -fsS -m 10 -H 'content-type: application/json' -d "$body" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || log "alert could not be sent"
  fi
  # A problem that lasts is repeated every six hours, not every five minutes.
  touch "$STATE_DIR/health-alerted"
fi
exit "$LEVEL"
