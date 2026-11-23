#!/usr/bin/env bash
# Installs Drone Fleet on a customer's server, from a release folder copied onto it.
#
#   sudo deploy/install.sh --check                      # only look: what is missing, nothing is changed
#   sudo deploy/install.sh --domain drones.example.com --developer-email you@vendor.com \
#        [--cert fullchain.pem --key privkey.pem | --self-signed | --letsencrypt you@vendor.com] \
#        [--public-ip 10.0.0.5] [--brand-name "Acme Sky"] [--logo logo.png] [--mfa-roles developer,admin,subadmin] \
#        [--firewall] [--with-ai] [--yes]
#
# It can be run again: settings already made are kept, secrets are never regenerated, and a running install is
# updated in place. See docs/client-install.md for the whole procedure, before and after this script.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$HERE/.." && pwd)}"
# shellcheck source=deploy/lib.sh
. "$HERE/lib.sh"

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

CHECK_ONLY=0 DOMAIN='' PUBLIC_IP_ARG='' CERT='' KEY='' SELF_SIGNED=0 LE_EMAIL='' DEV_EMAIL='' BRAND='' LOGO=''
MFA_ROLES='developer,admin,subadmin' FIREWALL=0 WITH_AI=0 YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --domain) DOMAIN="$2"; shift ;;
    --public-ip) PUBLIC_IP_ARG="$2"; shift ;;
    --cert) CERT="$2"; shift ;;
    --key) KEY="$2"; shift ;;
    --self-signed) SELF_SIGNED=1 ;;
    --letsencrypt) LE_EMAIL="$2"; shift ;;
    --developer-email) DEV_EMAIL="$2"; shift ;;
    --brand-name) BRAND="$2"; shift ;;
    --logo) LOGO="$2"; shift ;;
    --mfa-roles) MFA_ROLES="$2"; shift ;;
    --firewall) FIREWALL=1 ;;
    --with-ai) WITH_AI=1 ;;
    --yes | -y) YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

need_root
PROBLEMS=0
problem() {
  bad "$*"
  PROBLEMS=$((PROBLEMS + 1))
}

# --- 1. the server ----------------------------------------------------------------------------------------------
step "The server"
. /etc/os-release 2>/dev/null || true
case "${ID:-}" in
  ubuntu | debian) ok "$PRETTY_NAME" ;;
  *) warn "${PRETTY_NAME:-unknown OS}: tested on Ubuntu 22.04/24.04 and Debian 12" ;;
esac
cpus="$(nproc)"
mem_gb="$(awk '/MemTotal/ {printf "%d", $2/1024/1024 + 0.5}' /proc/meminfo)"
disk_gb="$(df -BG --output=avail "$APP_DIR" | tail -n 1 | tr -dc 0-9)"
[ "$cpus" -ge 4 ] && ok "$cpus CPU cores" || { [ "$cpus" -ge 2 ] && warn "$cpus CPU cores (4 or more recommended)" || problem "$cpus CPU core: at least 2 are needed"; }
[ "$mem_gb" -ge 8 ] && ok "${mem_gb} GB memory" || { [ "$mem_gb" -ge 4 ] && warn "${mem_gb} GB memory (8 GB recommended)" || problem "${mem_gb} GB memory: at least 4 GB is needed"; }
[ "$disk_gb" -ge 40 ] && ok "${disk_gb} GB free disk where the app lives" || warn "${disk_gb} GB free disk (40 GB or more, plus room for video)"
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo no)" = yes ]; then
  ok "clock synchronised (two-step codes and certificates depend on it)"
else
  warn "the clock is not synchronised: turn on NTP (timedatectl set-ntp true), or two-step sign-in codes fail"
fi

# --- 2. Docker -----------------------------------------------------------------------------------------------------
step "Docker"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null)"
else
  problem "Docker is not installed or not running: https://docs.docker.com/engine/install/ (then: systemctl enable --now docker)"
fi
if docker compose version >/dev/null 2>&1; then
  ok "$(docker compose version | head -n 1)"
else
  problem "the Docker Compose plugin is missing (package docker-compose-plugin)"
fi
systemctl is-enabled docker >/dev/null 2>&1 && ok "Docker starts at boot" || warn "Docker does not start at boot: systemctl enable docker"
command -v openssl >/dev/null 2>&1 && ok "openssl" || problem "openssl is missing (apt install openssl)"

