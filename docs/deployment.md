# Production deployment

Runbook for taking the POC to a public Linux server with Docker Compose. Read
[`README.md`](../README.md) for the product overview and
[`hardware-bring-up.md`](./hardware-bring-up.md) for the aircraft, controller and
DJI-account checks that must pass before a real aircraft can register.

> **Installing for a customer?** Use [`client-install.md`](./client-install.md): the `deploy/` scripts do the steps of
> this runbook (secrets, certificate, start, first account, backups, health checks, safe upgrades with rollback), and it
> holds the site survey, the acceptance test and the hand-over. This runbook remains the reference for each part.

> **Status:** the images and the full stack were validated locally with self-signed
> certificates and an isolated Compose project: health, login, `/internal/*` 404, MQTT over
> TLS with good and bad credentials, and an API recreate that recovered through Nginx
> without restarting `web`. A real server still has to validate DNS, a trusted certificate,
> firewall rules and DJI hardware; section 7 is the acceptance checklist.

---

## 1. What gets deployed

```
                    Internet
                       │
   ┌───────────────────┼───────────────────────────────┐
   │                   │                               │
 443/tcp            8883/tcp                       1935/tcp + 8000/udp
   │                   │                               │
┌──▼──────────┐   ┌────▼─────┐                    ┌────▼─────┐
│  web        │   │  emqx    │                    │  srs     │
│  Nginx+TLS  │   │  MQTT    │                    │  RTMP →  │
│  static app │   │  auth    │                    │  WebRTC  │
└──┬──────────┘   └────┬─────┘                    └────┬─────┘
   │ /api, /ws         │ internal 1883                 │ internal 1985/8080
   │ WHEP via /api     │                               │
┌──▼───────────────────▼───────────────────────────────▼─────┐
│                        api (Fastify)                        │
│       REST · WebSocket · MQTT ingest · stream control      │
└──────────────────────────────┬──────────────────────────────┘
                               │ 5432
                        ┌──────▼──────┐
                        │  postgres   │
                        └─────────────┘
```

| Service | Image / build | Public port | Internal role | Persists |
| --- | --- | --- | --- | --- |
| `web` | `apps/web/Dockerfile` (Nginx) | 80, 443, 1936 (RTMPS) | dashboard, `/pilot`, reverse proxy, TLS for RTMPS | — |
| `api` | `apps/api/Dockerfile` | none | REST, `/ws`, EMQX auth hooks, SRS callbacks | — |
| `emqx` | `emqx/emqx:5.8.0` | 8883 (TLS) | MQTT broker, HTTP auth/ACL to the API | EMQX state is ephemeral |
| `srs` | `ossrs/srs:6` | 1935/tcp, 8000/udp | RTMP ingest, WHEP/WebRTC playback | no recordings |
| `postgres` | `postgres:16-alpine` | none | users, devices, telemetry, streams, raw MQTT log | `pgdata` volume |

**DNS names**

| Name | Used by | TLS |
| --- | --- | --- |
| `app.example.com` | dashboard, Drone operator `/pilot`, `/api`, `/ws`, WHEP signalling | yes (Nginx) |
| `mqtt.example.com` | Pilot 2 → EMQX | yes (EMQX, 8883) |
| `media.example.com` | Pilot 2 → SRS RTMP | plain RTMP on 1935; **RTMPS on 1936** (Nginx, same certificate) for encoders that can use it |

---

## 2. Prerequisites

- [ ] Linux VM with a public IPv4, 4 vCPU / 8 GB RAM minimum, 100 GB disk to start
- [ ] Docker Engine with the Compose v2 plugin (`docker compose version` works)
- [ ] Three DNS A records: `app`, `mqtt`, `media` → the VM's public IP
- [ ] A TLS certificate whose SANs cover `app.example.com` **and** `mqtt.example.com`
      (a wildcard covers all three; `media` is only needed if you later add TLS to RTMP)
- [ ] DJI Cloud API app: App ID, App Key, App License
- [ ] Outbound internet from the VM (image pulls, SMTP not used, DNS)
- [ ] Time synchronisation (`systemd-timesyncd` or `chrony`) — TLS and session tokens depend on it

The API begins with no data. On first boot it creates the schema and workspace. Create
the first developer account with `docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml exec api npm run admin`.
The developer then creates the customer's Admin from **Users and permissions** (see [on-premise.md](on-premise.md)).
See [account setup and permissions](access-control.md). Accounts are no longer seeded from environment variables.

