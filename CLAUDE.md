# CLAUDE.md

Guidance for working in this repository. Read `README.md` for the product overview and
`docs/hardware-bring-up.md` for everything that requires real aircraft.

## What this is

A POC for a DJI fleet dashboard using DJI Cloud API. DJI Pilot 2 on an
RC Plus 2 Enterprise acts as the gateway: it loads our `/pilot` page, connects to our MQTT
broker, publishes telemetry, and pushes RTMP video. A Fastify backend ingests MQTT and
serves REST/WebSocket to a React dashboard.

The full app runs without hardware. Host `pnpm dev` uses an Aedes broker, embedded Postgres
(PGlite) and MediaMTX; the Docker dev stack uses Postgres, EMQX and SRS instead, plus the
same simulator and ffmpeg test video.

## Commands

```bash
./run.sh            # bootstrap Node/pnpm/deps/MediaMTX/.env if missing, then pnpm dev
./run.sh --docker   # Docker dev stack: Postgres, EMQX, SRS, API, Vite, simulator
pnpm install
pnpm dev            # host mode: broker → API → media, web, simulator
pnpm dev:core       # host mode: broker → API → simulator only
pnpm docker:dev     # Docker dev stack with Compose Watch (same as run.sh --docker)
pnpm docker:dev:up  # detached Docker dev stack with --build
pnpm docker:dev:down
pnpm docker:preflight:dev   # ports and image prerequisites
pnpm docker:preflight:prod  # env placeholders, certs, public ports
pnpm docker:prod    # preflight, then the production stack
pnpm typecheck      # all packages, must stay green
pnpm lint           # ESLint (TypeScript + React hooks)
pnpm format:check   # Prettier check; `pnpm format` writes
pnpm build          # web build; typechecks the rest
pnpm models:fetch   # people-counting model (YOLOX-L, ~217 MB, sha256-checked); run.sh does it
```

- Host dashboard: http://localhost:5173 — no account is seeded on a fresh checkout: create one
  with `user:create -- --role admin` (password ≥ 8 characters, `PASSWORD_MIN_LENGTH` in the protocol; a password an admin sets
  works as it is and the user may change it later). The e2e scripts read `DEMO_EMAIL` / `DEMO_PASSWORD` (their `admin12345` default is
  stale), and `CHROME_PATH` must point at Chrome (the defaults are Windows/Linux paths)
- Docker dashboard: http://localhost:5174 — same credentials (`DEV_ADMIN_*` overrides)
- Host API: http://localhost:3000; Docker API: http://localhost:3001 (`/api/health`)
- Host MQTT: `mqtt://127.0.0.1:1883`; Docker: 1884. Host RTMP 1935/WHEP 8889; Docker RTMP
  1936/WHEP through Vite and UDP 8000

E2E checks (headless Chrome via puppeteer-core; screenshots default to
`.data/screenshots/`, except `multi-viewer.mjs`, which defaults to
`docs/screenshots/`; set `SCREENSHOT_DIR` to put them elsewhere):

```bash
node tools/e2e/dashboard-shot.mjs   # login, map, start stream, verify video
node tools/e2e/pilot-flow.mjs       # Pilot page with a fake JSBridge
node tools/e2e/pilot-compat.mjs     # built /pilot renders + binds with no console errors
node tools/e2e/pilot-enrolment.mjs  # config gated, pending, approval, credentials, 403s
node tools/e2e/multi-viewer.mjs     # two viewers, shared stream, no key leaks
node tools/e2e/routes.mjs           # exact routes, menu paths survive refresh, 404 page
node tools/e2e/session-revocation.mjs  # sign-out, password change, admin reset, 4001
node tools/e2e/controller-revocation.mjs  # reject blocks, approval restores
node tools/e2e/admin-inventory.mjs  # controller registry + disable/enable
node tools/e2e/recording.mjs        # Rec on hover, survives tile → focus, no new WHEP, file plays
node tools/e2e/recording-bridge.mjs # stop + resume the stream mid-recording: still one file (NO_BRIDGE=1: two)

# pilot-flow, pilot-enrolment and the style-snapshot pilot page need a pilot account and an
# approved controller in the target database (override with PILOT_EMAIL / PILOT_PASSWORD /
# PILOT_CONTROLLER_SN). Host mode uses PGlite, so stop the API before the CLI commands:
pnpm --filter @dji/api user:create -- --email pilot@example.com --password pilot-e2e-pass --role pilot
pnpm --filter @dji/api controller:approve -- --sn 1ZTESTRC0000001 --by e2e

# pilot-compat runs against a preview of the build, and also fails if the stylesheet still
# carries cascade layers: serve `pnpm --filter @dji/web preview --port 4195`, then
BASE_URL=http://127.0.0.1:4195 CHROME_PATH=/usr/bin/google-chrome node tools/e2e/pilot-compat.mjs

# UI style parity (computed styles + screenshots at every width; run against a fresh dev server)
BASE_URL=http://localhost:5173 PARITY_SCOPE=quick node tools/e2e/style-snapshot.mjs compare
node tools/e2e/style-snapshot.mjs write .data/style-snapshots/baseline

# Against the Docker dev stack:
BASE_URL=http://localhost:5174 node tools/e2e/dashboard-shot.mjs
BASE_URL=http://localhost:5174 node tools/e2e/pilot-flow.mjs
BASE_URL=http://localhost:5174 node tools/e2e/multi-viewer.mjs
BASE_URL=http://localhost:5174 node tools/e2e/routes.mjs
```

User management. Host mode uses PGlite, so stop the API first. Docker dev uses Postgres and
can run the CLI while the stack is up:

```bash
pnpm --filter @dji/api user:create -- --email pilot@example.com --password '…' --role pilot
pnpm --filter @dji/api user:list
pnpm --filter @dji/api gateway:revoke -- --sn <controller sn>

docker compose -f infra/docker-compose.dev.yml exec api \
  pnpm user:create -- --email pilot@example.com --password '…' --role pilot
```

Production stack. Docker is available here; the images and full stack were validated with
self-signed certificates. A real server still validates DNS, trusted TLS, firewall and DJI
hardware:

```bash
node tools/docker/preflight.mjs --prod
docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml up -d --build
```

## Structure

```text
apps/api/              Fastify backend
  src/config.ts        all env parsing and media URL construction
  src/db.ts            PGlite (dev) or Postgres (DATABASE_URL)
  src/store.ts         SQL; no ORM
  src/mqtt.ts          MQTT client, service calls keyed by tid
  src/registry.ts      topology, OSD, capacity, online state
  src/mqtt-auth.ts     EMQX auth/ACL decisions per controller
  src/server.ts        composition root: plugins and route registration
  src/http/auth.ts     session guards and bearer-token parsing
  src/people/detector.ts  YOLOX person detection: multi-scale tiles, merge, counted/possible
  src/recordings/recorder.ts  server recording: ffmpeg stream copy into clips, indexed (see Server recordings)
  src/recordings/store.ts     SQL for the video archive (`store.recordings`): clips, uploads, folders, scope
  src/recordings/library.ts   uploads: stream to disk, probe, copy or convert, thumbnail, folders
  src/recordings/place.ts     the main videos folder: validate, save in `app_settings`, older folders, server folder picker
  src/janitor.ts       clean-up every minute: automatic clips by age, size and free disk; recording pause; log pruning
  src/geo/engine.ts    zone alerts: warning/breach per no-fly zone, exit per geofence, airborne only
  src/geo/seed.ts      seeds `builtin-zones.ts` (42 airports and military/government sites)
  src/flights/tracker.ts  flight start/end detection, live summary, pilot snapshot
  src/store-fleet.ts   SQL for zones, alerts, flights and aircraft colour
  src/http/scope.ts    which aircraft serials an account may read for a permission
  src/models.ts        `models:fetch` installer for the people-counting model
  src/api-tokens.ts    read-only API tokens: hash, narrowed access, resolveCredential (see API access)
  src/streams/export.ts  one JPEG or the live video of a drone for a customer's own program
  src/routes/          auth, admin (controller enrolment), devices, streams, screenshots,
                       pilot, internal, system, ws, zones (+alerts), flights, branding,
                       video-sources handlers
  src/streams/manager.ts  viewer sets, linger, retries, admin holds (all in memory)
  src/streams/whep.ts     API-side WHEP session proxy
  src/streams/media.ts    kicks a publisher off SRS (video-only drone disabled, removed, re-keyed)
  src/index.ts         wiring, seed, offline sweep
  src/cli.ts           user and gateway credential management
  schema.sql           tables, applied on startup (IF NOT EXISTS)
apps/web/              React + Vite + Tailwind dashboard and Pilot login page
  src/styles.css             Tailwind entry: theme/utilities + local style imports
  src/styles/tokens.css      canonical design tokens and @theme mapping
  src/styles/base.css        global reset, typography, focus, keyframes, reduced motion
  src/styles/decorative.css  login, wall, focus and tile effects that stay CSS
  src/styles/map.css         unlayered MapLibre control and marker skin
  src/ui/                    Tailwind primitives: Button, Field, BrandLockup, StatusPill, Spinner,
                             Badge, Notice, cn; surface.ts holds shared admin class recipes
  src/routes.ts              path ↔ screen mapping, per-route permission gate, navigate()
  src/pages/PilotLogin.tsx   JSBridge registration flow
  src/pages/Users.tsx        /users list, /users/new and /users/:id account forms
  src/pages/Inventory.tsx    /inventory/controllers and /inventory/aircraft
  src/pages/Zones.tsx        /zones: draw and edit no-fly zones and geofences (circle/polygon)
  src/pages/Flights.tsx, FlightDetail.tsx  /flights list; /flights/:id path, replay, charts
  src/pages/Drones.tsx       /drones: aircraft names and colours
  src/pages/Alerts.tsx       /alerts: raised alerts, acknowledge, show on map
  src/pages/ApiAccess.tsx    /integrations: make and revoke read-only API tokens
  src/pages/Recordings.tsx   /recordings: all videos, grid or list: filter, upload, play, download, delete
  src/fleetData.ts           zustand store for zones and alerts (the fleet store holds aircraft)
  src/branding.ts            loads /api/branding before the first render; derives brand colour tokens
  src/zoneMap.ts             MapLibre layers shared by the operations map, zone editor and replay
  src/components/BaseMap.tsx   the shared MapLibre canvas for the zone editor and flight replay
  src/components/AlertToasts.tsx  banner and beep for a newly raised alert
  src/components/StageBar.tsx  header above every dashboard screen (title, summary, actions)
  src/components/MapView.tsx   MapLibre markers, trail and details card
  src/components/LiveWall.tsx  one tile per visible online aircraft; watches them
  src/components/FocusView.tsx click-to-full-screen player with quality control and capture
  src/components/ScreenshotGallery.tsx  filters and people badges for stored stills
  src/components/ScreenshotViewer.tsx   full-size still, download, People count and verification
  src/components/WhepPlayer.tsx  a <video> on the page's shared WHEP connection for a stream
  src/feeds.ts                 one WHEP connection per stream per page: reconnect, stall recovery
  src/recorder.ts              local recording: folder handle, MediaRecorder, one file per stretch
  src/components/RecordControls.tsx  laptop button on tiles and "On this computer" in focus (local recording), recordings bar on the wall
  src/components/ServerRecordButton.tsx  REC on wall tiles and "Record to server" in focus (the server-side recorder)
  src/serverRecordings.ts      zustand store of what the server records now, one poll for every button
  src/components/UploadVideoDialog.tsx   pick a file, name it, choose or create a folder, progress
  src/socket.ts                fleet WebSocket, watch refcounts, telemetry batching
  src/useWatch.ts              per-component aircraft watches
  src/streamSelect.ts          streamForDevice selector
packages/protocol/     zod schemas and types for every MQTT/WS message; geo.ts (geometry),
                       fleet.ts (zone/alert/pilot/flight types), track.ts (flight summary)
tools/simulator/       Pilot-like publisher; spawns ffmpeg when a stream starts
tools/dev-broker/      Aedes broker
tools/dev/             ordered dev launcher (broker → API → the rest)
tools/media/           MediaMTX config and start script (binary in .data/mediamtx)
tools/docker/          dev/prod preflight checks
tools/e2e/             headless browser checks
infra/                 dev/prod compose, Nginx template, EMQX/SRS configs, prod env example
infra/docker/Dockerfile.dev  shared dev image (source baked, ffmpeg, curl)
docs/                  operator guide, Docker dev guide, hardware, deployment, POC plan
.github/               CI workflow (typecheck/build + Docker image builds)
run.sh                 bootstrap launcher; --docker starts the Docker dev stack
```