# --- 3. ports --------------------------------------------------------------------------------------------------------
step "Ports"
our_containers="$({ compose ps -q 2>/dev/null || true; } | wc -l | tr -d ' ')"
for spec in 80/tcp 443/tcp 8883/tcp 1935/tcp 1936/tcp 8000/udp; do
  port="${spec%/*}" proto="${spec#*/}"
  flag='-ltn'
  [ "$proto" = udp ] && flag='-lun'
  holder="$(ss -H "$flag" "sport = :$port" 2>/dev/null | head -n 1)"
  if [ -z "$holder" ]; then
    ok "$spec free"
  elif [ "$our_containers" -gt 0 ]; then
    ok "$spec in use (this install is already running)"
  else
    problem "$spec is already used by another program: free it first"
  fi
done

if [ "$CHECK_ONLY" = 1 ]; then
  step "Result"
  [ "$PROBLEMS" = 0 ] && say "Ready to install." || say "$PROBLEMS problem(s) to fix before installing."
  exit "$([ "$PROBLEMS" = 0 ] && echo 0 || echo 1)"
fi
[ "$PROBLEMS" = 0 ] || die "$PROBLEMS problem(s) above; fix them and run again (--check shows the same list)"

# --- 4. settings -----------------------------------------------------------------------------------------------------
step "Settings ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  (umask 077 && cp "$APP_DIR/infra/.env.production.example" "$ENV_FILE")
  ok "created from the template"
else
  ok "kept the existing file"
fi
chmod 600 "$ENV_FILE"

if [ -n "$DOMAIN" ]; then
  env_set APP_DOMAIN "$DOMAIN"
  env_set PUBLIC_HOST "$DOMAIN"
  is_placeholder MQTT_PUBLIC_HOST && env_set MQTT_PUBLIC_HOST "ssl://$DOMAIN:8883"
  is_placeholder MEDIA_RTMP_HOST && env_set MEDIA_RTMP_HOST "$DOMAIN:1935"
fi
DOMAIN="$(env_get APP_DOMAIN)"
[ -n "$DOMAIN" ] && ! is_placeholder APP_DOMAIN || die "give the dashboard's name: --domain drones.example.com"

if [ -n "$PUBLIC_IP_ARG" ]; then
  env_set PUBLIC_IP "$PUBLIC_IP_ARG"
elif is_placeholder PUBLIC_IP; then
  detected="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}' | head -n 1)"
  [ -n "$detected" ] || die "could not find this server's address: --public-ip <address the browsers reach>"
  env_set PUBLIC_IP "$detected"
  warn "PUBLIC_IP set to $detected (the address browsers use for live video; pass --public-ip if that is wrong)"
fi

# Secrets: made here, once, and never shown. A value already set is never replaced.
for key in JWT_SECRET POSTGRES_PASSWORD EMQX_NODE_COOKIE MQTT_PASSWORD TOTP_ENCRYPTION_KEY; do
  if is_placeholder "$key"; then
    env_set "$key" "$(random_secret 32)"
    ok "$key generated"
  fi
done
[ -n "$BRAND" ] && env_set BRAND_NAME "$BRAND"
env_set MFA_REQUIRED_ROLES "$MFA_ROLES"
env_set APP_VERSION "$(version_of "$APP_DIR")"
if [ -n "$LOGO" ]; then
  [ -f "$LOGO" ] || die "no logo file at $LOGO"
  mkdir -p "$APP_DIR/infra/branding"
  ext="${LOGO##*.}"
  cp "$LOGO" "$APP_DIR/infra/branding/logo.$ext"
  env_set BRAND_LOGO_PATH "/data/branding/logo.$ext"
  ok "logo installed"
fi
storage="$(env_get STORAGE_HOST_DIR)"
mkdir -p "${storage:-/srv/drone-fleet-storage}"
ok "video storage folder ${storage:-/srv/drone-fleet-storage}"
# Nginx's workers (not root) serve the ACME challenge files; backups and state stay root-only.
mkdir -p /var/www/certbot && chmod 755 /var/www/certbot
mkdir -p "$BACKUP_DIR" "$STATE_DIR" && chmod 700 "$BACKUP_DIR" "$STATE_DIR"
if [ -z "$(env_get DJI_APP_ID)" ]; then
  warn "DJI_APP_ID / DJI_APP_KEY / DJI_APP_LICENSE are empty: controllers cannot connect until they are set (then: docker compose ... up -d api)"
fi

