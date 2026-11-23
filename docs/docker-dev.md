# Dockerised development

This is the production-parity development stack: Postgres, EMQX, SRS, the API, Vite and
the simulator all run in Docker. Only Docker and Docker Compose are required to run the
application; Node, pnpm, MediaMTX and Postgres do not need to be installed on the host.

The host `pnpm dev` flow in the root README still exists and remains faster on Linux/macOS.
Use this stack when you want one reproducible environment, production-like services, or a
Windows setup without host-side native dependencies.

---

## Quick start

From the repository root:

```bash
docker compose -f infra/docker-compose.dev.yml watch
```

Or, on Windows Git Bash / Linux / macOS:

```bash
./run.sh --docker
```

`run.sh --docker` checks Docker, runs the preflight when Node is available, then starts
`docker compose watch`. `pnpm docker:dev` is the same as the raw Compose command if you
have pnpm on the host.

Run `docker compose -f infra/docker-compose.dev.yml exec api npm run admin` to create
the first developer account, then open **<http://localhost:5174>** and sign in with that account.
See [permissions and account setup](access-control.md).

The first start builds `dji-fleet-dev:local` (Node 22, pnpm, ffmpeg, curl) and pulls
Postgres, EMQX and SRS. Later starts reuse the layers.

---

## Services and ports

| Service | Container port | Host port | Purpose |
| --- | --- | --- | --- |
| `web` | 5173 | **5174** | Vite dev server and dashboard |
| `api` | 3000 | 3001 | Fastify API; `/api/health` for debugging |
| `emqx` | 1883 | 1884 | MQTT broker with the same auth/ACL hooks as production |
| `srs` | 1935 | 1936 | RTMP ingest |
| `srs` | 1985 | 1986 | SRS HTTP API / WHEP signalling (debugging only) |
| `srs` | 8080 | 8081 | HTTP-FLV (not used by the player) |
| `srs` | 8000/udp | **8000/udp** | WebRTC media for a browser on this host |
| `postgres` | 5432 | — | Internal only; use `docker compose exec` |

These defaults deliberately avoid the host `pnpm dev` ports (5173/3000/1883/1935), so the
two modes can run side by side. The SRS WebRTC port must stay `8000/udp`: the candidate
advertised in the SDP is `127.0.0.1:8000`.

Override the `DEV_*` variables in your shell or via `--env-file`:

| Variable | Default | Use |
| --- | --- | --- |
| `DEV_WEB_PORT` | `5174` | Dashboard host port |
| `DEV_API_PORT` | `3001` | API host port |
| `DEV_MQTT_PORT` | `1884` | EMQX host port |
| `DEV_RTMP_PORT` | `1936` | SRS RTMP host port |
| `DEV_SRS_HTTP_PORT` | `1986` | SRS HTTP API host port |
| `DEV_SRS_FLV_PORT` | `8081` | SRS HTTP-FLV host port |
| `DEV_SRS_CANDIDATE` | `127.0.0.1` | WebRTC candidate IP; set the host LAN IP for a remote browser |
| `DEV_PUBLIC_HOST` | `localhost` | Session cookie host; keep `localhost` over plain HTTP |
| `DEV_MQTT_PUBLIC_HOST` | `tcp://localhost:1884` | What Pilot 2 is told to connect to; the scheme is required |
| `DEV_MEDIA_RTMP_HOST` | `srs:1935` | RTMP host given to the simulator/controller |
| `DEV_SRS_HTTP_PORT`, `DEV_SRS_FLV_PORT` | `1986`, `8081` | SRS debug endpoints, bound to `127.0.0.1` only |
| `DEV_DJI_APP_ID` / `DEV_DJI_APP_KEY` / `DEV_DJI_APP_LICENSE` | dev placeholders | Satisfy the Pilot page's licence gate |
| `DEV_SIM_DRONES`, `DEV_SIM_VIDEO`, `DEV_SIM_RATE_MS`, `DEV_SIM_ORIGIN_*` | 3 / 1 / 1000 / Dhaka | Simulator shape |

Example:

```bash
DEV_WEB_PORT=5173 DEV_API_PORT=3000 \
  docker compose -f infra/docker-compose.dev.yml watch
```

The `DEV_` prefix keeps the host `.env` from changing the container wiring. The API's
internal `MQTT_URL`, `DATABASE_URL` and media URLs are hardcoded to service names.

---

## Editing code

The dev image bakes the source in; it does **not** bind-mount the repository. This avoids
Windows bind-mount watcher and `node_modules` problems. `docker compose watch` syncs edits
into the running containers:

- `apps/api/src` and `apps/api/schema.sql`: sync + restart the API.
- `tools/simulator/src`: sync + restart the simulator.
- `apps/web/src` and `index.html`: sync; Vite HMR applies the change.
- `packages/protocol/src`: sync + restart API, web and simulator.

If you edit dependencies (`package.json`, `pnpm-lock.yaml`) or the dev Dockerfile, rebuild:

```bash
docker compose -f infra/docker-compose.dev.yml up -d --build
```

`docker compose up` without `watch` uses the source baked into the image; it will not see
source edits until you rebuild.

---

## Common commands