---

## 3. Host setup

### 3.1 Docker

Install Docker Engine and the Compose plugin following
<https://docs.docker.com/engine/install/>. Do not use Docker Desktop on the server.

```bash
docker --version
docker compose version
```

### 3.2 Get the code

```bash
sudo mkdir -p /opt/dji-fleet
sudo chown "$USER" /opt/dji-fleet
git clone <repository-url> /opt/dji-fleet
cd /opt/dji-fleet
```

Use a tag or a pinned commit for production, not a moving branch. The compose project name
is `dji-fleet-prod`: containers are named `dji-fleet-prod-*` and the volume is
`dji-fleet-prod_pgdata`.

### 3.3 Firewall

Open only these ports:

```bash
sudo ufw allow 80/tcp      # ACME HTTP-01 / redirect to HTTPS
sudo ufw allow 443/tcp     # dashboard, Pilot page, API, WebSocket, WHEP
sudo ufw allow 8883/tcp    # MQTT over TLS from controllers
sudo ufw allow 1935/tcp    # RTMP ingest from controllers (plain)
sudo ufw allow 1936/tcp    # RTMPS ingest (TLS), for encoders that can push rtmps://
sudo ufw allow 8000/udp    # WebRTC media (SRS ICE)
sudo ufw enable
```

Do **not** open 5432 (Postgres), 1883 (plain MQTT), 1985/8080 (SRS HTTP API/FLV) or 18083
(EMQX dashboard). The compose file does not publish them; keep the cloud security group the
same as the host firewall.

If DNS is proxied by Cloudflare, `app` may be proxied (orange cloud), but `mqtt` and `media`
must be **DNS-only** (grey cloud) — the proxy does not forward 8883 or 1935.

---

## 4. DNS and TLS

### 4.1 Certificate files

Place exactly these names in `infra/certs/` (the default `CERT_DIR`):

```text
infra/certs/fullchain.pem   # leaf + intermediates, in that order
infra/certs/privkey.pem     # unencrypted private key
```

Both Nginx and EMQX mount this directory read-only. The compose default
`CERT_DIR=./certs` is relative to `infra/docker-compose.prod.yml`, so it resolves to
`infra/certs`. An absolute path is also valid.

```bash
mkdir -p infra/certs
cp /path/to/fullchain.pem infra/certs/fullchain.pem
cp /path/to/privkey.pem   infra/certs/privkey.pem
chmod 644 infra/certs/fullchain.pem
chmod 600 infra/certs/privkey.pem
```

If EMQX fails to start with a certificate permission error, check the UID its image runs as
and make the key readable by that UID. Never commit this directory — it is now covered by
`.gitignore`.

### 4.2 Obtaining and renewing

The Nginx template reserves `/.well-known/acme-challenge/`, but **no ACME client or shared
webroot is included**. Obtain certificates out of band (on the host with certbot, at your CA,
or via DNS-01) and copy the files in.

Renewal:

1. Replace `fullchain.pem` and `privkey.pem`.
2. `$COMPOSE exec web nginx -s reload` — reloads the certificate without dropping
   dashboard sessions.
3. `$COMPOSE restart emqx` — EMQX reads listener certificates at start; MQTT
   clients reconnect automatically.

Do this during a quiet period. SRS does not use the certificate.

---

## 5. Configuration

```bash
cp infra/.env.production.example infra/.env.production
chmod 600 infra/.env.production
$EDITOR infra/.env.production
```

`infra/.env.production` is used twice: Compose reads it for `${…}` interpolation, and the
`api` service receives it via `env_file`. The compose file overrides `DATABASE_URL`,
`MQTT_URL` and `CORS_ORIGINS` with values that are correct inside the compose network — do
not "fix" those in the container.