## Contracts that must not drift

**Protocol package is the only schema source.** Add or change message shapes in
`packages/protocol`, then import them. Do not hand-roll payload types in the API or web.

**Pilot sign-in and JSBridge sequence** (`apps/web/src/pages/PilotLogin.tsx`). The operator
signs in first, because the DJI config is no longer public; the licence check still precedes
the controller serial, as it does in DJI's archived demo:

1. `POST /api/pilot/auth` with `{ username, password }` → a 5-minute pre-auth token. The
   account must have the `pilot` role; every other role is refused.
2. `GET /api/pilot/config` with that token → `{ appId, appKey, license, … }`
3. `platformVerifyLicense(appId, appKey, license)` then `platformIsVerified()`
4. `platformGetRemoteControllerSN()` — only available after a successful licence check
5. `POST /api/pilot/login` with `{ controllerSn }` → pilot token, or `403 code:2` (pending) /
   `code:3` (rejected). First contact only creates a pending enrolment.
6. `platformLoadComponent('api', { host, token })`, then `apiSetToken(token)`
7. `GET /api/pilot/user-info` (Bearer token) returns per-controller MQTT credentials; it
   re-checks approval and never resets `revoked`
8. `platformLoadComponent('thing', { host, username, password, connectCallback })`
   — there is no client ID parameter
9. on connect: `platformSetWorkspaceId(id)`, `platformSetInformation(platform, workspace, desc)`
10. `platformLoadComponent('liveshare', { videoPublishType: 'video-on-demand', statusCallback })`

`POST /api/pilot/bind` still answers `204` so a cached bundle cannot fail, but the client no
longer calls it: binding is a consequence of approval.

**Controller enrolment is the identity boundary.** `/api/pilot/auth` requires the `pilot`
role; `/api/pilot/login` creates a `pending` row and issues nothing until an admin approves
(`apps/api/src/routes/admin.ts`, or `controller:approve`). `/api/pilot/user-info` re-checks
approval, and `MqttAuthorizer` requires an approved enrolment at CONNECT and on every publish
or subscribe. Aircraft ownership is sticky: `store.claimDevice` only claims an unbound
aircraft, one already owned by that controller, or a serial listed at approval; everything
else is rejected and audited in `device_events`. Never make `devices.gateway_sn` unconditional
again — that was C-02.

`platformSetPlatformName` does not exist; `platformSetInformation` is the call.

**MQTT topics** (`packages/protocol/src/topics.ts`): `sys/product/{sn}/status` carries
`update_topo`; an empty `sub_devices` array means offline. Telemetry is
`thing/product/{sn}/osd` and `/state`; commands go to `thing/product/{gw}/services` and
replies come back on `/services_reply`, correlated by `tid` (10 s timeout).

**Per-controller authorization** (`apps/api/src/mqtt-auth.ts`): a gateway may publish its
own `sys/.../status`, its own `thing/product/{gw}/…`, and its aircraft's telemetry; it may
subscribe only to its own `services`, `requests_reply`, `events_reply`, `state_reply`,
`property/set`, `drc/down` and `sys/…/network/probe`.
Wildcards and other serials are denied. EMQX calls `/internal/mqtt/auth` and
`/internal/mqtt/acl`; never route `/internal/*` through Nginx.

**Sessions are server-side.** A JWT is only half a credential: it carries a `jti`, and
`resolveUser` rejects it unless `sessions` has a live row for that `jti` (not revoked, not
expired). `issueSession()` in `auth.ts` is the only signing path — `signToken` was removed
on purpose, because a token signed without a row could never be revoked. So: never sign a
JWT by hand; to end sessions use `revokeUserSessions(userId, exceptJti?)` or
`revokeSession(jti)`. If a route changes a password, a role, a scope or `disabled`, it must
also revoke, close the account's sockets (`hub.closeUser`) and its WHEP sessions. A
self-service password change revokes everything _including the current token_, then reissues
it, so that device stays signed in and every other device does not — re-read the user row
before reissuing, or the new token carries the pre-change `session_version`. The WebSocket
keepalive re-checks the session every 2 s, which is the only path that catches a revocation
made by the CLI in another process. 4001 means "session gone, do not reconnect" and 4003
means "access changed"; the client treats them differently.

