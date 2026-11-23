# Hardware bring-up — what needs the aircraft, controllers and a real DJI account

Status: the application is built and exercised against the simulator. Everything below is
the part that cannot be validated without hardware, a DJI Cloud API licence, or a public
server. Work down the list in order; each section says what to do and what to send back.

For the plain-language explanation of Pilot 2, the three accounts and how a drone is added,
read [`operator-guide.md`](./operator-guide.md) first.

When the machines arrive, open this document and go section by section. Nothing in the app
needs to change first.

---

## 0. What we need

| Item | Why | Minimum |
| --- | --- | --- |
| DJI aircraft + RC Plus 2 Enterprise | One controller is one gateway | 1 set |
| A second controller/aircraft set | Multi-drone stream and telemetry test (AC-4) | 2 sets |
| DJI developer account with a Cloud API app | App ID, App Key, App License | 1 |
| Public domain with TLS certificate | Pilot 2 loads our login page over HTTPS | 1 |
| VM reachable from the internet | MQTT, HTTPS, RTMP endpoints | 1 |
| SIM or Wi-Fi on every controller | Pilot 2 must reach the internet | per controller |
| Cleared flight site and permission | Field tests | 1 |

Each aircraft needs its **own** controller. Five aircraft with three controllers is a
three-aircraft fleet. Count RC Plus 2 units, not airframes.

---

## 1. DJI developer account and licence

This is the only external wait in the project; do it before anything else.

1. Register at <https://developer.dji.com>. Verification requires an email plus a phone
   number or credit card; the card is not charged.
2. Developer Center → **Apps** → **Create App**.
3. Choose **Cloud API** as the app type; fill in name, category and description.
4. Wait for the **application activation email** and complete licence generation.
5. Copy the **App ID**, **App Key** and **App License** into the server `.env`
   (`DJI_APP_ID`, `DJI_APP_KEY`, `DJI_APP_LICENSE`). Never commit them.

One app and one licence cover every controller. This is not a per-drone purchase.

**Send back:** confirmation that the three values exist (not the values themselves — put
them straight into the server environment).

---

## 2. Controller and aircraft inventory

Do this per set before the first login attempt.

On the RC Plus 2:

- Pilot 2 → profile/menu → **Settings → About**: Pilot 2 app version.
- Pilot 2 → **Device Management → Firmware Update**: current aircraft and controller
  firmware.
- Alternatively connect both to **DJI Assistant 2 (Enterprise Series)** on a PC.

Record a row per set:

| Field | Set 1 | Set 2 | … |
| --- | --- | --- | --- |
| Aircraft model | | | |
| Aircraft serial number | | | |
| Aircraft firmware | | | |
| Controller serial number | | | |
| Controller firmware | | | |
| Pilot 2 version | | | |
| DJI account used on the RC | | | |

Cloud API Pilot-to-Cloud support entered at Cloud API **v1.15**.
There is no "Cloud API version" shown on the device — what matters is that Pilot 2 is new
enough to include that support. If an update is offered, take it before testing.

**Send back:** the completed table.

---

## 3. Certificate trust test

Pilot 2 trusts a limited set of CAs. This can fail before any of our code runs.