| Variable | Required value | Notes |
| --- | --- | --- |
| `APP_DOMAIN` | `app.example.com` | Nginx `server_name`; must match the certificate |
| `PUBLIC_IP` | VM public IPv4 | Advertised as the SRS WebRTC ICE candidate |
| `CERT_DIR` | `./certs` or an absolute path | Relative to `infra/` |
| `POSTGRES_USER`, `POSTGRES_DB` | `dji` | Used to build `DATABASE_URL` |
| `POSTGRES_PASSWORD` | random | Use `[A-Za-z0-9_-]`; `@ : / ?` break the URL |
| `JWT_SECRET` | 32+ random bytes | `openssl rand -hex 32` |
| `EMQX_NODE_COOKIE` | 16+ random characters | Erlang distribution cookie; required even for one node |
| `PUBLIC_HOST` | `app.example.com` | Any non-`localhost` value makes the session cookie `Secure` |
| `DJI_APP_ID`, `DJI_APP_KEY`, `DJI_APP_LICENSE` | from the DJI Developer Center | Licence verification fails if these are placeholders |
| `DJI_PLATFORM_NAME`, `DJI_WORKSPACE_NAME` | your labels | Shown in Pilot 2 |
| `MQTT_PUBLIC_HOST` | `ssl://mqtt.example.com:8883` | What Pilot 2 is told to connect to. The `ssl://` (or `tcp://`) scheme is required |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | dedicated server account | This account bypasses per-controller topic checks — keep it secret |
| `MQTT_CREDENTIAL_TTL_HOURS` | `168` | Controller credential lifetime |
| `MEDIA_RTMP_HOST` | `media.example.com:1935` | RTMP ingest given to Pilot 2 |
| `MEDIA_WHEP_INTERNAL_TEMPLATE` | `http://srs:1985/rtc/v1/whep/?app=live&stream={key}` | Internal WHEP target for the API's proxy. Must point at `srs:1985` and contain `{key}`; never sent to browsers |
| `STREAM_LINGER_SECONDS`, `STREAM_START_DEADLINE_SECONDS`, `STREAM_REPLY_TIMEOUT_MS` | `60`, `60`, `30000` | Viewer linger, failed-start deadline, controller reply timeout |
| `CORS_ORIGINS` | **empty** | Same-origin deployment |
| `RTMPS_PORT` | optional | Published port of the encrypted RTMP ingest, default 1936. |
| `SRS_RTMP_PORT`, `SRS_WEBRTC_PORT` | optional | Published media ports, defaults 1935 and 8000/udp. Override only for a local smoke test beside another stack. |

Generate secrets:

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 24   # EMQX_NODE_COOKIE, POSTGRES_PASSWORD, MQTT_PASSWORD
```

Never copy the development `.env` to the server. `infra/.env.production` is gitignored; verify
with `git check-ignore infra/.env.production`.

Changing this file requires a recreate, not a restart — `restart` keeps the old container
environment:

```bash
$COMPOSE up -d
```

---

## 6. Start the stack

Run from the repository root. Define a shorthand for the rest of this document:

```bash
cd /opt/dji-fleet
export COMPOSE="docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml"
```

Build and start:

```bash
$COMPOSE config >/dev/null && echo "compose config OK"

# Optional, from a workstation with Node 22, before the first start:
node tools/docker/preflight.mjs --prod

$COMPOSE up -d --build
$COMPOSE ps
```

All five services should be `running`; `postgres`, `emqx`, `api` and `web` should be
`healthy`. `api` waits for Postgres and EMQX; `web` waits for `api` healthy and `srs`
started. EMQX can take up to ~30 s to become healthy on first boot; the API retries its MQTT
connection until EMQX's auth connector reaches it.

First-boot log lines to expect:

```bash
$COMPOSE logs -f api
```

```text
[mqtt] connected to mqtt://emqx:1883
[api] listening on http://localhost:3000
```

`[mqtt] connected` proves the API's server
account authenticated against EMQX, which also proves EMQX can reach
`/internal/mqtt/auth`.

Health check through Nginx:

```bash
curl -fsS https://app.example.com/api/health
# {"ok":true,"mqtt":true,"mqttSubscribed":true,"websocketClients":0,"devices":0}
```

If `mqtt` is `false`, fix that before touching a controller — EMQX cannot authenticate any
client without the API, and Pilot 2 will fail at the MQTT step. `mqttSubscribed` must also
be `true` before expecting telemetry to appear.

---

## 6a. Notes from a single-VPS install

One VPS (Ubuntu 24.04, 2 vCPU, 8 GB RAM, no GPU) at `/opt/drone-fleet`, with one domain
(A record straight to the VPS, not proxied).

- **One hostname for everything.** `MQTT_PUBLIC_HOST=ssl://fleet.example.com:8883` and
  `MEDIA_RTMP_HOST=fleet.example.com:1935`, so no `mqtt.` or `media.` records are needed and the
  certificate only has to cover `fleet.example.com`.