**Two-step sign-in** (`mfa.ts`, `routes/mfa.ts`, `components/TwoStep.tsx`, `pages/Login.tsx`; columns `users.totp_*` and the
`user_recovery_codes` table). RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s: what Google Authenticator and every other app
accept), no third party, works offline; the code is checked against the steps either side of now and **never at or before
`totp_last_step`**, spent in one atomic `UPDATE` (`store.spendTotpStep`), so a code works once. The shared secret is stored
**sealed** (AES-256-GCM, key from `TOTP_ENCRYPTION_KEY` or derived from `JWT_SECRET`; `openSecret` returns null for anything
altered or sealed under another key), never as text, and never leaves the API except once, in the set-up answer. **Login is two
steps**: `POST /api/auth/login` with a right password and `totp_enabled_at` set issues **no session**, only `{ mfaRequired,
mfaToken }` (`issueMfaChallenge`: a 5-minute JWT with `purpose: 'mfa'` and the account's `session_version`, which
`verifyToken` refuses everywhere because it has no `sessions` row and no role); `POST /api/auth/mfa` (public route, rate-limited)
takes the token and a code or a recovery code, and only then calls `issueSession`. A password change or an edit between the
steps bumps `session_version` and voids the token. Five wrong codes in a row lock the account's second step for five minutes
(`recordTotpFailure`; a locked account refuses even a right code); the lock is on the account, so a new sign-in is no way round it.
10 recovery codes (`XXXXX-XXXXX`, no look-alike characters) are stored as SHA-256 hashes and spent once. **Set up, turn off and
new recovery codes ask for the password again** (`/api/auth/mfa/setup|enable|disable|recovery-codes`, `GET /api/auth/mfa`), so
an open session on a shared computer cannot take the account over; turning it off signs out the other devices. **Policy is
`MFA_REQUIRED_ROLES`** (developer, admin, subadmin; empty = optional; `pilot` in the list stops start-up): `publicUser()` adds
`mfaEnabled`, `mfaRequired` and `mfaEnrolRequired`, and an account with the last one is held like a forced password change
(`access.ts` answers `403 mfa_enrolment_required` for every route except `GET /api/me`, the password/email routes and the
`/api/auth/mfa*` set-up routes; the WebSocket refuses it three times over, as for `mustChangePassword`; the web shows only
`TwoStep forced`) and cannot turn it off. **A Pilot is exempt always** (the handlers answer 403): it signs in on a controller where
no code can be typed; its safeguard is controller approval. A lost phone: `POST /api/users/:id/mfa/reset` (`users.manage`, the same
limits as editing the account, never yourself or a Developer; ends the account's sessions) or the CLI `mfa-reset --email`. The
audit trail: `auth.password_accepted` (password right, code awaited), `auth.login` (success with `details.mfa` = `totp` or `recovery`;
a wrong code is a **failure**, via `signin: true` in `ROUTES`, with `wrong code`, `wrong code, locked` or `locked`),
`auth.mfa_setup_started|enabled|disabled|recovery_codes`, `user.mfa_reset`, `cli.mfa_reset`; the second step has no signed-in user,
so the route names the actor with `noteAudit({ actor })`, and `summarize()` also redacts `totp|otp|recovery|code` keys (the mfa
routes are `noBody` anyway). Tests: `test/mfa.test.ts` (RFC 6238 vectors, the flows, lock-out, forced enrolment, reset limits,
no secret in any answer or audit line).

**Sign-in protection** (`http/lockout.ts`, `routes/auth.ts`, `routes/pilot.ts`, columns `users.login_failures` and
`users.login_locked_until`). Two layers, because one cannot do both jobs. (1) Per visitor: the Fastify rate limits key on
`req.ip`, which is only the real visitor because `trustProxy` (`TRUST_PROXY`, default `loopback,uniquelocal`) trusts
Nginx on the compose network and Nginx **overwrites** `X-Forwarded-For` with `$remote_addr` (it used to append, so every
visitor looked like Nginx and one attacker could lock everybody out of the limit; a forged header from a public address
is ignored). Nginx also has its own `limit_req` zone `signin` (20/min, burst 20) on `/api/auth/login`, `/api/auth/mfa` and
`/api/pilot/auth`. (2) Per account: `LOGIN_MAX_FAILURES` (10) wrong passwords in a row lock that account's password step for
`LOGIN_LOCK_MINUTES` (15), whatever address they come from, and a right password during the lock is refused too (429 with
the minutes left). A right password resets the count; an admin's new password (`updateUser`) or a password change lifts the
lock. The audit line says `locked` in its details. The logger's request serializer reads `req.ip` inside a try: with
`trustProxy` on, an `injectWS` fake request has no socket and `req.ip` throws. Tests: `test/login-security.test.ts`.

**Unavailable aircraft are refused at the broker, not just by the API.** `deleted_at` and
`disabled_at` both mean "out of service": `store.deviceUnavailable()` is the single predicate
every ingest path asks (`registry`, `streams`, `whep`, `ws`, `access`), and `mqtt-auth.ts`
denies the aircraft's topics so its controller cannot publish for it at all. The gateway's
_own_ topics stay open on purpose — announcing topology is how an aircraft returns after a
re-enable. Keep the two markers separate: disable is an admin pause they can undo, delete is
only undoable from the original controller, and collapsing them would erase that difference.
`POST /api/devices/:sn/disable` is idempotent, so only an unknown or deleted serial is a 404.

**Stream state** is server-owned: at most one active row per `(device_sn, video_id)`,

enforced by a partial unique index. Phases move `starting → live → stopped|error`. A reply
timeout does not fail a stream; the 60 s start deadline (`STREAM_START_DEADLINE_SECONDS`)
does. `on_publish` accepts `starting`, or `error` when no other active row exists, and
rejects `stopped`; a `live` row is idempotent. `on_unpublish` on a live row with viewers
goes back to `starting` with `error = 'reconnecting'`. Every write bumps `rev`; clients drop
updates with a lower rev. Broadcasts go to `channels.devices`, `channels.stream(id)` and
`channels.device(sn)` — the dashboard only subscribes to `devices`, so keep `devices` in
every stream broadcast.

**Stream lifetime** is tied to WebSocket connections, not to the tab that started a stream.
`StreamManager` keeps viewer sets in memory (`Map<sn, Set<connectionId>>`): the first viewer
starts the stream, the last one starts a linger (`STREAM_LINGER_SECONDS`, default 60). The
wall watches only its visible tiles. In the browser, `feeds.ts` holds **one WHEP connection per
stream per page**, refcounted: every `WhepPlayer` and every recording shares it, and a release
waits 1.5 s, so tile → focus (which still suspends the tile's player) hands the connection over
instead of renegotiating. Never open a second `RTCPeerConnection` for a stream elsewhere: it
would double the server's egress for that viewer. A feed counts as playing once `getStats`
reports a decoded frame, not when a `<video>` paints, because a recorder has no element on
screen. Viewers cannot stop streams or change
quality; admins can stop (holding the aircraft until resume or until every viewer leaves),
resume and change quality. Stream keys never leave the server: browsers play through
`POST /api/streams/:id/whep`, which proxies to `MEDIA_WHEP_INTERNAL_TEMPLATE`.

**Video-only drones** (`routes/video-sources.ts`, `store.ts`, `manager.ts`). A drone with no controller,
such as a DJI Mini 5 Pro pushing RTMP from DJI Fly (its Livestream box has separate RTMP Address and
Stream Key fields; the Stream Key may be left empty with the whole address in the first). It is a
`devices` row whose `rtmp_key` is set (`DeviceSummary.videoOnly`), serial `RTMP-XXXXXXXX`, model
`Video only`, `gateway_sn` null, one synthetic camera so the wall treats it as having video. The
key is the pilot's fixed address `rtmp://host/live/<key>` and the SRS/MediaMTX stream name. There is
no `live_start_push`: `canPublish`/`onPublish` look the key up first and accept it whenever the drone
is in service, and the drone's **one** `streams` row (`video_id` = `<sn>/rtmp/main`, `stream_key` =
the key) cycles live ↔ stopped (`goLiveSource`, `sourceOff`), so `stream_key` stays unique and a
player that follows the stream id carries on after a re-push. `online` follows the push, so
`markStaleOffline` skips these rows, the linger timer and the orphan sweep skip them (the pilot owns
the push, not the viewers), and `claimDevice` refuses their serial. Stop, resume, quality and lens
answer 409; the UI hides them. Disable, re-key and remove call `kickPublisher` (SRS HTTP API;
nothing on the dev MediaMTX). Removing one needs `drones.bind` or `drones.delete` on it (`DELETE /api/video-sources/:sn` is
`drones.view` in `http/access.ts` and the handler checks the other two), so whoever may see its address may
take it away. Creating one needs `drones.bind`, on any scope: an account limited to
selected drones is given the new drone with the rights it holds, and so is its Admin (`giveDrone`,
`giveDroneToAdmin` in `store.ts`), so whoever makes one sees it and no other customer does. A Pilot
never sees the routes. No position, telemetry, flights, zones or alerts, by design. A Developer sees
every one, like all drones.

**Single process**: `StreamManager` state (viewers, lingers, holds, WHEP sessions) is in
memory, so run the API as one process. Horizontal scaling needs Redis plus sticky WebSocket
routing.

**Screenshots** are stills taken from the playing `<video>` in `FocusView` (canvas, JPEG)
and uploaded raw to `POST /api/devices/:sn/screenshots`. The server sniffs JPEG/PNG bytes,
caps size at `SCREENSHOT_MAX_BYTES` (8 MB), names the file
`<BRAND_FILE_PREFIX>_<sn>_<YYYYMMDD>_<HHMMSS>[_n].<ext>` in `APP_TIME_ZONE` (exclusive create, so
same-second captures get `_2`, `_3`), writes it to `SCREENSHOT_DIR` and records it in the
`screenshots` table. Location comes from the newest telemetry fix (≤ 2 min old). All
screenshot routes use `requireOperator` (dashboard accounts; Pilot controller tokens get 403),
and images are only served by `GET /api/screenshots/:id/image` (the full picture, `private, no-store`) and
`GET /api/screenshots/:id/thumbnail`; file paths are never returned. **The gallery shows thumbnails, never the full
picture**: a still is 1-8 MB and 48 of them is a minute on a long, lossy link. `screenshots/thumbs.ts` makes a 640 px
JPEG (about 25-60 kB, `sharp`, two at a time, written whole then renamed) the first time it is asked for or right
after a capture (background), keeps it in `SCREENSHOT_DIR/.thumbs/<id>.jpg` (named by the still's id, so it can
never leave the folder; regenerable, deleted with the still), and serves it `private, max-age=3600` under the same
rights as the picture (`screenshots.view` on its drone and the `shots.view` screen). A file `sharp` cannot read has no
thumbnail (404) and the gallery falls back to the picture once (`onError`). The viewer (`ScreenshotViewer`) shows the
thumbnail at once, already in the browser from the gallery, and puts the full picture over it when it has loaded
(the people-count frame uses the still's own width and height, so nothing jumps). The gallery also loads the next page
by itself as the end of the list nears (an `IntersectionObserver` on the scroller; the Load more button stays as a
fallback). Docker mounts the `screenshots` volume at `/data/screenshots`; back it up with
Postgres. The server stores video only when an operator asks for a server recording (below).

**Recording is local to the operator's computer** (`recorder.ts`, `RecordControls.tsx`). On a wall tile REC is the
*server* recording (`TileServerRecordButton`, `data-testid="tile-server-record"`) and the laptop icon beside it is this
local one (`data-testid="tile-record"`, kept for the e2e scripts); in the focus view the order is Record to server,
then On this computer. A tile's server REC shows only with `recordings.record` on the drone, the local one with
`screenshots.capture`.
`MediaRecorder` re-encodes the picture the browser already receives (video only, H.264 MP4 when
supported, else WebM, 5 Mbps) and writes 1 s chunks straight into a folder chosen with
`showDirectoryPicker`; the handle is kept in IndexedDB (`drone-fleet`/`handles`), so a later
visit only re-asks for permission. Safari and Firefox have no folder access: they buffer and
download each file instead. Nothing is uploaded and no route exists for it. A recording is a
viewer: it `watch()`es the aircraft and holds its own share of the feed, so it survives
tile → focus, layout changes and other screens, and follows the aircraft's live stream id.
A file is named `<prefix>_<name>_<YYYY-MM-DD>_<HH-MM-SS>.<ext>` in the computer's time (`_2` on a
clash). In Chrome and Edge a recording is **one file until the operator stops it**: the recorder
reads a steady track made with `MediaStreamTrackProcessor`/`MediaStreamTrackGenerator`
(`createStableVideo`), which is fed the frames of whichever WebRTC connection plays now, so a
reconnect, a stopped-and-resumed stream or a new stream id only leaves a gap in the same file
(frames re-stamped on one clock; the picture size is that of the first frame). A gap longer than
5 minutes (`GAP_MS`) closes the file, and the next picture starts a new one. A file written into a
folder is never split by time. Where those APIs are missing (Safari, Firefox) or no folder can be
written, each stretch of live video is its own file, closed by a reconnect or a new stream, and a
buffered file is split every 30 minutes (`SEGMENT_MS`) to bound memory. Chrome writes into a
`.crswap` file until `close()`, so a closed tab loses the open file; `beforeunload` warns while anything records, and the dashboard stops (and
saves) every recording when it unmounts. The UI shows it only with `screenshots.capture`
(labelled "Capture screenshots and record video"); that gate is UI-only, since the picture is
already on the viewer's screen.

**Server recordings** (`recordings/recorder.ts`, `routes/recordings.ts`, `pages/Recordings.tsx`). The
customer may want video kept centrally, so an operator can also record a drone _on the server_:
"Record to server" in the full-screen view (`POST /api/devices/:sn/recording`, `DELETE` stops it).
`ffmpeg` reads the live stream from the media server (`MEDIA_RTMP_INTERNAL_TEMPLATE`, on the host or
compose network, never the internet) and **copies** it (`-c copy`, no re-encode, next to no CPU) with the
segment muxer. **A clip has no time limit by default** (`RECORDING_SEGMENT_SECONDS` = 0, it used to be 600): one file runs until the feed ends (the drone is off, or its stream stops), and the muxer is
given `NO_CUT_SECONDS` (ten years) because with no `-segment_time` it would cut every 2 s. A number of seconds
(10 to 86400) cuts clips again with no gap between them. Consequences of one long clip: it is **listed, playable and
deletable by the clean-up only once finished** (the row is written when the segment closes, so a flight's video
shows after landing, and the live feed is the way to watch meanwhile); the +faststart copy below needs free disk
equal to the clip (if it fails the fragmented original is kept and still plays, with no exact seek bar); the
janitor's free-disk floor still protects the disk because it reads real free space and can pause recording, which
closes the open clip; `RECORDING_MAX_GB` does not count a clip until it is archived; `indexOrphans()` skips a file
modified in the last 90 s, so a growing clip is never archived early. A clip is written fragmented (it survives a crash), and once finished is remuxed with
`+faststart` (seekable, duration known, still a copy) and measured with `ffprobe`. A clip is one
row in `recordings` and one file `RECORDING_DIR/<serial>/<serial>_<YYYYMMDD>_<HHMMSS>.mp4`, the time
in UTC and the moment the clip opened; a recording is the clips that share `session_id`. A
recording counts as a **viewer** (`manager.watch('recorder:<sn>')`), so it starts the stream and
keeps it up with nobody at a screen, and it outlives the feed: a reconnect or a new stream id is
picked up, and it ends when someone stops it or the feed is gone `RECORDING_GAP_SECONDS` (300).
`RECORDING_MAX_ACTIVE` (100) caps them. At start-up `indexOrphans()` archives clips a killed API
left behind (valid up to the last fragment) and deletes half-finished `.part.mp4` copies.
Permissions are `recordings.view` / `recordings.record` / `recordings.delete`, per drone like
screenshots (an Admin gets all three once from `schema.sql`, mark `recordings_permissions`; a
Sub-admin default is `recordings.view`; an Admin on "Selected drones" is given them per drone by
the Developer). The screen has no grant of its own: `/recordings` needs `recordings.view`. Clips
play from `GET /api/recordings/:id/video`, which honours HTTP `Range` (a browser seeks by asking for
the middle) and the session cookie, so a plain `<video src>` works; `?download=1` names the file
`<BRAND_FILE_PREFIX>_<serial>_<date>_<time>.mp4`. A row whose `file` would leave `RECORDING_DIR` is
never served. The production API image needs `ffmpeg` (the Dockerfile installs it).

**Automatic (continuous) recording and the clean-up** (`recorder.ts` `reconcile()`/`startAuto()`, `janitor.ts`).
A drone can be recorded without anyone pressing anything, for weeks: `devices.auto_record` is a
tri-state (`null` follows `RECORDING_AUTO_DEFAULT`, default off; `true`/`false` is the Recordings
screen's per-drone switch, `PUT /api/devices/:sn/recording/auto`, `GET /api/recordings/auto` lists
them, an account needs `recordings.record` on the drone). `reconcile()` runs at boot, every 30 s and
after each toggle: it starts a `mode = 'continuous'` recording for every in-service drone that is on
and not recording, and nothing else is needed, because a recording is a viewer, so it starts the
stream by itself (`manager.kick(sn)` is the nudge that retries a drone whose stream never started;
it does nothing under an admin "Stop for everyone" hold, which keeps the drone _waiting_ until Resume).
A continuous recording **never ends by a feed gap**: each ffmpeg run (each connection) gets a new
`session_id`, and failures back off `BACKOFF_MS` (30 s), so a drone that is switched off and on a week later simply
starts a new recording. Clips are `<drone name slug>_<serial>_auto_<YYYYMMDD>_<HHMMSS>Z.mp4` in UTC under
`RECORDING_DIR/<serial>/`; the download name uses the drone's name and the local `APP_TIME_ZONE` time.
`indexOrphans()` also runs every 10 min, and at boot, so clips a killed API left behind are archived.
What keeps it from breaking the server is `Janitor` (every `RECORDING_CLEANUP_SECONDS`, 60), which deletes
**only automatic clips** (`source = 'drone' AND mode = 'continuous'`; a manual recording or an upload is
never touched): (1) older than `RECORDING_RETENTION_DAYS` (30; 0 = until room is needed), (2) the oldest first
while over `RECORDING_MAX_GB` (0 = no cap) down to 97 %, (3) the oldest first, one clip at a time, while the
disk has less than `RECORDING_MIN_FREE_GB` (20) free, down to 125 % of it, (4) if it is still low or over the
cap with nothing automatic left to delete, `recorder.setPaused(reason)`: ffmpeg is stopped and nothing new
starts, and it **resumes by itself** when there is room. The row goes before the file: a clip nobody can
list is better than a listed one whose file is gone. It logs `[cleanup]` and a `recording.cleaned`
device event, and `GET /api/recordings/storage` (used, free, last 24 h, days of room left, last clean-up, paused) reads
`Janitor.status()`. The screen shows none of those figures on purpose (the operator asked for less): the Automatic recording
box (`RecordingStoragePanel`) keeps only the per-drone switches, the Developer's folder row and the red "paused" banner. `diskSpace()` creates `RECORDING_DIR`
first, so the guard is never blind on a fresh install. The same hourly pass prunes `mqtt_log` only if
`MQTT_LOG_RETENTION_DAYS` > 0 and `telemetry_samples` only if `TELEMETRY_RETENTION_DAYS` > 0; both are 0 (kept) by
default, because real aircraft captures are studied from the raw log (a first version defaulted the log to 7 days and
emptied a live system's log on its first run).
Telemetry growth was the other thing that would have broken a month-long run (every OSD message was stored,
about 3 KB each: ~1.5 GB a day for 12 drones that are always connected): `shouldStoreSample` in `registry.ts`
now stores a drone that is on the ground and idle at most every `TELEMETRY_IDLE_INTERVAL_SECONDS` (30 s) and a
drone in the air in full, so flights and zone alerts see the same data. `registry.handleState` retries a
`live_capacity` that arrives before the drone's topology is stored (3 times, 2 s, 4 s, 6 s), or a fresh install would
leave the second drone without a camera, and so with nothing to record, until it next changed.
Sizing: 12 drones at 4 Mbps is about 0.5 TB a day (a week ~3.6 TB, 30 days ~15.5 TB), so `RECORDING_RETENTION_DAYS`
and the disk have to be chosen together; the server's disk is the limit, the software is not. An idle drone on
the ground is recorded too (an "only while flying" mode is not built).

**Uploaded videos** (`recordings/library.ts`, `PUT /api/recordings/upload`, the Upload dialog). The
same `recordings` table and screen also hold videos people upload (`source = 'upload'`), the
"upload externally recorded video" requirement. The body is the file itself (`application/octet-stream`
or `video/*`, no multipart library), streamed to `RECORDING_DIR/_incoming/<id>.part` through a size
counter (`RECORDING_UPLOAD_MAX_BYTES`, 4 GB; the declared length is checked first, and free disk
must be twice the file); name, folder and optional drone ride in the query. `ffprobe` must find a
video stream that is not a still image (else 415, file deleted). The row is created as `processing`
and a one-at-a-time queue makes it playable: H.264 in 4:2:0 in any container is **copied** into an MP4
(`+faststart`, audio copied if AAC else re-encoded to AAC); VP8/VP9/AV1 with Opus/Vorbis is copied into
WebM; everything else (H.265, MPEG-4, ProRes, 10-bit...) is **converted** to H.264 at `nice` 10, the
slow case on the 2 vCPU VPS. Then a thumbnail (`<file>.jpg` beside the video, `GET /:id/thumbnail`,
also made on demand for drone clips) and the row becomes `ready` (or `failed` with a message).
The **folder** is a name as typed (Bengali kept, up to 80 letters, `folder` column) and a real
directory `library/<diskName>/` made on first use; `diskName()` keeps only `A-Za-z0-9._-`, so
`../` can never leave the library, and a name with no such letters becomes `folder-<hash>`. A repeat
title in a folder is numbered ("Name (2)"). An upload belongs to one customer (`tenant_id` = the
uploader's Admin; a Developer's is null and visible to Developers only): another customer's upload
answers 404 (the access middleware checks it), a Developer sees all, and an upload tied to a drone
(`sn`) also needs that drone's grant. `recordings.upload` is an **account** grant (in
`ACCOUNT_PERMISSIONS`); an Admin gets it once from `schema.sql` (mark `recordings_upload_permission`).
`library.resume()` at start-up deletes half-arrived `.part` files and finishes or fails uploads that
were mid-way. Nginx has a `location = /api/recordings/upload` with `client_max_body_size 8g` and
`proxy_request_buffering off`; the standalone `frontdoor.conf` still has 12m and would refuse big files.

**The videos folder** (`recordings/place.ts`, `RecordingPlace`; the `app_settings` table; `StorageFolderDialog.tsx`). One
main folder on the server's disk holds everything: `<serial>/` for drone clips, `library/<folder>/` for
uploads, `_incoming/` while an upload arrives. It starts as `RECORDING_DIR`, and a **Developer** can change it
(`PUT /api/recordings/location`; `GET .../location`, `GET .../location/browse?path=` and `POST
.../location/folder` feed the picker in the Automatic recording box; all four are in `developerOnly` in `http/access.ts`,
so no customer account can point the server at a path). It is saved as `recordings.location` in `app_settings`
(`{ dir, older }`) and read at start-up by `place.load()`; if that folder cannot be used then (a disk not
plugged in) the server keeps running on `RECORDING_DIR` and says so in `place.warning`, shown to the
Developer. `inspect()` refuses a relative path, a disk root, a system folder (`/etc`, `/usr`, `C:\Windows`...), a
file, and a folder the server cannot write into (it writes and deletes a probe file). **Nothing is copied
when the folder changes**: the database holds each video's `file` relative to the main folder, and
`place.resolve()` (also `library.resolve`) looks in the current folder and then in `older` (the last 5), so
old videos keep playing and can be deleted, and `indexOrphans()` scans the older folders too. The recorder,
library and janitor read `dir` through a getter on every use, so a change needs no restart; `recorder.relocate()`
sends SIGINT to each running ffmpeg, which closes (and archives) its clip where it was written, and the run loop
reopens in the new folder after `RETRY_MS`. **Storage areas.** A folder chosen in the app inside a Docker container would live in the
container and be lost when it is recreated, so a Docker install lists the places that outlive it in
`RECORDING_ROOTS` (comma-separated `path=label`, parsed by `parseStorageRoots`): both compose files give the
default volume `/data/recordings` and, in prod, `/storage`, the host folder `STORAGE_HOST_DIR` (default
`/srv/drone-fleet-storage`; a big disk or NAS is mounted there; `tools/docker/preflight.mjs --prod` warns if it is
missing). Where `RECORDING_ROOTS` is set the Developer can choose any folder *inside* one of them (`inspect`,
`browse` and `makeFolder` refuse anything else with code `outside`, judged on the resolved path so `..` and a
sibling that merely starts with the area's name do not pass), the picker's shortcuts are the areas, and it
cannot go above one; a saved folder that is no longer inside an area is not used at start-up. Empty (a plain
server) means anywhere on the disk. `RECORDING_DIR_LOCKED=1` still forbids changing it at all (409). The picker lists only folders, no dot-folders, 500 at most, with shortcuts to Home and to mounted
disks (`/Volumes`, `/mnt`, `/media`, Windows drive letters). Uploads are always from the browser's file picker; the
server never reads a path the user names except through this Developer-only picker.

**Tags and notes on videos** (`recordings.tags` TEXT[] and `recordings.note`, `PATCH /api/recordings/:id`, `GET /api/recordings/tags`,
`components/RecordingNotes.tsx`, shared rules `cleanTag`/`cleanTags`/`cleanNote` and `recordingAnnotationSchema` in the protocol, tests
`test/recording-tags.test.ts`). A person labels any video (a drone clip or an upload) with up to `RECORDING_TAGS_MAX` (20) tags of at most
`RECORDING_TAG_MAX` (30) characters and a note of at most `RECORDING_NOTE_MAX` (2000); the same word in another case is one tag (first spelling
kept, filter and counts are case-insensitive). **Who may change them is the existing rights, not a new one:** `recordings.record` on the clip's drone,
or for an upload `recordings.upload`, and an upload only inside its own customer (`mayAnnotateClip`, same tenant rule as delete); the route's policy is
`recordings.view` + the `recs.view` screen so anyone who can see a video reads its tags and note. The list `q` also matches the note and any tag
(`unnest(r.tags) ILIKE`), `tag` is an exact case-insensitive filter, and `GET /api/recordings/tags` counts only what the account's scope may see
(`scopeSql`). The audit line `recording.annotated` carries the new tag list and `note: changed|cleared`, never the note's text. API tokens read both
fields and `?q=`/`?tag=` (`/api/recordings/tags` is on `apiTokenRoutes`). The tag box in the web adds a tag on Enter or when a comma arrives in
`onChange` (a typed comma, a pasted list or an IME all work; `keydown` alone missed pasted text), never disables itself while saving (a disabled input
drops keys and loses focus), and queues saves so each starts from the tags the last one left. **Not built:** tagging several videos at once, tags
chosen at upload time, tags protecting an automatic clip from the clean-up (the janitor still deletes an old automatic clip however it is tagged).

**Deleting videos** (`DELETE /api/recordings/:id`, `POST /api/recordings/delete`). The Recordings screen has a **Select**
mode like the Screenshots one: tick videos (a grid card, or a checkbox column in the list), **Select all N shown**, **Delete
selected**; the browser sends them 200 at a time. Both routes share `removeClips()` (row first, then the file and its
thumbnail, then a `recording.deleted` device event). The bulk route needs `recordings.delete` and then checks every video
itself with `mayDeleteClip()` (the grant on its drone, and an upload only for its own customer, the rule the access
middleware applies to one id); what an account may not delete, or what is not there, is **skipped and counted**
(`{ deleted, skipped }`), never named. A video still `processing` cannot be ticked. The audit line is one
`recording.deleted` whose target is "N videos" and whose details list the names and files (`noteAudit()` in
`http/audit.ts` is how a handler adds to its own line). Automatic clean-up still runs unseen; only the figures are gone.

**Not built yet (next slices):** event-triggered recording (on an alert or when a drone takes off) and an
"only while flying" mode, per-customer retention (the retention and caps are server-wide), renaming or moving
an uploaded video, uploading several files at once, exporting a chosen time segment, and AI on a clip. Disk use
is about 2 GB an hour per drone at 4 Mbps and the nightly backup does **not** include the `recordings` volume.

**People counting** runs on the API, offline, in two stages. `PEOPLE_QUICK_MODEL_PATH`
(YOLOX-S, ~36 MB) answers in ~1-2 s, then `PEOPLE_MODEL_PATH` (YOLOX-L, ~217 MB) refines it in
the background; both are Apache-2.0 COCO models run through `onnxruntime-node`, installed and
sha256-checked by `pnpm models:fetch`. A capture starts the count by itself (`PEOPLE_AUTO_COUNT`),
so the result is usually ready when an operator opens it. `detector.ts` runs the whole frame,
native 640 px tiles and upscaled tiles (320 px thorough, `PEOPLE_QUICK_TILE` 448 quick); each pass
keeps only the person heights it sees reliably, tile boxes cut by an inner tile edge are dropped,
the rest merge by IoU/IoS. All model runs share one `PassLock` that serves quick passes first.
Detections at or above the count score (30 % thorough, `PEOPLE_QUICK_COUNT_SCORE_PERCENT` 50 quick,
because the small model scores far-away people low) are counted; from `PEOPLE_MIN_SCORE_PERCENT`
(20) up they are "possible" and not counted until an operator accepts them.
`screenshot_people.stage` says which stage a stored result is from. The AI number is never
presented as exact: `verified_count` is the operator-checked result, saved from
`PUT /api/screenshots/:id/people/verification` (needs `screenshots.capture`; reading and
`POST …/people` need `screenshots.view`). A background refinement never overwrites a verified
count; only an operator's "Count again" (`POST`) does, and it clears the verification. The viewer
polls while `counting` is true, swaps in the thorough result unless the operator has unsaved
changes (then it offers it). **Deleting** is its own right, `screenshots.delete` (an Admin has it: `schema.sql`
adds it to old rows, `defaultPermissions` to new ones): `DELETE /api/screenshots/:id` and
`POST /api/screenshots/delete` (up to 200 ids) remove the row, its people count (cascade) and the file,
log `screenshot.deleted` with who and which file, and need `screenshots.view` on the still as well; the
bulk route skips what the account may not delete and counts it, and a count still running for a
deleted still is dropped quietly. Every new route needs a line in `http/access.ts`, which fails closed.
The runtime is imported lazily, so a platform without an ONNX Runtime build (Alpine/musl) keeps
the API up and reports counting unavailable; the API image is therefore Debian-based.
Measured on a 2 vCPU server (no GPU, 2 threads): quick 1.1 s for a 1280x720 photo and
2.1 s for 1920x1080; thorough 8-10 s and 18 s. Synthetic composites, people ~80 px tall: quick
103/100, thorough 100/100; ~45 px: quick 236/240, thorough 259/240 (the extras are marks the
operator removes); ~30 px: quick counts only 23 of 320 but marks 381 as possible, thorough counts
282 and marks 48 more. Not drone footage: real aerial accuracy still has to be measured on
operator-verified captures.

**Zones, geofences and alerts** (`geo/engine.ts`, `store-fleet.ts`, `routes/zones.ts`). A zone
is a circle or a polygon (`ZoneShape`, `packages/protocol/src/geo.ts`) of kind `no_fly` (red; a
warning distance `bufferM` outside the edge, saved per zone) or `geofence` (blue; alerts when
an aircraft that is flying leaves it; `deviceSns` empty means every aircraft). Distances are
metres on one sphere (haversine and a local flat projection with the same 111 195 m/degree);
the signed distance to the boundary is negative inside. The dashed warning band on the map is a
mitred offset ring and is only drawn; alerts always use the exact distance. State per
(aircraft, zone) is `clear → warning → breach` for no-fly and `inside ↔ outside` for geofences,
with 10 m hysteresis, and **only while the aircraft is airborne** (height ≥ 2 m), so a drone
parked in an airport or outside its fence stays silent until it takes off. An alert row is
cleared when the state ends or the flight ends; acknowledging records the user. Editing a zone
resets its state (`zoneStamp`). Zones are soft-deleted (`deleted_at`) so a deleted built-in zone
is not seeded again. Reading zones needs `zones.view`, alerts need `alerts.view` (plus `drones.view` on the
drone), and changing zones needs `zones.manage`. A non-Developer sees the **built-in zones** and the custom zones
drawn by its own team (`tenantOf()` in `http/tenant.ts`: itself and the accounts with the same `admin_id`); it
changes only its team's, and only a Developer edits or deletes a built-in zone. An alert about a zone an account
cannot see is left out of `GET /api/alerts`, `POST …/ack` and the live `alert` message. An aircraft-scoped geofence
is hidden from accounts that cannot see its aircraft. A **Pilot** account
never keeps `users.manage`, `zones.manage` or `system.debug`: `forRole()` in
`routes/users.ts` strips them on create and edit, and the user form hides them for that role. Alerts reach the dashboard on the `devices` channel as `alert` messages, and
`zones.changed` tells every open page to reload zones. The 42 built-in zones
(`geo/builtin-zones.ts`, generated from OpenStreetMap, ODbL, © OpenStreetMap contributors) are
**advisory and approximate**: several cantonments are generous circles around a single point.
They do not replace CAAB/ISPR approvals or DJI's own GEO zones, and nothing here is sent to the
aircraft.

**API access for the customer's own programs** (`api-tokens.ts`, `store-tokens.ts`, `routes/api-tokens.ts`, `routes/media-export.ts`,
`streams/export.ts`, `openapi.ts`, `pages/ApiAccess.tsx` at `/integrations`, table `api_tokens`, grant `api.manage`, guide `docs/api.md`). A
customer's AI tool reads drones, telemetry, flights, alerts, zones, pictures, recordings and live video with a **read-only token** instead of a
person's sign-in (no password, no two-step code, no 12 h session). `ne_` + 256 random bits, shown once; only its SHA-256 is stored
(`hashApiToken`). **A token is a narrowed copy of the account that made it** (`narrowAccess`): every request re-reads the owner and keeps only the
looking rights (`API_READ_DRONE_PERMISSIONS`, `API_READ_ACCOUNT_PERMISSIONS`) and only the drones the token was limited to, so it can never be
wider than its owner and shrinks the moment the owner loses a drone. `resolveCredential()` (session or token) is the one resolver for HTTP and the
WebSocket; `requestCredential()` lets an `ne_` Bearer win over a cookie. In `http/access.ts` a token may only **GET** and only the routes in
`apiTokenRoutes` (403 `api_token_read_only` / `not_available_to_api_tokens` otherwise): **a new read route a program should get needs a line in
`apiTokenRoutes` and in `openapi.ts`; every other route stays closed to tokens by default**. A Developer cannot own a token (the route refuses
it and `resolveApiToken` returns null for one: a customer's Admin makes it); a disabled or deleted owner, a revoked or expired token fails at
once (`findLive`, one query per request; `last_used_at` is written at most once a minute). Anyone with `api.manage` lists and revokes the tokens
of their own team (`tenantOf`), other customers' answer 404. Audit: `api_token.created`/`.revoked`, `stream.viewed` for a live feed, `stream.frame`
once per token and drone every ten minutes, and `details.apiToken` names the token on any line it made (refusals included).
**Video for a program** (`streams/export.ts`, `MediaExport`): `GET /api/devices/:sn/frame` (one JPEG, `ffmpeg -frames:v 1` from the stream the recorder reads,
shared for 1 s and in flight, about 120 a minute) and `GET /api/devices/:sn/live` (MPEG-TS over HTTP, `-c:v copy`, video only, at most `API_LIVE_MAX` 8
at once, 429 beyond). A request counts as a viewer (`manager.watch`, `kick` every 4 s), waits up to `API_STREAM_WAIT_SECONDS` (20) for the drone to be live,
then answers `503` with `Retry-After`; the stream lingers 60 s afterwards like a person's. The stream key never leaves the server;
`exposeHeadRoute: false` so a HEAD cannot open ffmpeg; the live reply sets `x-accel-buffering: no` for Nginx and `reply.raw.on('close')` kills ffmpeg
and unwatches. Token on the WebSocket works through the same resolver (closes within 2 s of a revoke). The screen is at **`/integrations`, not
`/api-access`**: Vite's dev proxy forwards every path that starts with `/api` to the API. Tests: `test/api-tokens.test.ts` (includes a real ffmpeg reading
the live URL with the `-headers` option). Not built: webhooks, results posted back, RTSP, per-token rate limits, tokens in the URL, a Developer's own
tokens.

**Link-lost and battery alerts** (`alerts/monitor.ts`, `AlertMonitor`, wired in `index.ts` beside `GeoEngine`; rules from
`config.alerts`: `ALERT_LINK_LOST`, `ALERT_BATTERY_LOW_PERCENT` 30, `ALERT_BATTERY_CRITICAL_PERCENT` 15,
`ALERT_REMAIN_CRITICAL_SECONDS` 120; 0 switches a battery rule off, critical must be below low). They use the same `alerts` table, REST
routes, WebSocket `alert` message, toast and Alerts screen as zone alerts, with kinds `link_lost`, `battery_low` and `battery_critical`
(`ALERT_KINDS`, `isZoneAlert()`); `zone_id`, `zone_name` and `distance_m` are now nullable (`schema.sql` drops the NOT NULLs), so
**every reader of an alert must handle `zoneId === null`**: the zone-visibility filters in `routes/zones.ts` and `routes/ws.ts` let a zone-less
alert through because it is already limited to drones the account can see, and the web shows `alertSubject()` (the zone name, or the
server's sentence) instead of a zone. *Contact lost* is raised when an aircraft whose last sample was in the air (height >= `LANDED_ALT_M`,
heard within 5 min) goes away by either path (`status` offline from the controller's topology, reason `disconnected`; or the 45 s
`markStaleOffline` sweep, reason `silent`); the first path to report raises it, the second is ignored. A normal power-off after landing never
raises it because the last sample was low. The caller passes `flights.activeFlightId(sn)` **before** `flights.onOffline`, which closes the
flight. The alert is critical, keeps the last position and **stays open until that aircraft's next sample** (it is not cleared by the flight
ending; an API restart clears every open alert, as for zones). *Battery* is judged only while airborne, escalates only (`batteryLevel()`: low,
then critical, never back within a flight, so a bouncing reading does not flap), low is replaced by critical, and both end with the flight
(`AlertMonitor.onFlightEnd`). Critical also fires on the aircraft's own `remainFlightS` at or below the limit. Per-drone or per-customer
thresholds, notifications outside the dashboard, and a "battery low while parked" alert are not built. The simulator can show them:
`SIM_BATTERY_START=33 SIM_BATTERY_DRAIN=0.5`. Tests: `test/alerts.test.ts`.

