# Drone Fleet — drone command console

![Node](https://img.shields.io/badge/node-%E2%89%A522-5FA04E?logo=node.js&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.20.0-F69220?logo=pnpm&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-POC-orange)

Live telemetry, map and video control for DJI aircraft through DJI Cloud API.
The aircraft reach this system through DJI Pilot 2 on an RC Plus 2 Enterprise; the cloud
terminates MQTT, HTTPS and RTMP, and pushes state to a React dashboard.

This repository is the implementation of the plan in
[`docs/poc-plan.md`](./docs/poc-plan.md). One build serves every customer: name, colours and
logo come from settings, so it can be installed on a customer's own server under their brand
([`docs/on-premise.md`](./docs/on-premise.md)).

**Hardware is not required to run it.** A simulator publishes Pilot-compatible MQTT
messages for three aircraft. Development can use embedded services with `pnpm dev`, or the
fully Dockerised production-parity stack in
[`docs/docker-dev.md`](./docs/docker-dev.md).

**New to the system?** Start with [`docs/operator-guide.md`](./docs/operator-guide.md):
what Pilot 2 is, the three accounts, how a drone is added, and how to use the dashboard.

Hardware-only checks are tracked separately in
[`docs/hardware-bring-up.md`](./docs/hardware-bring-up.md).
The production runbook is [`docs/deployment.md`](./docs/deployment.md).

Documentation index: [`docs/README.md`](./docs/README.md).

---

## Quick start

```bash
pnpm install
npm run admin   # create the first developer account interactively, before starting PGlite
pnpm dev
```

Or, on a machine that may be missing Node, pnpm, dependencies or MediaMTX:

```bash
./run.sh          # installs whatever is missing, then starts everything
./run.sh --core   # broker, API and simulator only
```

`run.sh` needs Bash — on Windows, use Git Bash.

Open <http://localhost:5173> and sign in with the developer account you created.

User management, per-drone permissions, account passwords, retained-history deletion
and adaptive video are documented in [access control](docs/access-control.md).

`pnpm dev` starts five processes in dependency order — the broker first, then the API once
it has subscribed, then the media server, dashboard and simulator:

| Process | Port | What it is |
| --- | --- | --- |
| MediaMTX | 1935, 8889 (loopback) | RTMP ingest and WebRTC for development; the API proxies WHEP |
| `@dji/dev-broker` | 1883 | Aedes MQTT broker (stands in for EMQX) |
| `@dji/api` | 3000 | Fastify API, MQTT ingest, WebSocket hub, embedded Postgres |
| `@dji/simulator` | — | Three simulated aircraft gateways publishing topology and OSD |
| `@dji/web` | 5173 | Vite + React dashboard |

The launcher waits for the broker to accept connections and for `/api/health` to report
`mqttSubscribed: true` before starting the simulator. The simulator publishes topology once
when it connects, so starting it earlier would leave the dashboard empty until it reconnects.

No Postgres, Redis or Docker is needed for this mode.

### Fully Dockerised development (production parity)

The other supported development mode runs the same Postgres, EMQX and SRS as production,
plus the API, Vite and the simulator, entirely in Docker. Only Docker and Docker Compose
are required; Node, pnpm and MediaMTX do not need to be installed.

```bash
docker compose -f infra/docker-compose.dev.yml watch   # or: ./run.sh --docker
```

Create the first developer account with `docker compose -f infra/docker-compose.dev.yml exec api npm run admin`,
then open <http://localhost:5174> and sign in with that account.

| Service | Host port | Purpose |
| --- | --- | --- |
| Vite dashboard | **5174** | Dashboard and Pilot page |
| API | 3001 | `/api/health` |
| EMQX | 1884 | Plain MQTT with the production auth/ACL hooks |
| SRS | 1936 tcp / 8000 udp | RTMP ingest and WebRTC playback |

The defaults avoid the host `pnpm dev` ports, so both modes can run together. The image bakes
the source in; `docker compose watch` syncs edits into the containers. See
[`docs/docker-dev.md`](./docs/docker-dev.md) for overrides, hardware-on-LAN notes, CLI
commands and troubleshooting.

### Live video in development

Press **Go live** on an aircraft. The backend issues an RTMP URL, the simulator runs ffmpeg
and publishes a test pattern to it, MediaMTX converts it to WebRTC, and the tile switches
to `live` and plays it over WHEP. Set `SIM_VIDEO=0` to disable the simulated encoder.

MediaMTX is not committed. `./run.sh` downloads it into `.data/mediamtx/`; to install it
manually (the URL below is the Windows build; Linux/macOS use the matching
`mediamtx_v1.21.2_<os>_<arch>` asset from the same release page):

```bash
curl -L -o .data/mediamtx.zip https://github.com/bluenviron/mediamtx/releases/download/v1.21.2/mediamtx_v1.21.2_windows_amd64.zip
unzip -o .data/mediamtx.zip -d .data/mediamtx
```

The launcher prefers `.data/mediamtx/` and falls back to the older `tools/media/mediamtx/`.
If the binary is absent, video stays at `starting` and everything else still runs.

Production uses SRS (`infra/`) instead. The browser plays through
`POST /api/streams/:id/whep`; the API proxies the SDP exchange to the internal media server,
so neither the stream key nor the media address ever reaches a browser.

---

## What is implemented

### Features

- **Operations map** — every aircraft as a marker in its own colour with its name, the last
  ten minutes as a trail, no-fly zones and geofences, and a details card.
- **Live wall** — one tile per online aircraft, shared WebRTC streams, drag to arrange.
  Hover a tile and press **Rec** to record the feed **on your own computer** (nothing is
  uploaded, no extra load on the server). Click a tile for the full-screen view with quality
  control and **Capture**.
- **Screenshots** — stills from a live feed, stored on the server, with an offline AI count of
  the people in them and an operator-verified number that is the one to report.
- **Zones and geofences** — draw circles and polygons; 42 built-in sites. No-fly zones warn
  before the edge and alert inside; a geofence alerts when a flying aircraft leaves it.
- **API access** — read-only tokens so a customer's own program (an AI analysis tool) can read the drones,
  telemetry, flights, alerts, pictures, recordings, one JPEG or the live video of a drone, and a live WebSocket.
  See `docs/api.md`.
- **Alerts** — banner, sound and an Alerts screen with acknowledge, for zones, a lost link to a flying
  aircraft and a low or critical battery.
- **Flight history** — every take-off to landing recorded by itself, with path, direction,
  height and speed charts, and a replay.
- **Drones** — rename an aircraft, add a nickname (label) beside the name, and give it a colour.
- **Video-only drones** — a DJI Mini streaming RTMP from DJI Fly shows its video on the Live wall
  (no position or telemetry), from an address and key made on the Drones screen.
- **Users and permissions** — Developer, Admin, Sub-admin and Drone operator roles; every Admin is its
  own customer and sees only its own accounts; per-aircraft grants; passwords an admin sets
  work as set and anyone may change their own.
- **Controllers and aircraft** — approve each remote controller by hand, then disable or
  delete aircraft.

The sidebar search filters the fleet and the wall by name, serial or model.

| Area | Status |
| --- | --- |
| Pilot 2 login page with JSBridge registration | `apps/web/src/pages/PilotLogin.tsx`; sequence verified against DJI's demo |
| Topology (`sys/product/{sn}/status`) | Online/offline, sub-device discovery, stale timeout |
| Telemetry ingest (`osd`, `state`) | Canonical sample + raw payload, batched-friendly storage |
| Camera capabilities (`live_capacity`) | Persisted per aircraft; drives stream start |
| REST API | Auth, devices, telemetry, trail, streams, Drone operator endpoints, health, MQTT message log |
| WebSocket | `devices` channel, per-connection `watch`/`unwatch`, stream snapshot on connect, reconnect with backoff |
| Dashboard | Map tab with markers, trail and details card; Live wall watches its visible tiles; shared streams survive navigation |
| Display names | Admin rename in the fleet list; an optional label (nickname) beside the name; search filters the list and the wall by name, label, serial or model |
| Stream control | The API owns one stream per aircraft/video; viewers watch, admins stop/resume and change quality (`live_start_push`, `live_stop_push`, `live_set_quality`, `live_lens_change`) |
| Video playback | WHEP proxied by the API (stream keys never reach browsers); one stream serves many viewers; client-side reconnect and stall recovery |
| MQTT authorization | Per-controller credentials issued at login; EMQX HTTP auth/ACL confines each controller to its own serial (production compose) |
| Simulator | Topology, OSD, live capacity, service replies, graceful offline |
| Access control | Argon2id passwords, live RBAC and per-drone grants, developer/admin/sub-admin/pilot accounts, passwords that work as the admin set them (users may change their own), rate-limited login |

## What is not implemented yet

These need either the media server, the hardware, or are simply later phases:

- Real video end to end against SRS and a real controller (MediaMTX + a simulated encoder is verified)
- HTTP-FLV fallback in the player (WHEP only today)
- Alerts by SMS, e-mail or chat (alerts show in the dashboard only)
- Telemetry and flight retention job
- Keeping one customer's fleet (aircraft, controllers, screenshots, zones, flights) apart from
  another's on the same installation: only accounts are separated per Admin today
- Multi-instance fan-out through Redis (the hub is in-process today)

---

## How it works

```
DJI Pilot 2 (RC Plus 2)                     This server
  │  HTTPS  /pilot  ──────────────────────►  Fastify: licence verify, login, MQTT creds
  │  MQTT   thing/product/... ────────────►  MQTT ingest ──► registry ──► Postgres/PGlite
  │  RTMP   rtmp://media/live/<key> ──────►  SRS ──► WHEP/FLV ──► browser
  │                                             │
  └────────────── browser ◄── WebSocket ────────┘
```

- `apps/api/src/mqtt.ts` subscribes to the DJI topics and correlates service replies by `tid`.
- `apps/api/src/registry.ts` owns device identity, online state and capacity.
- `apps/api/src/server.ts` wires the plugins and route modules; `src/routes/` holds the REST
  and `/ws` handlers.
- `packages/protocol` holds the zod schemas and shared types for every MQTT and WebSocket message.

### Development storage

`DATABASE_URL` unset → an embedded Postgres (PGlite) in `.data/pglite`, same SQL as
production. Set `DATABASE_URL=postgres://…` to use a real Postgres; no code changes.

`MQTT_URL` defaults to `mqtt://127.0.0.1:1883`, the local Aedes broker. Point it at EMQX
in production.

---

## Pilot 2 registration sequence

Implemented exactly as verified against DJI's archived demo:

1. `platformVerifyLicense(appId, appKey, license)` then `platformIsVerified()`
2. Login against `/api/pilot/login`
3. `platformLoadComponent('api', { host, token })`, then `apiSetToken(token)`
4. `GET /api/pilot/user-info` returns `mqtt_addr`, `mqtt_username`, `mqtt_password`
5. `platformLoadComponent('thing', { host, username, password, connectCallback })`
6. On connect: `platformSetWorkspaceId(id)`, `platformSetInformation(platform, workspace, desc)`
7. `platformLoadComponent('liveshare', { videoPublishType: 'video-on-demand', statusCallback })`

The Pilot page is at `/pilot`. It only functions inside Pilot 2's WebView; opening it in a
browser shows an explanatory notice. `tools/e2e/pilot-flow.mjs` exercises the same page
with a fake bridge.

---

## Configuration

Copy `.env.example` to `.env`. Local development already has a `.env`.

| Variable | Purpose |
| --- | --- |
| `PORT` | API port, default 3000 |
| `PUBLIC_HOST` | Public hostname; a non-`localhost` value enables secure cookies |
| `JWT_SECRET` | Session signing key |
| `npm run admin` | Interactive server CLI creates the first developer account; no account is seeded at boot |
| `DATABASE_URL` | Postgres connection; unset uses embedded PGlite |
| `DATA_DIR` | PGlite data directory (development only) |
| `MQTT_URL` | Broker URL, default `mqtt://127.0.0.1:1883` |
| `MQTT_PUBLIC_HOST` | Scheme://host:port given to Pilot 2 (e.g. `ssl://mqtt.example.com:8883`); the scheme is required |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | Server's own broker account; controllers get per-controller credentials |
| `MQTT_CREDENTIAL_TTL_HOURS` | Controller credential lifetime, default 168 |
| `CORS_ORIGINS` | Allowed browser origins; empty in production (same-origin) |
| `DJI_APP_ID`, `DJI_APP_KEY`, `DJI_APP_LICENSE` | Cloud API app credentials |
| `DJI_WORKSPACE_ID`, `DJI_WORKSPACE_NAME` | Workspace shown in Pilot 2 |
| `MEDIA_RTMP_HOST` | RTMP ingest host the backend tells Pilot 2 to push to |
| `MEDIA_WHEP_INTERNAL_TEMPLATE` | Internal WHEP target for the API's proxy; must contain `{key}` and is never sent to browsers |
| `STREAM_LINGER_SECONDS`, `STREAM_START_DEADLINE_SECONDS`, `STREAM_REPLY_TIMEOUT_MS` | Viewer linger, failed-start deadline and controller reply timeout |
| `SIM_DRONES`, `SIM_VIDEO`, `SIM_RATE_MS`, `SIM_ORIGIN_*` | Simulator shape and location |

`.env` configures `pnpm dev`. The Docker dev stack deliberately does not read it; it uses the
`DEV_*` overrides documented in [`docs/docker-dev.md`](./docs/docker-dev.md). The production
stack reads `infra/.env.production` and overrides the values that are internal to the
compose network. Production additionally requires `EMQX_NODE_COOKIE` (an Erlang
distribution cookie) and accepts optional `SRS_RTMP_PORT` / `SRS_WEBRTC_PORT` overrides for
local smoke tests.

Until the real app credentials exist, `.env` holds placeholders. Real registration will fail
licence verification until they are replaced.

---

## Scripts

| Command | Purpose |
| --- | --- |
| `./run.sh` | Bootstrap anything missing (Node, pnpm, deps, MediaMTX, `.env`), then start everything |
| `./run.sh --docker` | Preflight, then the Docker dev stack with Compose Watch |
| `pnpm dev` | Host mode, in dependency order: broker → API → MediaMTX, web, simulator |
| `pnpm dev:core` | Host mode: broker → API → simulator only |
| `pnpm docker:dev` | Docker dev stack with Compose Watch |
| `pnpm docker:dev:up` | Docker dev stack detached, with a build |
| `pnpm docker:dev:down` | Stop the Docker dev stack (keeps the Postgres volume) |
| `pnpm docker:preflight:dev` / `:prod` | Check ports / production env and certificates |
| `pnpm docker:prod` | Preflight, then start the production stack |
| `npm run admin` | Create a developer account in the configured database (hidden password prompt) |
| `pnpm --filter @dji/api test` | RBAC, retention, WebSocket and adaptive-quality checks |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm lint` | ESLint across the repo |
| `pnpm format` / `pnpm format:check` | Prettier write / verify |
| `pnpm build` | Build the web app; typecheck the rest |
| `BASE_URL=http://localhost:5173 node tools/e2e/dashboard-shot.mjs` | Log in and capture dashboard/stream screenshots |
| `BASE_URL=http://localhost:5173 node tools/e2e/pilot-flow.mjs` | Drive the Pilot page through a fake JSBridge |
| `BASE_URL=http://localhost:5173 node tools/e2e/multi-viewer.mjs` | Two viewers share one stream; navigation and a hard close do not disturb the other; no stream keys reach a browser |

Screenshots land in `.data/screenshots/` (gitignored). Add
`BASE_URL=http://localhost:5174` when running the E2E against the Docker dev stack.

---

## Development-only pieces (do not deploy)

None of these are in `infra/docker-compose.prod.yml`. They exist so the POC runs without
hardware or external services; delete them once the real stack and aircraft are validated.
The Docker dev stack is production-parity and uses Postgres, EMQX and SRS directly, so the
Aedes, PGlite and MediaMTX rows apply to host `pnpm dev` only.

| Piece | Where | Replaced in production by |
| --- | --- | --- |
| Simulator + ffmpeg | `tools/simulator/`, `SIM_*` in `.env` | Real aircraft + RC Plus 2 |
| Aedes broker | `tools/dev-broker/` | EMQX (`infra/emqx/emqx.conf`) |
| MediaMTX | `tools/media/` | SRS (`infra/srs/srs.prod.conf`) |
| Embedded Postgres | PGlite branch in `apps/api/src/db.ts`, `.data/pglite` | Postgres (`DATABASE_URL`) |
| Headless-browser checks | `tools/e2e/`, `puppeteer-core` | Nothing; CI only |
| Redis service | `infra/docker-compose.yml` | Nothing yet — the API never reads it |
| Ordered dev launcher | `tools/dev/` | Nothing; `pnpm dev` only |
| Vite proxies | `apps/web/vite.config.ts` (`/api`, `/ws`, `/media`, `/rtc`) | Nginx (`infra/nginx/app.conf.template`) |

Two image notes:

- The API container still runs TypeScript through `tsx` (`pnpm start`), so `tsx` and
  `typescript` are installed in the runtime image. Add a compile step and run
  `node dist/index.js` to drop them.
- The Dockerfiles copy `tools/dev-broker/package.json` and `tools/simulator/package.json`
  only so `pnpm install --frozen-lockfile` can resolve the workspace.

The PGlite branch is harmless when `DATABASE_URL` is set, but removing it also drops the
`@electric-sql/pglite` dependency and the `DATA_DIR` default.

---

## Development against real services (not production)

For the fully Dockerised production-parity stack, use
`infra/docker-compose.dev.yml` and [`docs/docker-dev.md`](./docs/docker-dev.md). The older
rig below is for exercising the API against real infrastructure while still running the
API itself on the host:

```bash
docker compose -f infra/docker-compose.yml up -d
```

Then set `DATABASE_URL`, `MQTT_URL` and the media hosts in `.env`. If the API and browser
should use SRS instead of MediaMTX for playback, set
`MEDIA_WHEP_INTERNAL_TEMPLATE=http://localhost:1985/rtc/v1/whep/?app=live&stream={key}`.
The API proxies WHEP to that address; the browser never calls SRS directly.

> **This compose file is a development rig, not a deployment.** It has no TLS, publishes
> 1883/5432/18083 to the host, and does not mount `infra/emqx/emqx.conf`, so per-controller
> EMQX auth and ACLs are **not active**. Never expose it to the internet. Use
> `infra/docker-compose.prod.yml` for anything a real controller connects to.

Redis is included for the planned multi-instance hub but is not read by the API yet.

For the real aircraft, follow [`docs/hardware-bring-up.md`](./docs/hardware-bring-up.md):
public VM, domain and TLS certificate, EMQX on 8883, SRS on 1935/tcp and 8000/udp, and the
Pilot 2 firmware check.

---

## Production deployment

The full runbook is **[`docs/deployment.md`](./docs/deployment.md)** — host prep, DNS, TLS, secrets,
first boot, verification, backups, upgrades, rollback and troubleshooting.

`infra/docker-compose.prod.yml` runs Postgres, EMQX, SRS, the API and Nginx with the
security layer enabled. Nginx is the only public HTTP(S) entry point; the broker and media
server terminate their own protocols. The API reaches EMQX as `mqtt://emqx:1883` inside
the compose network; the public `mqtt.` hostname is only what Pilot 2 is told to use.

The quick path:

1. Point `app`, `mqtt` and `media` DNS at the VM; put `fullchain.pem` and `privkey.pem` in
   `infra/certs/` (SANs must cover `app` and `mqtt`; a wildcard covers all three).
2. `cp infra/.env.production.example infra/.env.production`, fill it in, `chmod 600`.
3. Run `node tools/docker/preflight.mjs --prod` (or `pnpm docker:preflight:prod`) and fix
   every error. It checks placeholders, the certificates, DJI credentials and public ports.
4. `docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml up -d --build`
5. Run `… exec api npm run admin` to create the developer account, then use **Users and permissions**
   to create a drone operator with binding permissions. Then enter `https://app.example.com/pilot` on the controller and sign in with that account.

Open ports: 80/tcp, 443/tcp, 8883/tcp, 1935/tcp, 8000/udp. Postgres, the EMQX dashboard and
the SRS API stay on the internal network.

> The images and the full production stack were validated locally with self-signed
> certificates and an isolated Compose project: health, login, `/internal/*` 404, MQTT over
> TLS with good and bad credentials, and an API recreate that recovered through Nginx
> without restarting `web`. Real DNS, a trusted certificate, firewall rules and DJI
> hardware still have to be validated on the target server; follow the checklist in
> [`docs/deployment.md`](./docs/deployment.md).

### MQTT authorization

At login the Pilot page sends the controller serial number. The API issues a username
(`gw_<serial>`) and a random password bound to that gateway, stores only an Argon2id hash,
and rotates it on every login. EMQX calls the API for every connection and every
publish/subscribe:

- a controller may publish only its own `sys/product/<sn>/status`, its own
  `thing/product/<sn>/…` topics, and its linked aircraft's telemetry and command replies;
- it may subscribe to `services`, `requests_reply`, `events_reply`, `state_reply`,
  `property/set` and `drc/down` for itself and its linked aircraft, plus its own
  `sys/product/<sn>/status_reply` and network probes for itself and its linked aircraft;
- everything else is denied, including wildcards.

Revoke a controller with:

```bash
pnpm --filter @dji/api gateway:revoke -- --sn <controller serial>
```

When using the embedded dev database, stop the API before running CLI commands: PGlite
allows a single process at a time. With Postgres there is no such restriction.

---

## Repository layout

```text
apps/api/          Fastify backend, MQTT ingest, registry, REST, WebSocket
apps/web/          React + Vite dashboard and Pilot login page
packages/protocol/ zod schemas and shared types for MQTT and WebSocket
tools/simulator/   Pilot-compatible MQTT publisher
tools/dev-broker/  Local Aedes broker
tools/dev/         ordered dev launcher (broker → API → the rest)
tools/e2e/         Headless-browser checks
infra/             Docker Compose (dev and prod), Nginx template, EMQX/SRS configs
docs/              Operator guide, user manual, Bengali tutorial, on-premise install, deployment runbook, hardware checklist, POC plan
.github/           CI workflow (typecheck + build)
run.sh             Bootstrap launcher: installs missing tools, then runs pnpm dev
```