- **Certificate chain.** `fullchain.pem` must be the CA's complete chain (leaf, `YE2`, `Root YE`
  cross-signed by ISRG Root X2, X2 cross-signed by X1). Leaf plus intermediate only fails on
  clients that lack the new Let's Encrypt roots. Fetch missing links from the AIA URL in each
  certificate. `privkey.pem` must be owned by UID 1000 (`emqx`) or the TLS listener refuses every
  handshake with `eacces`; `chown -R root` on the repo undoes it.
- **Renewal is not automated, on purpose.** No ACME client is installed on the server (certbot was removed). Before the certificate expires, install certbot again (`apt install certbot`). `docker-compose.prod.yml`
  mounts `${ACME_WEBROOT:-/var/www/certbot}` into Nginx, so `certbot certonly --webroot -w
  /var/www/certbot -d fleet.example.com` can renew with no downtime once an operator has accepted the
  Let's Encrypt terms. After renewing: copy `fullchain.pem`/`privkey.pem` into `infra/certs`,
  `chown 1000:1000`, `docker compose exec web nginx -s reload`, `docker compose restart emqx`.
- **Firewall.** `ufw` allows 22, 80, 443, 8883/tcp, 1935/tcp and 8000/udp only.
- **CPU.** The guide asks for 4 vCPU; this host has 2. A thorough people count keeps both cores busy
  for 8-18 s (the quick stage takes 1-2 s); watch video smoothness while one runs, and set
  `PEOPLE_THREADS=1` if streams stutter.
- **Secrets** live in `infra/.env.production` and `/root/drone-fleet-admin-login.txt` (mode 600).
  `DJI_APP_ID`, `DJI_APP_KEY` and `DJI_APP_LICENSE` are still empty: Pilot 2 cannot register until
  they are filled in and the API is recreated (`up -d`).

---

### 6.1 Encrypted video ingest (RTMPS)

Besides plain RTMP on 1935, the stack accepts **RTMPS** on **1936**: Nginx terminates TLS (TLS 1.2 or 1.3, the
certificate the dashboard already uses) and passes the stream to SRS on the compose network, so the video and the
stream key are encrypted between the encoder and the server. The address is the usual one with a different scheme and
port: `rtmps://<domain>:1936/live/<stream key>`. Stream keys, publish checks and recording work exactly as on 1935.

Check it from any computer with Node (nothing is published and no key is needed; it does the TLS and RTMP handshakes):

```bash
node tools/docker/rtmps-check.mjs <domain> 1936
```

**Know the limit.** Only encoders that can push `rtmps://` can use it (OBS, ffmpeg, most gateways and relays). DJI's own
apps (Pilot 2, DJI Fly) are only documented to push plain RTMP, and nobody has confirmed that they accept an `rtmps://`
address: try it on the real controller before relying on it. Where they cannot, encrypt the controller's leg another way:
a private LAN or APN, or a VPN on the controller or its network. Port 1935 stays open for them meanwhile.

## 7. Verification checklist

Run these once after the first deployment and after every upgrade.

- [ ] `$COMPOSE ps` shows all services running and `postgres`, `emqx`, `api` and `web`
      healthy
- [ ] `curl https://app.example.com/api/health` returns `ok: true`, `mqtt: true`,
      `mqttSubscribed: true`
- [ ] `curl -fsS https://app.example.com/healthz` returns `ok` with HTTP 200
- [ ] Recreating the API does not require restarting Nginx:

  ```bash
  $COMPOSE up -d --force-recreate api
  # within ~15 s:
  curl -fsS https://app.example.com/api/health
  ```
- [ ] Dashboard loads over HTTPS and an admin can sign in
- [ ] WebSocket connects (header shows **LIVE**, not **RECONNECTING**)
- [ ] `/internal/*` is not reachable from the internet:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://app.example.com/internal/mqtt/auth
  # 404
  ```

- [ ] MQTT TLS presents the right certificate and hostname:

  ```bash
  openssl s_client -connect mqtt.example.com:8883 -servername mqtt.example.com -brief </dev/null
  # Verification: OK
  ```

- [ ] Unknown MQTT credentials are rejected (proves the API auth hook is active):

  ```bash
  mosquitto_pub -h mqtt.example.com -p 8883 \
    --cafile /etc/ssl/certs/ca-certificates.crt \
    -u gw_does_not_exist -P wrong -t 'thing/product/none/osd' -m '{}'
  # Connection error: Connection Refused: not authorised.
  ```

  (`mosquitto_pub` comes from `mosquitto-clients`; point `--cafile` at your CA bundle, or
  use any other MQTT client.)

- [ ] Only the intended ports are published:

  ```bash
  $COMPOSE ps --format 'table {{.Service}}\t{{.Ports}}'
  ```

- [ ] A real controller completes Drone operator registration and appears on the map
- [ ] Starting a stream reaches `live` and plays over WHEP

---

## 8. Accounts and the first controller

### 8.1 Create accounts

```bash
# The account typed on the controller. It MUST have the pilot role: any other account is
# refused by /api/pilot/auth, which is what stops a dashboard user impersonating a gateway.
$COMPOSE exec api pnpm user:create -- --email pilot@example.com --password '<password>' --role pilot