**Flights** (`flights/tracker.ts`). A flight starts when an aircraft reports a height above take-off (`altRel`, from `elevation`) ≥ 2 m and
ends after < 1 m for 20 s, or after 60 s of silence or going offline; a flight under 20 s or
without a path is discarded. The summary (duration, distance, max height and speed, lowest
battery, furthest from take-off) is computed once from `telemetry_samples` by `summarizeTrack`
(jumps over 2 km are ignored); a flight in the air gets the same numbers live from the routes.
A flight records the controller and its sign-in account (`controller_sn`, `operator_email`),
not a person. Flights left open by a restart are closed at boot, so a flight
cannot span an API restart. `GET /api/flights/:id` returns the path thinned to 1500 points.
Needs `flights.view`, scoped per aircraft like every other read.

**Audit trail** (`apps/api/src/audit.ts`, `http/audit.ts`, `routes/audit.ts`, `pages/Audit.tsx`, tables `audit_log` and
`audit_head`). Every request that changes something, every refusal and every sign-in is one line: who (`actor_*`,
`tenant_id` = the Admin whose team it belongs to, null = vendor only), what (`action`, a dotted code whose first part is
the category; readable names live in `AUDIT_ACTIONS` in the protocol), to what (`target_*`, the label as it was
*before* the handler ran, so a delete still names what it deleted), how it ended (`outcome` success/failure/denied, HTTP
`status`), from where (`ip`, `user_agent`) and the details (a redacted summary of the body; for an account edit the
rights gained and lost, role, disabled, password reset, computed from the row before and after). It is captured by two
Fastify hooks registered after the access middleware: `preHandler` looks the target up (`AuditLog.labelFor`), `onResponse`
writes the line without delaying the request and never fails it (`record()` swallows and logs; `flush()` waits, for
tests). **Every route that changes something is audited, listed or not**: `ROUTES` in `http/audit.ts` gives names and
targets, an unlisted one is recorded as `request.<method>_<route>` (so a new route cannot slip past), and the
plumbing the browser calls itself is in `NOT_AUDITED`. Views worth keeping are also recorded: `stream.viewed` (WHEP
offer), `recording.played` (once per person, recording and ten minutes) and `.downloaded`, `screenshot.downloaded`,
`pilot.credentials_issued`. A 401 on `/api/auth/login` or `/api/pilot/auth` is `failure` (wrong password), elsewhere
401/403 is `denied`. Bodies pass through `summarize()`, which replaces any key that looks like a secret
(`pass|secret|token|key|credential|authorization|cookie|licence|sdp`) with `[redacted]`. `clientIp()` reads
`X-Forwarded-For` from the right, skipping our own network, because Nginx appends the real peer there after whatever
the client wrote. The server console (`cli.ts`) writes `cli.*` lines as actor "server console". Tamper evidence: each
line stores `prev_hash` and `hash = sha256(prev_hash + canonical(line))`, written in ONE statement that updates the single
`audit_head` row (so two writers, the API and the CLI, cannot take the same place), a trigger refuses UPDATE and DELETE
(except `audit_remove()`, below), and `AuditLog.verify()` walks the chain (content, continuity, gaps, and the tail against
the head); an export carries the head hash so a copy kept elsewhere can be compared. Reading and exporting need `audit.view`
(account-wide; an Admin gets it once from `schema.sql`, mark `audit_permission`; a Developer sees all lines, anyone else
their `tenant_id`'s **minus every line whose actor is a Developer**). **What a Developer does is the vendor's business**:
a Developer's lines are written with no `tenant_id`, and `AuditLog.where()` also leaves `actor_role = 'developer'` out of a
team's view, so lines written before that rule (tagged with the customer) are hidden too, with no rewrite. The server
console's lines (`actor_role = 'console'`) are still the customer's to see.
**Deleting lines is Developer-only** (`POST /api/audit/delete`, `developerOnly` in `http/access.ts`; the Audit screen's
**Select** mode: tick lines, **Select all N shown**, **Select all N that match** for everything a filter matches, up to
100 000 at a time). A deleted line is **blanked, not dropped**: SQL `audit_remove(ids)` clears who/what/where/details and
sets `redacted_at`, but keeps `seq`, `ts`, `prev_hash` and `hash`, so the chain still holds across the gap (a real DELETE
would break every later link); the trigger allows exactly that one change, only inside `audit_remove` (it sets a
transaction-local `audit.removing`). `where()` always adds `redacted_at IS NULL`, so no screen or export shows one. The
route writes an `audit.deleted` line first (count, mode, first/last seq, the filter; vendor-only like any Developer line)
and then blanks; **a line that records a deletion is never blanked**. `verify()` skips the content check of a blanked line,
returns `redacted: N` (every reader is told, customers included, so nobody assumes none were deleted), and fails with "a line
was blanked without a record" when N exceeds what the `audit.deleted` lines declare (someone calling the function by hand). `GET /api/audit`
The Audit screen has **no integrity button or result** (removed on request, 2026-11-19): the check is only `GET /api/audit/verify`, still recorded as `audit.verified`. `GET /api/audit` filters by account (its actions AND what was done to it), category, outcome, time and words; `/api/audit/export` streams
CSV (UTF-8 BOM, formula-injection guard in `csvCell`) or JSON; `/api/audit/verify` is rate-limited. `GET /api/users` adds
`lastLoginAt` from the trail. The server never deletes by itself (no retention job on purpose); the first line, `audit.started`,
says when recording began.

**Roles** (`ROLES` in `packages/protocol/src/access.ts`): **developer** (the vendor; created only
by `npm run admin`, `can()` grants it everything, the only role that creates or edits Admins),
**admin** (one customer's lead; every permission; creates Sub-admins and Pilots), **subadmin**
(exactly the permissions and aircraft an Admin gives, `users.manage` included) and **pilot**
(signs a controller in, nothing on the dashboard of its own). A Pilot's access is fixed:
`PILOT_PERMISSIONS` (`drones.view` + `drones.bind`) on all aircraft, because the controller checks
both per aircraft; `forRole()` overwrites whatever the form sent, `schema.sql` normalises old
Pilot rows, and the user form shows no permission boxes for the role. `mayDelegate()` in
`routes/users.ts` lets anyone but a Developer hand out only a subset of their own access (user
management included), never the Admin role, and hides Developer and Admin rows from them. A Pilot
is the exception to "a subset": its access is fixed, so anyone with `drones.bind` may make one, even
an Admin limited to selected drones; it joins the creator's Admin, and the drones its controller
brings in go to that Admin. Pilots live on the Drones screen, not in the Users list: `AddPilot` (beside "Add
video-only drone") makes one, `PilotList` under the drones table gives it a new password, disables, enables
or deletes it (a Developer also sees which Admin it belongs to), and the Users list and its role filter leave
Pilots out. The Create user form only offers Pilot for an existing account opened by its address. Both need
`users.manage` plus the Pilot's two rights. Only a Developer makes an Admin, because each Admin is its own customer.
Anyone changes their own sign-in email with `POST /api/auth/email` (current password required,
`session_version` left alone because a controller's MQTT credential is tied to it, so nobody is
signed out); the Account screen (`ChangePassword.tsx`) holds the email and password forms.
`DELETE /api/users/:id` removes an account for good under the same limits, never yourself or a
Developer, and an Admin only by a Developer: it revokes sessions, closes sockets and WHEP, deletes
the account's `gateway_credentials` (a credential row with no owner would read as "no account to
check" in `MqttAuthorizer`, so they must go, not be nulled) and sessions, and logs
`user.deleted`; flights keep `operator_email` as plain text. On the Users screen your own row only
offers Change password (the self-service screen), so nobody locks themselves out.

**Every Admin is its own customer.** `users.admin_id` says which Admin an account belongs to (an
Admin belongs to itself, a Developer to none) and `users.created_by` who made it. `inScope()` in
`routes/users.ts` is the one rule: a Developer sees and acts on everything; anyone else only on
themselves and the accounts with their own `admin_id` (an Admin's accounts, or, for a Sub-admin
with `users.manage`, the Admin it works for). Outside that an account does not exist: list omits
it and edit/delete answer 404. A new Sub-admin or Pilot inherits its creator's `admin_id`; a
Developer picks the Admin in the form (`adminId`, or none: then only Developers see it). An Admin
that still owns accounts cannot be deleted or demoted (409). `schema.sql` backfills legacy
accounts once (mark `users_admin_id` in `schema_marks`) onto the single Admin if there is exactly
one, else leaves them for a Developer. **What a customer's Admin sees is the Developer's choice.**
Drones: an Admin made with "Selected drones" (the form's default for a new Admin; "All drones" shows a
warning because it includes everyone's) reads, through the same per-drone grants as a Sub-admin, only those
drones, and so only their screenshots, flights, alerts, streams and telemetry. A drone first seen through a
controller whose Pilot belongs to an Admin is given to that Admin once (`grantNewDroneToOwner` in `store.ts`, on
first claim only, so taking it away sticks); a Developer's own controllers (a Pilot with no Admin) give theirs to
nobody. Controllers and drone inventory (`routes/admin.ts`) are filtered the same way: a controller is the
customer's when its Pilot or the account that approved it is in the team, or it flies a drone they may see, and
anything else answers 404; an approval may only list drones the account may see. Screens: each is a grant, set by
the Developer in the form's Screens section, **one switch for every screen in the menu**: `map.view`, `wall.view`,
`shots.view`, `recs.view` (Recordings), `history.view`, `zones.view`, `alerts.view`, `fleet.view`, `users.manage`,
`inventory.manage` and `audit.view` (all account-wide, `ACCOUNT_PERMISSIONS` in the protocol, never scoped per drone).
`recs.view` (added 2026-11-19) closes the Recordings data like `shots.view` does the stills: `screenPolicies` in
`http/access.ts` lists the recordings routes, except `GET /api/recordings/active`, which the Live wall's REC buttons read.
A screen switch only opens the page; the data still needs the drone right (`recordings.view` and so on). `routeAllowed`/`homeRoute` in `apps/web/src/routes.ts` send an account to the first screen it may
open, or show a "No screens" note. `map.view` hides the screen only; positions are withheld with `telemetry.view`.
A Pilot account has no dashboard: `GET /api/devices` and the WebSocket give it nothing. `schema.sql` adds the
four new grants to old accounts once (mark `screen_permissions`) and `recs.view` to whoever could already watch or upload
recordings (mark `recs_permission`, placed after the recordings grants), so a screen switched off later stays off.
Still shared by every Admin: built-in zones, the branding, and the aircraft of a customer whose Admin was left
on "All drones".
The CLI's `user:create` takes `--admin <email>` for the same placement. Old rows are renamed at start-up
(`superadmin` → `developer`, `user`/`viewer` → `subadmin`) by `schema.sql`. Pilot profiles (a
person with a photo and designation) were removed on purpose: the dashboard shows aircraft, not
people. `schema.sql` drops `crew_members` and the `crew_id` columns, and `knownPermissions()`
filters a retired grant such as `crew.manage` out of any stored account.

**Aircraft profile.** Name, label and colour are set with `PATCH /api/devices/:sn` (`displayName`,
`label`, `color`) on the Drones screen; the map always shows each aircraft's name on a pill of its colour.
Colours come from `DRONE_COLORS` (no reds: red means a no-fly zone) or any `#rrggbb`, and
`assignMissingColors` gives new aircraft a free palette colour. The colour is data, so it is
the one place a hex value reaches the DOM (as `--drone-color`/inline style).

**Display names** live in `devices.display_name`. `PATCH /api/devices/:sn` is admin-only;
topology upserts never overwrite the name. Search is client-side (`deviceSearch.ts`) and
filters both the fleet list and the live wall by name, label, serial or model. Always render
`displayName ?? model` as the name, then the optional **label** (`devices.label`, a nickname up to
`DEVICE_LABEL_MAX` = 30 characters, same `drones.rename` permission) after `·`: `deviceLabel()`
does this in the web and `DEVICE_NAME_SQL` in `store-fleet.ts` does it for flights, alerts and
screenshots, so the two must stay in step. Sort lists by `deviceName()` (no label), or adding a
nickname makes the row jump under the cursor.

## Conventions and gotchas

- Styling is Tailwind v4 CSS-first (`@tailwindcss/vite`). `src/styles.css` declares the layer
  order and imports theme, utilities, tokens, base, decorative and map CSS; utilities win over
  legacy-era component CSS. Cascade layers never reach the browser: `postcss-preset-env`
  (configured in `apps/web/vite.config.ts` for Chrome >= 95) flattens them into
  specificity-scoped selectors, because the RC Plus 2 WebView predates `@layer`.
- `src/styles/tokens.css` is the only token source: colours, radii, spacing, type, breakpoints,
  shadows and animations. Use token utilities (`bg-paper`, `text-ink-2`, `rounded-md`,
  `w-rail`, `shadow-[var(--shadow-card)]`); never put raw hex/rgb colours in TSX. Preflight is
  intentionally not imported.
- Keep complex effects in `decorative.css` (multi-stop gradients, masks, photo blends,
  fullscreen pseudo-elements) and MapLibre/marker rules in unlayered `map.css`. Do not layer
  MapLibre overrides: unlayered source stays unlayered after conversion, so it keeps beating
  utilities regardless of specificity.
- **White-label.** One build serves every customer. The API reads `BRAND_NAME`,
  `BRAND_SUBTITLE`, `BRAND_COMPANY`, `BRAND_TAGLINE`, `BRAND_PRIMARY_COLOR`, `BRAND_ACCENT_COLOR`,
  `BRAND_FILE_PREFIX` and `BRAND_LOGO_PATH` (`config.brand`) and serves them unauthenticated from
  `GET /api/branding` (logo: `GET /api/branding/logo`, SVG sandboxed by CSP). `main.tsx` awaits
  `loadBranding()` before the first render, so no other brand flashes; components read the
  `brand` object, never a literal name, and `pageTitle()` builds every tab title. A non-default
  primary or accent re-derives the `--pine*`/`--gold*` families and the login panel, glow, ring
  and shadow tokens on `:root` (sRGB mixing in `branding.ts`, no `color-mix`, which Chrome 95
  lacks); the default brand leaves the hand-tuned tokens untouched. `docs/on-premise.md` is the
  per-customer install guide. The default brand is **Drone Fleet** (company: Your Company):
  `--pine*` is its blue and `--gold*` / `--on-gold` its gold. The accent is never a status colour;
  `--live`, `--warn` and `--ok` keep their meanings. The built-in logo is the simple
  round drone emblem `src/assets/brand-mark.png`. `BrandLockup` pairs the logo with the name;
  the sign-in screen puts that lockup top-left, above the tagline (no further taglines).
- **Delivery speed.** The production link is long (about 150 ms round trip on a long intercontinental link), so bytes and connections are
  what a user feels, not the API (2-40 ms). Nginx (`infra/nginx/app.conf.template`) serves HTTP/2, sends the copies the web
  Dockerfile gzips at build (`gzip_static`; the nginx image has no brotli), compresses other text on the fly, and gives every
  hashed file under `/assets/` `Cache-Control: public, immutable` (the regex needs the 8-character hash, so the unhashed MapLibre
  worker `.mjs` stays revalidated; a missing asset is a plain 404, never the SPA fallback). The API, `/ws` and the upload route
  are `gzip off`. `vite.config.ts` splits `maplibre`, `react` and `vendor` into their own chunks (`rolldownOptions.output.
  codeSplitting`), so a deploy changes only the app's own file (about 100 kB gzipped) and a browser keeps the other 380 kB.
  The Google Fonts stylesheet is loaded with `media="print" onload` so it never blocks the first paint. Before this the bundle
  went out raw (1.75 MB JS, 225 kB CSS, no cache headers, HTTP/1.1) and a first load took about 3 s on a fast link.
- **First page is small.** `App.tsx` loads `Dashboard` with `React.lazy`, `main.tsx` does the same for `PilotLogin`, both
  inside `LoadBoundary` (a stale chunk after a deploy reloads the page once, then shows Reload). The `maplibre` chunk group
  matches only JS (`.m?js`): when it also matched the MapLibre CSS imported by `main.tsx`, the 1 MB map was preloaded on the
  sign-in page. The sign-in page now loads about 70 kB of app code plus react and vendor; the map comes after sign-in.
- **Security headers** live in `infra/nginx/security-headers.conf` (copied to `/etc/nginx/snippets/` by the web Dockerfile)
  and are included at server level **and** in every location that sets its own `add_header`, because Nginx drops inherited
  headers there. No script CSP yet (only `frame-ancestors`, `base-uri`, `object-src`, `form-action`): MapLibre's worker and
  the inline branding need a nonce plan first. `server_tokens off` hides the version.
- **Delivery kit** (`deploy/`, `docs/client-install.md`). `release.sh` packs a tarball from `git ls-files` minus secrets,
  `.data`, internal docs and dev tooling (an allowlist of client docs), refuses to finish if a secret-looking file slipped in,
  and `--with-images` adds `docker save` archives. On the server: `install.sh` (`--check` changes nothing; idempotent),
  `healthcheck.sh` (`--cron` every 5 min, webhook on change), `restore.sh` (`--verify` into a scratch database),
  `upgrade.sh` (snapshot with `:pre-<stamp>` image tags and a code tar, schema applied twice to a copy of the newest dump,
  `nginx -t` with the real certificate, switch, checks, rolls back itself), `rollback.sh`, `support-bundle.sh` (redacted).
  `lib.sh` holds the helpers (`cert_dir` follows `CERT_DIR`); under `set -e` every helper used inside `$(...)` must succeed
  (`env_get`, `container_id`), and where a script sets `umask 077` a directory Nginx, EMQX or certbot must read gets an
  explicit `chmod`. Operations settings are
  in `/etc/default/drone-fleet` (`BACKUP_TARGET`, `BACKUP_RECORDINGS`, `KEEP_DAYS`, `ALERT_WEBHOOK_URL`), state in
  `/var/lib/drone-fleet`, backups in `/var/backups/drone-fleet`, the log in `/var/log/drone-fleet.log`. `VERSION` is the
  release number. None of it has run on a fresh server yet, so the first customer install is also
  the kit's first full run.
- **Stale tabs.** Each build bakes a `__BUILD_ID__` into the bundle and writes the same id to
  `version.json` (no-store in Nginx). `UpdateNotice` fetches it on mount, every 5 minutes and when the
  tab becomes visible, and offers **Reload** when it differs. It never reloads by itself: that
  could end a recording. A dev build (`'dev'`) never counts as stale.
- Use the primitives in `src/ui/` for repeated controls. They keep the same root element and
  forward refs/ARIA/data attributes; no wrapper elements. `Icon` defaults to 18 px through both
  a `width`/`height` attribute (first paint) and `svg[data-icon]` in `base.css`; per-call
  `size-*` utilities override both.
- Responsive variants are inclusive `until-*` custom variants, widest-first (1240 → 420); add
  new ones in `tokens.css` in descending order. `pointer-fine`, `pointer-coarse` and
  `pilot-landscape` cover the RC screen. Do not use Tailwind's exclusive `max-*`.
- The deployment target is the **Chrome 95** WebView in DJI Pilot 2 on the RC Plus 2, so
  `build.target`/`cssTarget` are pinned to `chrome95` and CSS is post-processed for it. Never
  ship `@layer` to it: a browser without cascade layers drops every layered block, which
  blanks the stylesheet on the controller while desktop and phone look fine.
  `assertNoCascadeLayers` in `apps/web/vite.config.ts` fails the build if one survives.
  `dvh` (Chrome 108) and `text-wrap` (114) are still not covered; they degrade silently.
- Every dashboard screen has a path (`/`, `/live`, `/screenshots`, `/users`, `/users/new`,
  `/users/:id`, `/inventory/controllers`, `/inventory/aircraft`, `/zones`, `/flights`,
  `/flights/:id`, `/drones`, `/alerts`, `/integrations`; never a path that starts with `/api`), parsed in `src/routes.ts`
  with exact matching; anything else is the 404 page. There is no router dependency: rail
  links are real `<a href>` elements that call `followLink`, and `useLocationPath` re-renders
  on `pushState`/`popstate`. `routeAllowed` gates each path by permission and redirects to
  `/` (replace) when the account cannot use it; the API still enforces every request. A new
  screen needs an entry in `parsePath`, `pathFor`, `viewOf` and `routeAllowed`, and Nginx's
  `try_files … /index.html` already serves it.
- E2E hooks are `data-testid`; the style-parity harness also uses `data-parity` anchors on
  dynamic regions. Preserve both when changing markup.
- `tools/e2e/style-snapshot.mjs` compares computed styles and screenshots. Run it against a
  **fresh** dev server after UI changes; the running dev server must be restarted after
  `vite.config.ts`/dependency changes.
- Strict TypeScript, ESM, `verbatimModuleSyntax`. Use extensionless relative imports.
- SQL is written by hand in `store.ts`; schema changes go in `schema.sql` (idempotent).
- Keep raw MQTT payloads. The OSD mapper is still provisional except for altitude, which real
  Matrice captures (2026-10-28..30) settled: `elevation` is the height above the take-off point (0 on
  the ground) and becomes `altRel`; `height` is an ellipsoid height that wandered -60..+27 m on a
  parked aircraft and becomes `altAbs`. Flights and zone alerts read `altRel`; taking `height` for
  it started flights that never ended and hid real ones. `mode_code` 14 is the last sample before
  an aircraft drops off the link. The same captures show `battery.remain_flight_time` in seconds
  (about 960 s at 43 % in the air, 0 once landed): it is the aircraft's own estimate, so we do not
  compute one. `remainFlightSeconds()` in `osd.ts` maps it (0 or outside 1 s..24 h is `null`,
  "unknown"), `listDevices` reads it from the stored `raw` in SQL (`remain_flight_s`, no new
  column or migration), and the two must stay in step: `fleet.test.ts` checks that they agree.
  The details card and the full-screen view show it; there is no low-time alert yet.
- **Wording: drone operator.** The role `pilot` is shown to people as **Drone operator** (screens, API messages, audit labels
  and the docs; changed 2026-11-19). DJI's own names keep "Pilot": **Pilot 2**, "the Pilot page"
  (`/pilot`), "Open Pilot setup". Everything internal stays `pilot` on purpose: the role value, `PILOT_PERMISSIONS`,
  `/api/pilot/*`, `PilotList`, `AddPilot`, `data-testid="pilot-*"`, the `--role pilot` CLI option and e-mail addresses. Never
  write "pilot" for the person in a new string.
- **Wording.** The screens, the PDF and the user manual say **drone**, never "aircraft" (the
  protocol field `aircraftSns`, the route `/inventory/aircraft`, `data-testid="aircraft"` and the
  `controller_aircraft` table keep the old word on purpose: renaming them would break bookmarks,
  tests and the database). Write `${n} drone${n === 1 ? '' : 's'}` where a count shows.
- DJI publishes `latitude`/`longitude` as `0/0` while the aircraft has no position fix. The
  mapper stores that pair as `null` and the web drops it (`hasPosition`); never place a marker
  or fit bounds to `0/0` — it is null island, not a location. The original values stay in `raw`.
- `@ffmpeg-installer/ffmpeg` supplies the simulator's encoder. `SIM_VIDEO=0` disables it.
- Aedes v1 requires `await Aedes.createBroker()`; `new Aedes()` no longer processes clients.
- MapLibre v6 has no default export and needs `optimizeDeps.exclude: ['maplibre-gl']` in
  Vite, or its worker 404s in dev.
- Fastify rejects an empty body that declares `content-type: application/json`; the web
  request helper only sets it when a body exists.
- The simulator's MQTT client ID includes its PID; a duplicated simulator otherwise kicks
  the other off the broker every two seconds.
- `SIM_ENABLED=0` (shell or `.env`) makes `pnpm dev` start no simulator and pre-approve none of its
  controllers; the default stays on. Turning it back on re-creates the demo aircraft on the next
  start. Deleting demo rows from PGlite needs the API stopped.
- `pnpm dev` is `tools/dev/start.mjs`: it waits for the broker port and for `/api/health` to
  report `mqttSubscribed: true` before starting the simulator. The simulator publishes
  `update_topo` once on connect, so starting it earlier leaves `devices: 0` until reconnect.
- PGlite cannot be opened by two processes. Stop the API before running CLI commands in dev.
- `MEDIA_WHEP_INTERNAL_TEMPLATE` is the API's WHEP target
  (`http://127.0.0.1:8889/live/{key}/whep` in host mode,
  `http://srs:1985/rtc/v1/whep/?app=live&stream={key}` in Docker). Vite does not proxy
  `/media` or `/rtc`, and Nginx does not route `/rtc/` or `/live/`. In host mode MediaMTX
  binds signalling to `127.0.0.1:8889` and asks `/internal/media/auth` before a publish or
  read.
- `MqttBridge.start()` runs **after** `app.listen()`. EMQX authenticates the API's own MQTT
  connection by calling `/internal/mqtt/auth`, so connecting earlier can be refused before
  the route exists.
- The API and simulator both set `reconnectOnConnackError: true`. Without it, `mqtt.js`
  suppresses reconnects after a CONNACK auth refusal, which makes a restart race permanent.
- EMQX's HTTP authn/authz declarations need explicit `body` blocks (`username`/`password`
  and `username`/`topic`/`action`). Without them the API receives defaults and denies.
- An EMQX config that replaces `emqx.conf` must define `node` (`name`, `cookie`,
  `data_dir`) and `cluster`; the production config must also give the default WSS listener
  `ssl_options` with the mounted certs, or EMQX crash-loops on missing `cert.pem`.
- Docker dev has **no bind mounts**. Source is baked into `dji-fleet-dev:local` and
  `docker compose watch` syncs edits. `docker compose up` without a rebuild will not see
  source changes. Compose Watch cannot monitor a path that is also bind-mounted, which is
  why the bind mounts were removed.
- Docker dev deliberately ignores the root `.env`; override with `DEV_*` variables
  (`DEV_WEB_PORT`, `DEV_PUBLIC_HOST`, `DEV_MEDIA_RTMP_HOST`, `DEV_DJI_*`, …).
- Nginx resolves `api` and `srs` per request via Docker's `127.0.0.11` resolver and
  variable `proxy_pass`; recreating either container no longer needs `restart web`.
  `/healthz` on port 80 is the web healthcheck and is intentionally not redirected.
- **More than one name for the site.** `APP_DOMAIN` is the main address; `APP_DOMAIN_ALIASES` (space separated, may be
  empty) lists others that serve the same site, and the certificate must cover all of them. The web service always
  passes the variable, even empty (`${APP_DOMAIN_ALIASES:-}`): the nginx image's envsubst leaves an unset variable as
  literal text and Nginx then refuses it. `PUBLIC_HOST`, `MQTT_PUBLIC_HOST` and `MEDIA_RTMP_HOST` are what new
  controllers and video-only drones are told; an old name that still resolves keeps working. A DNS name in front of
  the server must be **DNS only** (no Cloudflare proxy): the proxy does not carry 1935/1936/8883, caps uploads at
  100 MB and hides the visitor's IP from the sign-in limits. a deployment can run one main name with others as aliases.
- `.dockerignore` excludes `**/.data` and nested `.env` files. The API image previously
  baked in `apps/api/.data/pglite`; CI now asserts it is absent.
- Secrets stay in `.env` (gitignored) and `infra/.env.production` (gitignored). Never copy
  the dev `.env` to a server. Production also needs `EMQX_NODE_COOKIE`.
- Screenshot storage is `SCREENSHOT_DIR` (`APP_TIME_ZONE` defaults to `Asia/Dhaka`); the
  dev and prod Compose stacks mount the `screenshots` named volume at `/data/screenshots`.
  The upload route owns a scoped `image/jpeg`/`image/png` body parser, so do not rely on the
  global JSON parser for it. There is no retention/cleanup job yet.

## Known gaps

- The images and the full production stack were validated locally with self-signed
  certificates: health, login, `/internal/*` 404, MQTT over TLS with good and bad
  credentials, and an API recreate that recovered through Nginx without restarting `web`.
  They have not been deployed to a real server; DNS, trusted TLS, firewall rules and DJI
  hardware remain to be validated there. The API still runs TypeScript through `tsx`.
- Docker dev WebRTC advertises `127.0.0.1:8000`. A browser on another machine needs
  `DEV_SRS_CANDIDATE` set to the Docker host's LAN IP and UDP 8000 reachable.
- RTMP ingest from the DJI apps is plain (port 1935): DJI's SDK documentation says RTMPS is not supported, and nobody has
  tried `rtmps://` on Pilot 2 or DJI Fly. The server offers RTMPS on 1936 (`infra/nginx/rtmps.conf`: an Nginx `stream`
  block, TLS 1.2/1.3 with the dashboard's certificate, to `srs:1935` through a variable so a missing SRS cannot stop Nginx
  starting; mounted into `/etc/nginx/stream.d/` by the prod compose file, which the web image includes at the top level of
  `nginx.conf`) for encoders that can use it. `node tools/docker/rtmps-check.mjs <host>` proves the path without a key.
  Any compliance statement must say plain RTMP for the controller leg until a DJI app is shown to push RTMPS; the
  alternative is a private LAN/APN or a VPN.
- HTTP-FLV fallback is not implemented in the player; WHEP only. There is no TURN or TCP
  media fallback for networks that block UDP 8000/8189.
- Sessions are revocable: every token carries a `jti` and is checked against the `sessions`
  table on each request. The residual is the 12 h maximum lifetime, not revocation. Two-step sign-in (TOTP) exists
  (security review M-05), optional unless `MFA_REQUIRED_ROLES` says otherwise; there is **no SSO / OIDC / SAML** and no
  hardware-key (WebAuthn) support, and a Pilot never has a second step.
- `live_status` is logged, not used to drive stream state, until real hardware captures
  confirm its semantics.
- Redis fan-out is not built, and telemetry retention is off until `TELEMETRY_RETENTION_DAYS` is set. Alerts (zones, contact lost, battery) appear in the dashboard (banner,
  beep, Alerts screen) only: there is no SMS, e-mail or chat notification, and no push to the
  aircraft or the controller.
- Zone and battery alerts need telemetry: an aircraft that goes silent cannot warn (contact lost is the alert for that, and it needs
  the aircraft to have been in the air and heard within the last 5 minutes; after an API restart nothing is remembered until its next sample). The built-in zones are
  approximate (see Zones above); check official aviation notices before flying near them.
- Flight data has no retention policy: the flights, alerts and `telemetry_samples` tables grow
  until someone prunes them.
- Aircraft leave service two ways: **disable** (`devices.disabled_at`) is an admin pause an
  admin can undo; **delete** (`devices.deleted_at`) is permanent from the console, and only
  the original controller can rebind it. Both hide the aircraft and refuse its MQTT topics.
  Permanent purge and controller retirement are still not built; there is no admin restore
  for a deleted aircraft, by design. See `docs/access-control.md#disable-delete-and-rebind`.
- The default Pilot OSD mapper is provisional until real captures are supplied.
- People counting is measured on synthetic composites only. COCO-trained YOLOX has never
  seen strictly top-down drone views; dense crowds and nadir shots will miss more people until
  a drone-trained model (license permitting — VisDrone weights are AGPL or non-commercial) or
  operator-verified captures are used to tune it.
- Server recordings (see above) are not in the nightly backup, and the clean-up deletes only _automatic_
  clips: manual recordings and uploads are kept until a person deletes them, so they can still fill a disk
  (the free-space floor pauses recording before that, but cannot delete them). On the 2 vCPU VPS one
  recording costs little CPU but its disk is 87 GB (about 40 drone-hours): size the disk, or set
  `RECORDING_RETENTION_DAYS`/`RECORDING_MAX_GB`, before turning automatic recording on. Automatic
  recording has only been exercised with the simulator's video and ffmpeg, never with real drones for weeks.
- Screenshot files have no automatic retention/cleanup policy. A person with `screenshots.delete`
  removes stills by hand (one, or many with Select); the `screenshots` volume must still be
  backed up and pruned operationally.
- The RC Plus 2 WebView is Chrome 95. Styles are compiled for it and `@layer` is blocked at
  build time, but the current build has not been re-opened on the controller: `dvh` sizing in
  `FocusView`/`ScreenshotGallery` and `text-balance`/`text-pretty` on the login and 404
  screens still need a newer Chrome. The probe in `docs/hardware-bring-up.md` remains the
  hardware acceptance step.

## Reference

- Operator guide (plain-language walkthrough): `docs/operator-guide.md`
- Printable user manual for operators and admins: `docs/user-manual.md`
- Bengali tutorial (adding a controller, daily use, troubleshooting): `docs/tutorial-bn.md`
- Production deployment runbook: `docs/deployment.md`
- Installing for a customer (on-premise, white-label, roles): `docs/on-premise.md`
- Customer install kit, site survey, acceptance test, hand-over, upgrades: `docs/client-install.md`
- The read-only API for a customer's own programs (token, pictures, live video, WebSocket): `docs/api.md`
- POC plan: `docs/poc-plan.md`
- Hardware checklist and production switch-over: `docs/hardware-bring-up.md`