# --- 5. certificate --------------------------------------------------------------------------------------------------
step "TLS certificate"
CERTS="$(cert_dir)"
mkdir -p "$CERTS"
# EMQX (UID 1000) must be able to enter the folder to read its key.
chmod 755 "$CERTS"
install_cert() {
  cp "$1" "$CERTS/fullchain.pem"
  cp "$2" "$CERTS/privkey.pem"
  chmod 644 "$CERTS/fullchain.pem"
  # EMQX (MQTT over TLS) runs as UID 1000 and refuses a key it cannot read.
  chown 1000:1000 "$CERTS/privkey.pem"
  chmod 600 "$CERTS/privkey.pem"
}
self_sign() {
  local ip
  ip="$(env_get PUBLIC_IP)"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN,IP:$ip" \
    -keyout "$CERTS/privkey.pem.new" -out "$CERTS/fullchain.pem.new" >/dev/null 2>&1
  install_cert "$CERTS/fullchain.pem.new" "$CERTS/privkey.pem.new"
  rm -f "$CERTS/fullchain.pem.new" "$CERTS/privkey.pem.new"
}
if [ -n "$CERT" ] || [ -n "$KEY" ]; then
  [ -f "$CERT" ] && [ -f "$KEY" ] || die "--cert and --key must both name files"
  install_cert "$CERT" "$KEY"
  ok "installed the given certificate"
elif [ "$SELF_SIGNED" = 1 ] || { [ -n "$LE_EMAIL" ] && [ ! -f "$CERTS/fullchain.pem" ]; }; then
  self_sign
  [ "$SELF_SIGNED" = 1 ] && warn "self-signed certificate: browsers warn and DJI Pilot 2 may refuse it; use it on a closed LAN only"
elif [ -f "$CERTS/fullchain.pem" ]; then
  ok "kept the existing certificate"
else
  die "no certificate: --cert/--key (the customer's), --letsencrypt <email> (public name) or --self-signed (closed LAN)"
fi
days_left=$((($(date -d "$(openssl x509 -enddate -noout -in "$CERTS/fullchain.pem" | cut -d= -f2)" +%s) - $(date +%s)) / 86400))
ok "certificate valid for $days_left more days"

# --- 6. start ----------------------------------------------------------------------------------------------------------
step "Start"
if ls "$RELEASE_DIR"/images-*.tar* >/dev/null 2>&1; then
  for archive in "$RELEASE_DIR"/images-*.tar*; do
    say "  loading $(basename "$archive") (no internet needed)"
    case "$archive" in
      *.gz) gunzip -c "$archive" | docker load >/dev/null ;;
      *) docker load -i "$archive" >/dev/null ;;
    esac
  done
  compose up -d --no-build >"$STATE_DIR/install-up.log" 2>&1 || {
    tail -n 25 "$STATE_DIR/install-up.log"
    die "starting from the shipped images failed (log: $STATE_DIR/install-up.log)"
  }
else
  say "  building the images here (needs internet the first time; several minutes)"
  compose up -d --build >"$STATE_DIR/install-up.log" 2>&1 || {
    tail -n 25 "$STATE_DIR/install-up.log"
    die "the build or start failed (log: $STATE_DIR/install-up.log)"
  }
fi
wait_healthy 300 postgres emqx api web || die "the stack did not become healthy: docker compose ... ps, and deploy/support-bundle.sh"
ok "all services healthy"
health="$(api_health || true)"
case "$health" in *'"ok":true'*) ok "API: $health" ;; *) die "the API does not answer its health check: $health" ;; esac

if [ -n "$LE_EMAIL" ]; then
  step "Let's Encrypt (by asking for it you accept their terms of service)"
  command -v certbot >/dev/null 2>&1 || apt-get install -y certbot >/dev/null
  certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" -m "$LE_EMAIL" --agree-tos --non-interactive >/dev/null
  install_cert "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "/etc/letsencrypt/live/$DOMAIN/privkey.pem"
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat >/etc/letsencrypt/renewal-hooks/deploy/drone-fleet.sh <<HOOK
#!/bin/sh
# Copies a renewed certificate where Drone Fleet reads it and reloads the services that use it.
cp /etc/letsencrypt/live/$DOMAIN/fullchain.pem $CERTS/fullchain.pem
cp /etc/letsencrypt/live/$DOMAIN/privkey.pem $CERTS/privkey.pem
chown 1000:1000 $CERTS/privkey.pem && chmod 600 $CERTS/privkey.pem
docker compose --env-file $ENV_FILE -f $COMPOSE_FILE restart web emqx
HOOK
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/drone-fleet.sh
  compose restart web emqx >/dev/null
  wait_healthy 120 web emqx || die "web or MQTT did not come back with the new certificate"
  ok "certificate issued; certbot renews it by itself"