# Dashboard accounts: Admin (runs the installation) and Sub-admin (permissions as given)
$COMPOSE exec api pnpm user:create -- --email ops@example.com   --password '<password>' --role subadmin
$COMPOSE exec api pnpm user:create -- --email admin2@example.com --password '<password>' --role admin

$COMPOSE exec api pnpm user:list
```

`user:create` updates the password and role if the email already exists.

Other commands:

```bash
# Reset a password without changing the role
$COMPOSE exec api pnpm user:password -- --email ops@example.com --password '<new>'

# Controllers
$COMPOSE exec api pnpm controller:list
$COMPOSE exec api pnpm controller:approve -- --sn <controller serial> --by '<admin email>'
$COMPOSE exec api pnpm controller:reject  -- --sn <controller serial> --reason '<why>'
$COMPOSE exec api pnpm controller:unbind  -- --sn <controller serial>

# Revoke a controller's MQTT credentials (also clears its aircraft bindings)
$COMPOSE exec api pnpm gateway:revoke -- --sn <controller serial>
```

### 8.2 Register the controller

On the RC Plus 2: **Pilot 2 → Cloud Services → `https://fleet.example.com/pilot`**, then sign in
with the `pilot`-role account.

The first sign-in creates a **pending** enrolment. A pending controller holds no MQTT
credentials and cannot report anything. An admin approves it in the dashboard (the **Awaiting
approval** block in the fleet rail) or with `controller:approve` above; the drone operator then taps
**Check approval** on the RC.

Approval also fixes which aircraft the controller may claim: the first topology it publishes
after approval binds those aircraft to it, and from then on `devices.gateway_sn` is sticky. A
different controller cannot take an aircraft that is already bound — transfer it with
`controller:unbind` first. `controller:approve --aircraft <sn,sn>` pre-binds the expected
aircraft when you know the inventory.

The controller reports its serial at sign-in; nothing is typed into the dashboard.

### 8.3 Upgrading an install that predates enrolment

Existing rows in `devices` already record the controller/aircraft relationship, so the only
step is to make them approved enrolments. Run this **before** deploying the new image, once:

```bash
$COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"' <<'SQL'
INSERT INTO controller_enrollments (controller_sn, status, approved_by, approved_at)
SELECT DISTINCT gateway_sn, 'approved', 'upgrade-backfill', now()
FROM devices WHERE gateway_sn IS NOT NULL
ON CONFLICT (controller_sn) DO NOTHING;

INSERT INTO controller_aircraft (controller_sn, aircraft_sn)
SELECT gateway_sn, sn FROM devices WHERE gateway_sn IS NOT NULL
ON CONFLICT DO NOTHING;
SQL
```

The tables exist only after the new API has booted once; if you are upgrading from an older
version, start the new stack, confirm `/api/health`, then run the SQL and restart the API. This
is deliberately not in `schema.sql`: it runs on every boot, and an automatic re-approval would
undo an admin rejection.

After the deploy, restart EMQX so existing MQTT sessions re-authenticate through the new ACL,
and reload the Pilot page on each RC:

```bash
docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml restart emqx
```

Check the result with `controller:list`: every live controller must read `approved` and list
its aircraft.

---

## 9. Day-2 operations

### 9.1 Logs

```bash
$COMPOSE logs -f api
$COMPOSE logs -f emqx
$COMPOSE logs -f srs
$COMPOSE logs -f web
```

Container logs are capped in `docker-compose.prod.yml` (3 files of 10 MB per service), so the
disk cannot fill up from them. Postgres, EMQX, the API and Nginx have Compose
healthchecks; `$COMPOSE ps` shows their state. For external monitoring, poll
`/api/health` and `/healthz`.