```bash
# Detached, no file watching
docker compose -f infra/docker-compose.dev.yml up -d --build

# Status and logs
docker compose -f infra/docker-compose.dev.yml ps
docker compose -f infra/docker-compose.dev.yml logs -f api

# Users (Postgres is in use, so this is safe while the API runs)
docker compose -f infra/docker-compose.dev.yml exec api \
  pnpm user:create -- --email pilot@example.com --password '…' --role pilot

docker compose -f infra/docker-compose.dev.yml exec api pnpm user:list

# Stop; keep the Postgres volume
docker compose -f infra/docker-compose.dev.yml down

# Stop and delete the database
docker compose -f infra/docker-compose.dev.yml down -v
```

Host-side E2E checks (Node and Chrome required only for these):

```bash
BASE_URL=http://localhost:5174 node tools/e2e/dashboard-shot.mjs
BASE_URL=http://localhost:5174 node tools/e2e/pilot-flow.mjs
BASE_URL=http://localhost:5174 node tools/e2e/multi-viewer.mjs
```

Preflight:

```bash
node tools/docker/preflight.mjs --dev
```

---

## How it is wired

- **EMQX** authenticates clients through `http://api:3000/internal/mqtt/auth` and checks
  ACLs through `/internal/mqtt/acl`, exactly like production. The explicit `body` blocks in
  `infra/emqx/emqx.dev.conf` are required: without them the API receives no
  username/topic/action and denies.
- **The API** starts its HTTP server before connecting to MQTT. EMQX calls the API back to
  authenticate that connection, so connecting earlier races the server and can be refused.
  The API also sets `reconnectOnConnackError: true`; the simulator does the same.
- **SRS** is the same media server as production. `infra/srs/srs.dev.conf` points its
  publish/unpublish hooks at `api:3000`. The browser plays through
  `POST /api/streams/:id/whep`; the API proxies the SDP exchange to `srs:1985`. Vite does
  not proxy `/rtc` or `/media`, and the SRS HTTP/FLV ports are bound to loopback, so the
  stream key and media address never reach a browser.
- **Compose Watch** replaces bind mounts. The watchers run on the host and write into the
  containers, which is reliable on Windows.

---

## Using a real controller with this stack

This stack is for local development. It has no TLS, the MQTT listener is plaintext, and
EMQX credentials for real controllers should be treated as development-only.

If you still want to point a controller at it on a trusted LAN:

1. Set `DEV_PUBLIC_HOST=localhost` (so cookies are not marked `Secure` over HTTP), but
   access the Pilot page at `http://<host-lan-ip>:5174/pilot`.
2. Set `DEV_MQTT_PUBLIC_HOST=tcp://<host-lan-ip>:1884`.
3. Set `DEV_MEDIA_RTMP_HOST=<host-lan-ip>:1936` and ensure TCP 1936 is reachable from the
   controller.
4. Set `DEV_SRS_CANDIDATE=<host-lan-ip>` if the dashboard browser is not on the Docker host,
   and allow UDP 8000 inbound.
5. Provide real DJI credentials through `DEV_DJI_APP_*`.

For anything outside a trusted lab, use `infra/docker-compose.prod.yml`; it has TLS,
per-controller credentials and ACLs.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `port is already allocated` | Another process owns the port. Stop `pnpm dev` or override the matching `DEV_*` port. |
| API unhealthy on first start | EMQX's HTTP auth connector can take ~15 s to reach the API after a cold start. The API retries; wait for `mqttSubscribed: true`. |
| Dashboard loads but has no aircraft | Check `docker compose logs simulator`; it waits for API health. If it shows `Not authorized`, the API/EMQX auth path is still starting; it now retries automatically. |
| Tile stays `starting` / no video | Check `docker compose logs srs` and the API logs. The browser must reach UDP 8000; for a remote browser set `DEV_SRS_CANDIDATE` to the host LAN IP. |
| Code edits do nothing | Use `docker compose watch`, not `up`. If you ran `up`, run `up -d --build`. Dependency changes always need a rebuild. |
| `docker compose watch` says the path is in a bind mount | You are on an old checkout before the source-baked dev image. Pull the current `infra/docker-compose.dev.yml` and `infra/docker/Dockerfile.dev`. |
| Browser video fails after changing `DEV_SRS_CANDIDATE` | The SDP candidate is baked per session. Stop/start the SRS container and reopen the live wall. |

---

## Verified locally

On 2026-10-26, with Docker 29.9.2 / Compose v5.6.1 on Windows 11:

- `docker compose -f infra/docker-compose.dev.yml up -d --build` brought all six services
  up; API healthy with `mqttSubscribed: true` and `devices: 3`.
- `dashboard-shot.mjs` against `http://localhost:5174`: login, rename, search, live wall,
  all three tiles `live` with video, focus video `readyState: 4`, width 1280.
- `multi-viewer.mjs`: two sessions shared one stream; navigation and a hard close did not
  disturb the other, and no stream key appeared in 253 WebSocket frames or 24 JSON
  responses.
- `pilot-flow.mjs`: bridge calls `api → thing → liveshare`.
- `docker compose watch` synced changes and restarted the API/simulator.
- Postgres persistence and the SRS WebRTC path were exercised by the E2E run.