fi

# --- 7. first account, AI model ------------------------------------------------------------------------------------
if [ -n "$DEV_EMAIL" ]; then
  step "First account"
  DEV_PASS="${DEVELOPER_PASSWORD:-$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)}"
  compose exec -T -e DEVELOPER_PASSWORD="$DEV_PASS" api pnpm run admin -- --email "$DEV_EMAIL" </dev/null | tail -n 1
  if [ -z "${DEVELOPER_PASSWORD:-}" ]; then
    printf 'Developer: %s\nPassword:  %s\n(created %s; change it after the first sign-in)\n' "$DEV_EMAIL" "$DEV_PASS" "$(date)" \
      >/root/drone-fleet-developer.txt
    chmod 600 /root/drone-fleet-developer.txt
    ok "the password is in /root/drone-fleet-developer.txt (root only)"
  fi
fi
if [ "$WITH_AI" = 1 ]; then
  step "People-counting model (about 250 MB download)"
  compose exec -T api pnpm models:fetch </dev/null | tail -n 2 || warn "not fetched now; run later: docker compose ... exec api pnpm models:fetch"
fi

# --- 8. operations: backup, health check, firewall ------------------------------------------------------------------
step "Operations"
cat >/etc/default/drone-fleet <<CONF
# Drone Fleet operations settings, read by the scripts in $APP_DIR/deploy and by cron.
APP_DIR=$APP_DIR
BACKUP_DIR=$BACKUP_DIR
# Days of nightly backups kept on this server.
KEEP_DAYS=${KEEP_DAYS:-14}
# A second copy elsewhere (a NAS mount or user@host:/path for rsync over SSH). Strongly recommended.
BACKUP_TARGET=${BACKUP_TARGET:-}
# 1 also copies the video archive to BACKUP_TARGET (large; incremental after the first run).
BACKUP_RECORDINGS=${BACKUP_RECORDINGS:-0}
# Where problems are announced: a Slack, Teams, Google Chat or Discord incoming-webhook address.
ALERT_WEBHOOK_URL=${ALERT_WEBHOOK_URL:-}
CONF
chmod 600 /etc/default/drone-fleet
install -m 755 "$APP_DIR/infra/backup.sh" /usr/local/bin/drone-fleet-backup
cat >/etc/cron.d/drone-fleet <<CRON
# Drone Fleet: nightly backup and a health check every five minutes.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 2 * * * root /usr/local/bin/drone-fleet-backup >>$LOG_FILE 2>&1
*/5 * * * * root $APP_DIR/deploy/healthcheck.sh --cron
CRON
chmod 644 /etc/cron.d/drone-fleet
ok "nightly backup at 02:30 (/usr/local/bin/drone-fleet-backup), health check every 5 minutes"
cat >/etc/logrotate.d/drone-fleet <<ROT
$LOG_FILE {
  weekly
  rotate 8
  compress
  missingok
  notifempty
}
ROT
if [ "$FIREWALL" = 1 ]; then
  command -v ufw >/dev/null 2>&1 || apt-get install -y ufw >/dev/null
  ufw allow 22/tcp >/dev/null
  for spec in 80/tcp 443/tcp 8883/tcp 1935/tcp 1936/tcp 8000/udp; do ufw allow "$spec" >/dev/null; done
  ufw --force enable >/dev/null
  ok "firewall: only SSH, 80, 443, 8883, 1935, 1936 and 8000/udp are open"
else
  warn "firewall left as it is (--firewall opens only the needed ports and turns ufw on)"
fi
date -u +%FT%TZ >"$STATE_DIR/installed"
version_of "$APP_DIR" >"$STATE_DIR/version"
log "installed version $(version_of "$APP_DIR") for $DOMAIN"

step "Done"
say "  Dashboard:       https://$DOMAIN"
say "  Controllers:     https://$DOMAIN/pilot (inside DJI Pilot 2), MQTT $(env_get MQTT_PUBLIC_HOST), RTMP $(env_get MEDIA_RTMP_HOST)"
say "  Two-step sign-in is required for: $(env_get MFA_REQUIRED_ROLES)"
say "  Next: sign in as the Developer, set up two-step sign-in, create the customer's Admin,"
say "        set the DJI app keys if empty, and run the acceptance checklist in docs/client-install.md."
say "  Health now:       $APP_DIR/deploy/healthcheck.sh"