### 9.2 Backup

**Automatic.** `infra/backup.sh` is installed as `/usr/local/bin/drone-fleet-backup`
and `/etc/cron.d/drone-fleet-backup` runs it at 02:30 server time. It writes `db-<time>.sql.gz` and
`screenshots-<time>.tgz` to `/var/backups/drone-fleet`, checks both archives, and keeps 14 days.
(`crew-<time>.tgz` pilot-photo archives from older releases age out with the rest.)
Run it by hand any time with `drone-fleet-backup`; the log is `/var/log/drone-fleet-backup.log`.
These backups sit on the same server, so copy the folder off it now and then, for example
`rsync -a root@<server>:/var/backups/drone-fleet/ ~/drone-fleet-backups/`. A dump was restored into a
scratch database to prove it loads.

**By hand (any server).**

Back up four things: Postgres, the `screenshots` volume (captured feed stills), the environment
file and the certificates (plus `infra/branding/` if it holds a logo). The environment file and
certificates contain secrets; store the archive encrypted and offline.

```bash
set -a; . infra/.env.production; set +a

$COMPOSE exec -T postgres pg_dump --clean --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB" \
  > "backup-$(date +%F-%H%M).sql"

# Screenshot files; their metadata is in the Postgres dump above.
$COMPOSE exec -T api tar czf - -C /data screenshots > "screenshots-$(date +%F-%H%M).tar.gz"

tar czf "dji-secrets-$(date +%F).tar.gz" infra/.env.production infra/certs
```

Restore (the dump drops and recreates its tables; stop the API first so nothing writes during
the restore):

```bash
set -a; . infra/.env.production; set +a
$COMPOSE stop api
cat backup-YYYY-MM-DD-HHMM.sql | \
  $COMPOSE exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
$COMPOSE start api
```

Restore screenshots with `cat screenshots-….tar.gz | $COMPOSE exec -T api tar xzf - -C /data`.

`docker compose down` keeps the `pgdata` and `screenshots` volumes; `docker compose down -v`
**deletes them**.

### 9.3 Upgrade

**A server without git**: from the repository on your computer, copy the code
and rebuild. Never copy `.env`, `infra/certs` or `infra/.env.production`.

```bash
rsync -az --delete -e ssh \
  --exclude=node_modules --exclude=.git --exclude=.data --exclude=dist --exclude=/.env \
  --exclude=.claude --exclude=.opencode --exclude=package-lock.json --exclude=docs/screenshots \
  --exclude=infra/certs --exclude=infra/.env.production \
  ./ user@server:/opt/drone-fleet/
ssh user@server 'cd /opt/drone-fleet && drone-fleet-backup &&
  chown -R root:root . && chown 1000:1000 infra/certs/*.pem &&
  docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml up -d --build'
```

(`chown` matters: EMQX cannot read `privkey.pem` unless UID 1000 owns it.)

**Generic server:**

```bash
set -a; . infra/.env.production; set +a
$COMPOSE exec -T postgres pg_dump --clean --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB" > pre-upgrade.sql
git fetch --tags && git checkout <new-tag>
$COMPOSE up -d --build
# Nginx resolves api/srs per request; restart web only if a 502 persists (see 9.5).
$COMPOSE logs -f api
```

`schema.sql` is applied on every API start and uses `IF NOT EXISTS` / `ADD COLUMN IF NOT
EXISTS`, so it is idempotent. There is **no migration framework**: a column or index added
to an existing table must be written as an idempotent `ALTER` in `schema.sql`, and anything
destructive must be run manually. Always take a dump first.

The release that added zones, flights and drone operators changes nothing by hand. On its first start the
API creates the new tables, adds the 42 built-in zones once (a zone an admin deletes is not added
again), gives every aircraft a colour, and gives existing admin accounts the new `zones.manage` and
`crew.manage` permissions and the `flights.view` permission to every account that could already
view aircraft. A flight in progress when the API restarts is closed at boot, so an upgrade splits
it in two.