1. Deploy the stack to the public VM with a real certificate (start with Let's Encrypt).
2. In Pilot 2, open **Cloud Services** and enter the login page URL.
3. If the page loads and the licence check passes, the CA is trusted.
4. If the WebView shows a certificate error, swap to a CA DJI documents (GoDaddy is the
   one named in DJI's Drone operator access guide) and repeat.

Do not continue to registration until the page loads without a warning.

### Tailwind WebView probe

The controller WebView reports **Chrome 95**. Tailwind v4 emits cascade layers, which Chrome
95 does not support and drops wholesale — that is what left the controller unstyled while
desktop and phone were fine. `apps/web/vite.config.ts` now compiles the stylesheet with
`postcss-preset-env` for `Chrome >= 95` (layers flattened into specificity-scoped selectors)
and pins `build.target`/`cssTarget` to `chrome95`. `assertNoCascadeLayers` fails any build
whose CSS still contains `@layer`.

Before the first flight, confirm the Pilot page renders inside Pilot 2's WebView:

1. Open `/pilot` on the RC Plus 2. It should show the rose brand mark, the large touch
   controls (48–52 px), the setup card and, in landscape, the two-column layout.
2. Confirm the page is not cached from the previous build: the stylesheet filename is
   content-hashed, so a hard restart of Pilot 2 is enough. Record `navigator.userAgent`.
3. If it is still unstyled, the WebView is older than Chrome 95 and needs more than the
   layer fix. Record the user agent and a screenshot; the next suspects are `:is()`/`:where()`
   (Chrome 88) and `@property` (Chrome 85).
4. On the dashboard, check focus view and the screenshot gallery: they size with `dvh`
   (Chrome 108+), which Chrome 95 silently ignores.

`node tools/e2e/pilot-compat.mjs` covers the styling and binding flow against a preview
build, and CI runs it. It cannot reproduce Chrome 95 itself; this probe is the remaining
hardware acceptance step.

**Send back:** which CA worked, the WebView probe result, and a photo of any error screen if
it fails.

---

## 4. First registration (AC-1)

Goal: the aircraft appears online in the dashboard within 10 s of login.

1. Start the stack, keep the API log and the MQTT message log open (`GET /api/debug/messages`,
   admin).
2. On the controller: Cloud Services → enter our URL → log in.
3. Observe, in order:
   - licence verification result (JSBridge callback),
   - MQTT connect callback,
   - `sys/product/{rc}/status` with `update_topo`,
   - the first `thing/product/{drone}/osd`.
4. Screenshot the dashboard and note the wall-clock time from login to the green dot.

**Send back:** screenshot, timings, and the raw `update_topo` payload from the message log.

---

## 5. Capture the aircraft model

The app ships a default OSD mapper. The real field names must be confirmed against a
real aircraft.

1. Raw messages are already persisted — open the MQTT inspector as an admin
   (`GET /api/debug/messages`, last 200) or query the `mqtt_log` table. There is no extra
   logging switch to enable.
2. Fly for at least 10 minutes with takeoff, hover, cruise and landing.
3. Export the captured `osd` and `state` messages.
4. Add the export to the repo as a fixture (no credentials in it).

What we are checking: altitude field names, battery nesting, flight-mode codes, GNSS/RTK
fields, and whether the payload reports the camera indexes we expect.

**Send back:** the export plus a note of anything that looked wrong on the dashboard
(wrong altitude, wrong heading, missing battery).

---

## 6. Live video

This is the highest-risk part of the POC.

1. Capture `live_capacity` from `thing/product/{rc}/state` and send it back. It lists the
   camera indexes and video indexes that make up a `video_id`.
2. Start a stream from the dashboard. Record:
   - time from click to `services_reply`,
   - time from reply to SRS `on_publish`,
   - time from click to first frame in the browser.
3. Leave it running for 30 minutes and note any drop.
4. Measure latency with a stopwatch in front of the camera (camera-to-browser).
5. Change quality and lens during the stream; confirm both take effect.
6. Test `url_type: 4` (WHIP) if Drone operator accepts it; if it does, note the reduction in
   latency. If it rejects, stay on RTMP.
7. Try `url_type: 2` (RTSP) once, purely to record whether this firmware still accepts it.
8. Measure the controller's keyframe (GOP) interval on an internal host with
   `ffprobe -show_frames rtmp://<internal-rtmp>/live/<key>`. WebRTC playback starts at the
   next keyframe, so an interval above 2 s adds up to that much to time-to-first-frame.

**Send back:** `live_capacity` JSON, the three timings, the 30-minute result, the measured
latency, the GOP interval and whether WHIP worked.

---

## 7. Multi-drone (AC-4)

With the second set:

1. Both controllers registered and online.
2. Both aircraft flying and streaming at once for 30 minutes.
3. Confirm the four-tile wall, independent camera control, and no cross-talk between
   serial numbers.
4. Record server CPU, memory, and ingress/egress bandwidth during the run.

**Send back:** a screenshot of both aircraft on the map and both streams live, plus the
server resource numbers.

---

## 8. Network fault (AC-5)

1. While streaming, enable airplane mode on one controller for 60 s.
2. Confirm the dashboard marks it offline.
3. Disable airplane mode; confirm it returns online and telemetry resumes without manual
   action.
4. Restart the backend during a flight; confirm recovery within 30 s.

**Send back:** timeline of what the dashboard showed and when.

---

## 9. Site and permissions

- Book the site and any permits before Phase 2.
- Check cellular coverage at the site with the controller, not with a phone.
- Have a second person as observer during latency tests.

---

## 10. What to send back, in one bundle

When the machines are available, send:

- [ ] Completed inventory table (section 2)
- [ ] The CA that worked (section 3)
- [ ] Raw `update_topo` payload (section 4)
- [ ] 10-minute OSD/state capture (section 5)
- [ ] `live_capacity` JSON (section 6)
- [ ] Live timings, latency and 30-minute stream result (section 6)
- [ ] Multi-drone screenshots and server numbers (section 7)
- [ ] Network-fault timeline (section 8)

With that, the remaining work is mapping confirmation and tuning — not architecture.

---

## 11. Switching the app from development to real hardware

Four things are placeholders today. Each has to be replaced before a controller can
register against a production deployment.

| Placeholder | Real replacement |
| --- | --- |
| `dev-app-id` / `dev-app-key` / `dev-license` | The Cloud API app from the DJI Developer Center |
| Embedded Postgres, local Aedes broker, MediaMTX | Postgres, EMQX and SRS on the public server |
| Simulated aircraft with an ffmpeg test pattern | The aircraft and RC Plus 2 pushing telemetry and RTMP |
| The placeholder JWT secret and `admin12345` in `.env` | A random JWT secret and a strong admin password |

### 11.1 What to procure or decide

- **A public domain** with DNS control, and three names: `app.` for the web app and API,
  `mqtt.` for EMQX, `media.` for SRS. They can be subdomains of one domain.
- **A VM** with a public IPv4, reachable on 443/tcp, 8883/tcp, 1935/tcp and 8000/udp.
  4 vCPU / 8 GB is the starting size.
- **A TLS certificate** for those names. Start with Let's Encrypt; if Pilot 2 rejects it,
  use a CA DJI documents (GoDaddy).
- **The DJI Cloud API app** (App ID, App Key, App License). Create it now; the licence
  activation email is the only external wait.

### 11.2 Environment changes

Everything below is for a **host-run API** pointed at `infra/docker-compose.yml`. The
containerised production stack reads `infra/.env.production` and sets `DATABASE_URL`,
`MQTT_URL` and `CORS_ORIGINS` itself (see `infra/docker-compose.prod.yml`); the API reaches
EMQX as `mqtt://emqx:1883`, not through the public `mqtt.` hostname. The left column is
what development uses.

| Variable | Development | Real |
| --- | --- | --- |
| `DJI_APP_ID`, `DJI_APP_KEY`, `DJI_APP_LICENSE` | `dev-*` | From the Developer Center |
| `JWT_SECRET` | The `.env` placeholder | 32+ random bytes |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `admin@example.com`, `admin12345` | Your real accounts |
| `PUBLIC_HOST` | `localhost` | `app.example.com` (enables secure cookies) |
| `DATABASE_URL` | unset (embedded PGlite) | `postgres://user:pass@db:5432/dji` |
| `MQTT_URL` | `mqtt://127.0.0.1:1883` | `mqtts://mqtt.example.com:8883` (host-run) or `mqtt://emqx:1883` (compose) |
| `MQTT_PUBLIC_HOST` | `tcp://localhost:1883` | `ssl://mqtt.example.com:8883` — the scheme is required by Pilot 2 |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | `dji-server` | A dedicated server account |
| `MEDIA_RTMP_HOST` | `localhost:1935` | `media.example.com:1935` |
| `MEDIA_WHEP_INTERNAL_TEMPLATE` | `http://127.0.0.1:8889/live/{key}/whep` (MediaMTX) | `http://srs:1985/rtc/v1/whep/?app=live&stream={key}` |
| `SIM_*` | enabled | Do not start the simulator at all |

Do not copy the development `.env` to the server. Create it there, restrict its
permissions, and leave it out of git.

### 11.3 Security layer (built and tested locally)

- **Per-controller MQTT credentials.** The Pilot page sends the controller serial at login.
  The API issues a unique `gw_<sn>` username and random password, stores only the Argon2id
  hash, and rotates it on each login. EMQX verifies connections and every publish/subscribe
  through `/internal/mqtt/auth` and `/internal/mqtt/acl`. A controller may publish only its
  own topics and its own aircraft's telemetry, and subscribe only to its own services.
  Verified locally: own topics allow, other serials and wildcards deny.

  > These checks are wired by `infra/emqx/emqx.conf`, which only
  > `infra/docker-compose.prod.yml` mounts. The development compose file does not load it,
  > so per-controller auth/ACL is **inactive** in host-run development mode.
- **Production Nginx** (`infra/nginx/app.conf.template`): TLS, the built app, `/api`,
  `/ws`, WHEP through the API, SPA fallback for `/pilot`, and `/internal/` blocked.
  `/rtc/` and `/live/` are intentionally not routed.
- **Rate limiting** on web login (10/min), Drone operator login (20/min) and Drone operator config (60/min).
- **CORS** restricted to configured origins, empty in production.
- **Drone operator accounts** through the CLI:
  `pnpm --filter @dji/api user:create -- --email … --password … --role pilot`.
- **Revocation**: `pnpm --filter @dji/api gateway:revoke -- --sn <rc serial>`.

Still open, but not security blockers: HTTP-FLV fallback in the player (WHEP only today),
alerts, and the retention job.

### 11.4 Deployment shape

Use the production stack: Nginx is the only public HTTP(S) entry point, and EMQX and SRS
terminate their own protocols.

1. Copy `infra/.env.production.example` to `infra/.env.production` and fill it in.
2. Start everything:

   ```bash
   docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml up -d --build
   ```

3. Set `PUBLIC_IP` (the SRS WebRTC candidate) and open 443/tcp, 8883/tcp, 1935/tcp and
   8000/udp. Postgres, the EMQX dashboard and the SRS API stay on the internal network.
4. On the controller, enter `https://app.example.com/pilot`.

The production stack was validated locally with self-signed certificates (health, login,
`/internal/*` blocking, MQTT over TLS and Nginx recovery). DNS, a trusted certificate,
firewall rules and the real controller still have to be validated on the target host; run
`node tools/docker/preflight.mjs --prod` before starting it. See
[`deployment.md`](./deployment.md) → Production deployment and verification.

A host-run variant is useful while debugging: `pnpm install && pnpm build`, run the API
with `pnpm --filter @dji/api start`, and bring up `infra/docker-compose.yml` for Postgres,
EMQX and SRS. That mode has no TLS and does not load the EMQX auth/ACL config, so keep it
on a private network and never point a real controller at it.

### 11.5 The first real registration

Follow sections 2 to 4 in order: firmware inventory, certificate trust, then registration.
The first `update_topo` and `osd` messages are the point where the simulator is no longer
involved. Capture them and send them back; that is when the model-specific mapper can be
confirmed and the placeholders are fully gone.