The release that introduced roles and branding also changes nothing by hand, but part of it is
**destructive**, so take the dump first. On start the API renames `superadmin` accounts to
`developer` and `user`/`viewer` accounts to `subadmin`, removes the retired `crew.manage`
permission, and **drops the drone operator profiles** (`crew_members`, and `crew_id` on devices and
flights). Drone operator login accounts are kept. The old `crew` Docker volume is no longer mounted; remove
it with `docker volume rm` once you no longer want its photos. Install the updated
`infra/backup.sh` over `/usr/local/bin/drone-fleet-backup` so the nightly job stops looking for it.
Branding comes from the `BRAND_*` settings (defaults keep Drone Fleet).

Expected impact: a short API outage; WebSocket clients reconnect with backoff. Active
streams may need a restart — leaving and reopening the Live wall stops and restarts them
for every online aircraft.

**Releases that add server-side sessions sign everybody out once.** Tokens issued before the
`sessions` table existed carry no `jti` that the table knows, so every browser and every
controller returns 401 on its first request after the upgrade and has to sign in again. The
`/pilot` controller does this on its own the next time it loads the page. Plan the upgrade
outside a flight and tell the operators beforehand; it is a one-off, not a per-release cost.

### 9.4 Rollback

```bash
git checkout <previous-tag>
$COMPOSE up -d --build
# Nginx resolves the new upstream IPs automatically; see 9.5 if a 502 persists.
```

Database changes are **not** rolled back by the old image. If the previous release cannot
read the new schema, restore `pre-upgrade.sql` first.

### 9.5 Nginx upstream resolution after a recreate

Nginx uses Docker's embedded DNS (`127.0.0.11`) and resolves `api` and `srs` per request.
After Compose recreates either container, Nginx picks up the new IP within the 10 s resolver
TTL; a `restart web` is no longer normally required. If a 502 persists longer than that,
check `$COMPOSE logs web` and restart it as a fallback:

```bash
$COMPOSE restart web
```

### 9.6 Database growth

Telemetry and the raw MQTT log are written continuously and **there is no retention job**.
Watch disk usage:

```bash
set -a; . infra/.env.production; set +a
docker system df -v
$COMPOSE exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "select relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_catalog.pg_statio_user_tables order by pg_total_relation_size(relid) desc;"
```

If the volume grows, take a backup and prune old rows manually (for example
`telemetry_samples` older than N days and `mqtt_log` older than N days) until a retention
job exists.

The **audit trail** (`audit_log`) is the exception: it is meant to be kept, grows by a few hundred bytes a
request that changes something, and the database refuses to update or delete its lines. Export old months from the
Audit log screen (CSV or JSON) to archive them; check the whole chain with the API `GET /api/audit/verify` (the screen has no button for it). It is in the nightly
database dump, so a restore brings it back; the dump is also what proves a later restore is complete.

### 9.7 Scaling

Run **one** API instance. The WebSocket hub is in-process and there is no Redis fan-out, so
scaling `api` horizontally would split connected dashboards across instances. Scale by
increasing the VM size, not replica count.

### 9.8 Certificate renewal

See section 4.2. After replacing the files, reload Nginx and restart EMQX.

---

## 10. Security checklist

- [ ] Every placeholder replaced: `JWT_SECRET`, `EMQX_NODE_COOKIE`, `POSTGRES_PASSWORD`,
      `MQTT_PASSWORD`, DJI credentials
- [ ] `infra/.env.production` is mode `600` and ignored by git
- [ ] `infra/certs/privkey.pem` is mode `600` and ignored by git
- [ ] Only 80, 443, 8883, 1935 and 8000/udp are reachable from the internet
- [ ] `https://app.example.com/internal/mqtt/auth` returns 404
- [ ] EMQX dashboard (18083) and SRS HTTP API (1985) are not published
- [ ] Postgres (5432) is not published
- [ ] `curl https://app.example.com/api/health` reports `mqtt: true` and
      `mqttSubscribed: true`
- [ ] Unknown MQTT credentials and wildcard subscriptions are denied (section 7)
- [ ] Each controller has its own `gw_<serial>` credential; revoke retired controllers
- [ ] Sessions expire after 12 h; `PUBLIC_HOST` is the real domain so the cookie is `Secure`
- [ ] Restoring a database dump also restores `sessions`; a missing row signs that user out,
      it does not let them in
- [ ] Host-specific hardening done: SSH keys only, automatic security updates, time sync
- [ ] A restore from backup has actually been tested

Per-controller MQTT authorization is only active with `infra/docker-compose.prod.yml`,
because only that file mounts `infra/emqx/emqx.conf`. The development compose file does not.

RTMP ingest on 1935 is plaintext and SRS does not authenticate publishers; the stream key is the
only secret. Do not log stream keys, and treat the URL handed to Pilot 2 as sensitive. RTMPS on 1936 (section 6.1)
encrypts the key and the video for encoders that can use it.

---

## 11. Troubleshooting

| Symptom | Likely cause | Check / fix |
| --- | --- | --- |
| `web` restart-loops | Nginx cannot resolve `api` or `srs` | `$COMPOSE ps`; start the missing service; check `$COMPOSE logs web` |
| 502 on `/api` or `/ws` | API down or still starting | `$COMPOSE logs api`; wait for `mqttSubscribed`; `$COMPOSE ps` |
| 502 after an upgrade | API still starting, or resolver TTL not expired | wait ~15 s; if it persists, `$COMPOSE restart web` |
| Certificate error in Pilot 2 | CA not trusted by the controller, or incomplete chain | Use `fullchain.pem`; try a CA DJI documents (see hardware guide §3) |
| `/pilot` loads, licence step fails | Placeholder or wrong DJI credentials | `DJI_APP_ID` / `DJI_APP_KEY` / `DJI_APP_LICENSE`; activation email completed |
| MQTT step fails | API down (EMQX auth hook denies), 8883 blocked, wrong host, untrusted cert | `$COMPOSE logs api` and `emqx`; `MQTT_PUBLIC_HOST`; firewall; cert SAN |
| Dashboard bounces back to login after a successful sign-in | Session cookie not being stored | Access the exact host in `PUBLIC_HOST` over HTTPS; check the browser's cookie storage (third-party/incognito blocking); check clock skew |
| Controller online, no telemetry | Topology received but OSD not mapping | `GET /api/debug/messages` as admin; compare with `docs/hardware-bring-up.md` §5 |
| Aircraft disappears after ~45 s | Controller stopped publishing | Offline sweep; check controller connectivity and Pilot 2 |
| Tile stuck at `STARTING` | Drone operator rejected the stream, or `live_capacity` is missing | API logs; `live_capacity` in the device row; `MEDIA_RTMP_HOST` reachable |
| Tile never reaches `LIVE` | SRS `on_publish` cannot reach the API, or RTMP never arrived | `$COMPOSE logs srs`; port 1935; API reachable from `srs` |
| Video `LIVE` but black / no frame | WebRTC media path blocked | UDP 8000 open; `PUBLIC_IP` matches the VM's public IP; browser not blocking mixed content |
| All MQTT clients denied after a restart | API not up yet, EMQX auth hook failing | Start API first; `$COMPOSE ps`; EMQX retries on reconnect |
| Disk filling up | No telemetry/log retention | Section 9.6 |

Useful one-liners:

```bash
$COMPOSE ps
$COMPOSE logs --tail=200 api
curl -fsS https://app.example.com/api/health
docker stats --no-stream
```

---

## 12. Known limitations before calling this production-ready

- **The stack has been validated locally, not on a real server.** Images, Compose health,
  login, `/internal/*` blocking, MQTT over TLS authentication and Nginx recovery after an
  API recreate passed with self-signed certificates. DNS, trusted certificates, firewall
  rules and DJI hardware still have to be validated on the target host.
- **The API image runs TypeScript through `tsx`** and installs dev dependencies. Do not add
  `--prod` to the install until the API has a compile step; then run `node dist/index.js`
  and drop `tsx`/`typescript` from the runtime image.
- **The WSS listener is configured but not published.** It shares the mounted certificate
  with MQTT/8883; only 8883 is exposed.
- **`SRS_RTMP_PORT`/`SRS_WEBRTC_PORT` are for local smoke tests.** On a real server keep
  1935 and 8000; changing the WebRTC port also changes what clients must reach.
- **No migration framework.** `schema.sql` is idempotent but does not evolve existing
  columns automatically.
- **No telemetry retention or alerts.** Disk growth is manual.
- **No HTTP-FLV fallback in the player** — WHEP only.
- **Single API instance.** No Redis fan-out; the Redis service in the dev compose is unused.
- **No automated certificate renewal.**
- **No metrics, tracing or centralised logs.** Health endpoint and `docker logs` only.
- **No image registry or CI/CD.** Builds happen on the server; pin tags and keep the
  previous checkout for rollback.
- **The default Drone operator OSD mapper is still provisional** until real captures are
  supplied and confirmed.
- **RTMP is unauthenticated and plaintext.**
