# DJI Aircraft Live Dashboard – POC Plan

Oct 19, 2026

## 1. Overview

The POC proves that a web dashboard we host can show live telemetry and live video from one or several DJI aircraft through DJI Cloud API, in an estimated six weeks.

**How the connection works.** Cloud API never connects the aircraft to our server directly. The aircraft links to a gateway device, the DJI RC Plus 2 Enterprise controller running DJI Pilot 2, and Pilot 2 logs in to our cloud over MQTT, HTTPS and WebSocket ([architecture](https://developer.dji.com/doc/cloud-api-tutorial/en/overview/product-architecture.html)). We must therefore host the MQTT broker, HTTPS service, WebSocket service, object storage and a streaming media server ourselves.

**Aircraft support.** DJI's [release notes](https://developer.dji.com/doc/cloud-api-tutorial/en/) list Pilot-to-Cloud support from Cloud API v1.15, together with MOP data transfer. DJI documents Cloud API among the SDKs its aircraft support.

**Assumptions**

- Each aircraft flies with its own DJI RC Plus 2 Enterprise controller running Pilot 2 and connected to the internet. One controller is one gateway, so several drones means several controllers.
- We hold a DJI developer account with a Cloud API app (App ID, App Key, License).
- Our server has a public domain and a valid TLS certificate reachable from the controllers.
- The POC is read-only: telemetry and video only, no flight commands from the web.

## 2. Requirements

The POC must show one to four aircraft online, moving on a map, with a live camera view in the browser. Everything else is secondary.

**Functional requirements**

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-1 | Register a Pilot 2 controller with our cloud: license check, login, MQTT credentials issued | Must |
| FR-2 | Show online and offline state of each controller and aircraft | Must |
| FR-3 | Show live telemetry per aircraft: position, altitude, speed, heading, battery, flight mode, GNSS/RTK state | Must |
| FR-4 | Map view of all connected aircraft with a short trail | Must |
| FR-5 | Start and stop live video from the web for a chosen aircraft and camera | Must |
| FR-6 | Play live video in the browser; tile up to four aircraft at once | Must |
| FR-7 | Web login with two roles: admin and viewer | Must |
| FR-8 | Admin page: workspaces and the device list | Must |
| FR-9 | Switch camera lens and video quality during a stream | Should |
| FR-10 | Store telemetry and replay the last flight | Should |
| FR-11 | Alerts for low battery, link loss and aircraft going offline | Should |
| FR-12 | Raw MQTT message inspector for debugging | Should |

**Non-functional requirements.** The targets below are our proposals, not DJI figures. The first spike measures what is achievable.

| Quality | Proposed target | How we verify |
| --- | --- | --- |
| Video latency, camera to browser | 3 s typical, 8 s worst case on fallback playback | Timestamp overlay test on a real flight |
| Telemetry freshness | Browser shows data less than 1 s after the message reaches our broker | Timestamps logged at broker, backend and browser |
| Concurrency | 4 aircraft in the POC; design for 50 | Simulated publishers for the larger number |
| Availability | Single node in the POC; no single-node assumptions in the code | Design review |
| Security | TLS on every endpoint, per-controller MQTT credentials, signed web sessions | Security checklist in section 7 |
| Data retention | 30 days of telemetry | Retention job test |

**Out of scope for the POC:** flight control from the web, wayline and mission planning, media upload and library, firmware management, and multi-tenant billing.

## 3. Architecture

One cloud platform sits between the controllers and the browsers: it terminates MQTT from Pilot 2, receives RTMP video on a media server, and pushes live state to the web app over WebSocket.

&#91;embedded content: system architecture · 5 cloud services, 3 external parties\]

Controllers log in over HTTPS, then send MQTT and RTMP to the cloud; browsers use Nginx for the app and SRS for video.

**Components**

- **DJI Pilot 2 on the RC Plus 2 Enterprise.** The gateway. It opens our login page in its WebView, then connects to our MQTT broker and reports for itself and the aircraft.
- **Reverse proxy (Nginx).** TLS, the web app, the HTTPS APIs and the WebSocket upgrade.
- **MQTT broker (EMQX).** Per-controller credentials and topic permissions.
- **Backend (Node.js, TypeScript).** Subscribes to device topics, keeps the device registry, exposes REST and WebSocket, and sends service calls such as start-live.
- **PostgreSQL.** Users, workspaces, devices and telemetry. Redis holds the latest state per aircraft and fans messages out between backend instances.
- **Media server (SRS).** Accepts RTMP from Pilot 2 and serves WebRTC and HTTP-FLV to browsers.
- **Web app (React, Vite).** Login, device list, map and video wall.

**Data flows**

1. **Registration.** Pilot 2 loads our login page, verifies the license, receives a token and MQTT credentials, then connects to the broker.
2. **Telemetry.** Pilot 2 publishes osd and state messages. The backend validates, stores and caches them, then pushes changes to subscribed browsers.
3. **Video.** The browser asks the backend to start a stream. The backend sends live\_start\_push over MQTT with an RTMP URL on our media server. Pilot 2 pushes video there and the browser plays it.
4. **Commands.** The backend publishes a service message to the controller and waits for the matching reply, correlated by tid.

**Design decisions**

| Decision | Choice | Reason |
| --- | --- | --- |
| Video ingest protocol | RTMP | Listed for live streaming in DJI's docs; a developer reported RTSP start via MQTT stopped working after a firmware update |
| Browser playback | WebRTC from SRS, HTTP-FLV as fallback | Lowest latency, with a plain fallback if WebRTC is blocked |
| Backend language | TypeScript on Node.js | Shares message types with the React app |
| Reference code | Protocol reference only | DJI [stopped maintaining its Cloud API demo](https://developer.dji.com/doc/cloud-api-tutorial/cn) on 10 April 2025 and advises against production use |
| Telemetry storage | PostgreSQL with time partitioning | One database for the POC; TimescaleDB can be added without schema changes |

## 4. DJI Cloud API integration

Integration has four parts: a DJI developer app and license, a login page that Pilot 2 loads, an MQTT topic contract, and a few HTTPS endpoints.

**Prerequisites**

- A DJI developer account and an app of type Cloud API. The developer center issues the App ID, App Key and License after an activation email ([steps](https://developer.dji.com/doc/cloud-api-tutorial/en/quick-start/source-code-deployment-steps.html)).
- Controller and Pilot 2 firmware that supports the target aircraft under Cloud API. We record the exact versions in Phase 0.
- A public domain with a TLS certificate. DJI documents that Pilot 2 supports certificates issued by GoDaddy and suggests the same authority for MQTT over TLS ([Pilot access to cloud](https://developer.dji.com/doc/cloud-api-tutorial/cn/feature-set/pilot-feature-set/pilot-access-to-cloud.html)). We test other authorities in Phase 0.
- Internet on every controller, by Wi-Fi or a cellular dongle.

**Pilot 2 registration sequence**

1. The operator opens Cloud Services in Pilot 2 and enters the address of our login page.
2. The page calls `platformVerifyLicense(appId, appKey, license)` through the JSBridge. If this fails, nothing after it works.
3. The operator logs in. Our server returns a token, which Pilot 2 stores and the page can read with `apiGetToken()`.
4. The page loads the API module with our HTTPS address and token, then loads the cloud module with our MQTT address, credentials and client ID. Pilot 2 connects and reports the result back to the page by callback.
5. The page sets the workspace id and platform name that Pilot 2 displays, and loads the live streaming module with `platformLoadComponent`.

**MQTT topics the POC uses.** Topic names are from DJI's [topic definition](https://developer.dji.com/doc/cloud-api-tutorial/en/api-reference/pilot-to-cloud/mqtt/topic-definition.html).

| Topic | Direction | Use in the POC |
| --- | --- | --- |
| `thing/product/{device_sn}/osd` | Device to cloud | Periodic properties: position, attitude, speed, battery |
| `thing/product/{device_sn}/state` | Device to cloud | Changed properties, including `live_capacity` |
| `thing/product/{gateway_sn}/services` | Cloud to device | Commands: `live_start_push`, `live_stop_push`, `live_set_quality`, `live_lens_change` |
| `thing/product/{gateway_sn}/services_reply` | Device to cloud | Result of each command |
| `thing/product/{gateway_sn}/events` | Device to cloud | Events for later features; logged only in the POC |
| `thing/product/{gateway_sn}/requests` and `requests_reply` | Both | Device requests, such as upload credentials; logged only in the POC |

Messages carry a transaction id (`tid`), a business id (`bid`) and a `data` object. Service messages add a `method` name. The `{device_sn}` is the aircraft or controller that owns the property; `{gateway_sn}` is the controller.

**Behaviours that shape the design**

- DJI support states that Cloud API only sends data to the cloud and offers no query interface ([forum reply](https://sdk-forum.dji.net/hc/en-us/community/posts/24798060361241-Retrieving-serious-low-battery-warning-threshold-and-low-battery-warning-threshold-via-Cloud-API)). We store the last known state per device and cannot ask for it later.
- `live_capacity` sits in the gateway's state and is pushed only when it changes ([live stream guide](https://developer.dji.com/doc/cloud-api-tutorial/en/feature-set/pilot-feature-set/pilot-livestream.html)). We persist it, because it lists the camera and video indexes that make up a `video_id`.
- A `video_id` has the form `{sn}/{camera_index}/{video_index}`, for example `1ZNDH1D0010098/39-0-7/normal-0` ([live stream API](https://developer.dji.com/doc/cloud-api-tutorial/en/api-reference/pilot-to-cloud/mqtt/rc-pro/live.html)).

**Aircraft notes.** Cloud API [release notes](https://developer.dji.com/doc/cloud-api-tutorial/en/) add Pilot-to-Cloud and MOP data transfer in v1.15. DJI's newer [Cloud API 2](https://developer.dji.com/cloud-api-2) kit includes a device simulator, but describes itself as a kit for dock applications. We evaluate in Phase 0 whether that simulator lets the team build without hardware.

## 5. Live video design

Pilot 2 pushes RTMP into our SRS media server, and browsers play it over WebRTC with HTTP-FLV as the fallback.

**Protocol options.** DJI's live streaming guide states that the platform must run its own MQTT and streaming servers, and that streaming supports RTMP, RTSP, GB28181 and Agora ([guide](https://developer.dji.com/doc/cloud-api-tutorial/en/feature-set/pilot-feature-set/pilot-livestream.html)).

| Protocol | What DJI offers | Decision |
| --- | --- | --- |
| RTMP | `url_type` 1; needs only a URL | **Chosen.** Simple, and SRS ingests it natively |
| Agora | `url_type` 0; managed WebRTC service | Fallback only: external account, tokens and cost |
| GB28181 | `url_type` 3; SIP-based, used by surveillance platforms | Not chosen: needs a SIP server |
| RTSP | Named in DJI's docs, but a developer [reported](https://sdk-forum.dji.net/hc/en-us/community/posts/35478215516057-Missing-RTSP-Livestream-Start-Feature-via-MQTT) start via MQTT failing after a firmware update | Not chosen |
| WebRTC (WHIP) | `url_type` 4 appears in the [Dock 2 API](https://developer.dji.com/doc/cloud-api-tutorial/cn/api-reference/dock-to-cloud/mqtt/dock/dock2/live.html), not on the Pilot page we found | Check in the Phase 3 spike whether the Pilot path accepts it |

The `url_type` values for Pilot come from DJI's [Pilot live stream API](https://developer.dji.com/doc/cloud-api-tutorial/en/api-reference/pilot-to-cloud/mqtt/rc-pro/live.html). A DJI support reply to a developer with RTMP trouble recommends deploying SRS yourself ([forum](https://sdk-forum.dji.net/hc/zh-cn/community/posts/38872975988377-Cloud-Api-Streaming-issue)).

**Media server setup**

- Ingest URL per session: `rtmp://<media-host>/live/<stream_key>`. The backend creates a random `stream_key` per start request and maps it to the `video_id`.
- SRS calls our backend on publish and unpublish. Only keys we issued are accepted, and the callbacks drive the stream state.
- WebRTC playback uses SRS's default media port, 8000/udp, which must be open. When UDP is blocked the web app falls back to HTTP-FLV.
- The dashboard plays video only. We confirm SRS version and RTMP-to-WebRTC conversion in Phase 0.

**Stream lifecycle**

1. The browser asks the backend to start a stream for a device, camera and quality.
2. The backend checks `live_capacity`, creates the stream record and sends `live_start_push` with the RTMP URL and `video_id`.
3. It waits up to 10 s for `services_reply`, then for SRS to report the publish. The stream becomes live and the browser receives its playback URL.
4. The browser sends a heartbeat while playing. After 60 s without one the backend sends `live_stop_push`.
5. An unpublish callback from SRS marks the stream stopped, whatever caused it.

**Multiple aircraft.** Each controller streams independently. `live_capacity` reports the maximum number of simultaneous streams per device, and the backend refuses a start that would exceed it. The video wall tiles up to four streams in the POC. We measure bitrate per stream in Phase 3 and size server bandwidth from that: ingest equals streams times bitrate, and egress equals viewers times bitrate.

## 6. Low-level design

The backend is one stateless TypeScript service plus a simulator that lets the team build and load-test without a drone.

### 6.1 Repository layout

```text
dji-dashboard/
  apps/web/             React + Vite single-page app
  apps/api/             Node.js + TypeScript backend (Fastify)
  packages/protocol/    zod schemas and types for MQTT and WebSocket messages
  infra/                docker-compose: emqx, srs, postgres, redis, nginx
  tools/simulator/      MQTT publisher that behaves like a Pilot 2 gateway
```

Libraries: Fastify, mqtt.js, zod, ioredis and a typed SQL layer (Drizzle). The web app uses MapLibre GL for the map and Zustand for state.

### 6.2 Data model

| Table | Purpose | Key columns |
| --- | --- | --- |
| `users` | Web accounts | id, email, password\_hash, role (admin or viewer) |
| `workspaces` | Group of controllers; its id and name are shown in Pilot 2 | id, name, platform\_name |
| `gateways` | Controllers | sn (primary key), workspace\_id, online, last\_seen\_at, firmware |
| `gateway_credentials` | MQTT login per controller | gateway\_sn, username, password\_hash, expires\_at |
| `devices` | Aircraft | sn (primary key), gateway\_sn, model, online, last\_seen\_at, live\_capacity (jsonb), cameras (jsonb) |
| `telemetry_samples` | Time series, partitioned by day | device\_sn, ts, lat, lon, alt\_rel, alt\_abs, heading, speed\_h, speed\_v, battery\_pct, mode, gnss\_fix, raw (jsonb) |
| `streams` | Live video sessions | id, device\_sn, video\_id, stream\_key, state, quality, requested\_by, started\_at, stopped\_at |
| `device_events` | Events and alerts | id, device\_sn, ts, kind, payload (jsonb) |
| `mqtt_log` | Raw messages for the inspector; kept 24 h | id, ts, topic, payload (jsonb), valid |

Raw OSD field names differ by aircraft model. The backend normalises each message into one canonical sample through a per-model mapper. We fill the model-specific mapper in Phase 2 from DJI's thing model and from real captures, and keep the raw payload alongside.

### 6.3 MQTT ingest pipeline

1. Subscribe with a shared subscription so several backend instances split the load: osd, state, events and requests for all devices, and services\_reply for all gateways.
2. Parse the JSON and validate it with the zod schema. Invalid messages go to `mqtt_log` with `valid = false` and are not processed.
3. Resolve the device and its gateway. An unknown serial number is logged and dropped.
4. Write the latest state to Redis and publish a change notice.
5. Append telemetry to a buffer and flush to PostgreSQL in one batch per second.
6. The WebSocket hub sends the change to subscribed browsers, at most twice per second per aircraft.

**Service calls.** `callService(gatewaySn, method, data)` publishes with a new `tid`, stores a pending promise keyed by `tid`, and resolves it when `services_reply` carries the same `tid`. It rejects after 10 s. A non-zero result in the reply is treated as an error. We confirm the result format against DJI's reference in Phase 1.

### 6.4 REST API

| Endpoint | Caller | Purpose |
| --- | --- | --- |
| `POST /api/pilot/login` | Pilot 2 login page | Check credentials; return token, workspace id, platform name and MQTT connection details |
| `GET /api/pilot/config` | Pilot 2 login page | Return the license parameters needed by the JSBridge |
| `POST /api/auth/login`, `POST /api/auth/refresh` | Web app | Web session tokens |
| `GET /api/devices` | Web app | Controllers and aircraft with online state and last telemetry |
| `GET /api/devices/{sn}/telemetry` | Web app | History by time range |
| `GET /api/devices/{sn}/trail` | Web app | Recent positions for the map trail |
| `POST /api/streams` | Web app | Start live video; returns stream id |
| `PATCH /api/streams/{id}` | Web app | Change lens or quality |
| `POST /api/streams/{id}/heartbeat` | Web app | Keep the stream alive |
| `DELETE /api/streams/{id}` | Web app | Stop live video |
| `POST /internal/srs/on_publish`, `on_unpublish` | SRS | Accept or reject a stream key; update state |
| `POST /internal/mqtt/auth`, `acl` | EMQX | Check controller credentials and topic permissions |
| `GET /api/health` | Monitoring | Liveness of API, broker, database and media server |

### 6.5 WebSocket protocol

The browser connects to `wss://<host>/ws` with its session token and sends `subscribe` with a list of channels: `devices` for all status changes, or `device:<sn>` for one aircraft. The server sends:

- `device.status`: serial number, online flag, last seen time.
- `telemetry`: serial number, timestamp and the canonical sample.
- `stream.state`: stream id, state, and playback URLs once live.
- `alert`: serial number, kind and message.

The client reconnects with exponential backoff and re-sends its subscriptions. After a reconnect it refetches `GET /api/devices` to close any gap.

### 6.6 Web app components

- **PilotLoginPage:** the minimal page Pilot 2 loads. Runs the license check and loads the Pilot modules.
- **AppShell and LoginPage:** session handling and role-based navigation.
- **DeviceList:** controllers and aircraft with status, battery and last seen.
- **MapView:** MapLibre map with one marker and trail per aircraft; selecting a marker opens the telemetry panel.
- **TelemetryPanel:** current values and a short battery and altitude history.
- **VideoWall and VideoTile:** a WebRTC player with HTTP-FLV fallback, lens and quality controls, and a stream state badge.
- **AlertsPanel:** low battery, link loss and offline events.
- **AdminPage and MqttInspector:** workspaces and device binding, and a live view of raw messages.

## 7. Security and infrastructure

The POC runs on one VM with Docker Compose, and only four ports face the internet.

**Deployment topology**

| Service | Port | Reachable from |
| --- | --- | --- |
| Nginx (web app, REST, WebSocket, HTTP-FLV) | 443/tcp | Internet |
| EMQX MQTT over TLS | 8883/tcp | Internet (controllers) |
| SRS RTMP ingest | 1935/tcp | Internet (controllers) |
| SRS WebRTC media | 8000/udp | Internet (browsers) |
| EMQX dashboard, SRS API, backend internal routes | various | Internal network only |
| PostgreSQL, Redis | 5432, 6379 | Internal network only |

We use three sub-domains (app, mqtt, media) under one domain. A starting size for the VM is 4 vCPU and 8 GB of memory; we resize after the Phase 3 bitrate measurements.

**Security controls**

- **Web sessions.** Passwords hashed with argon2id. Short-lived access tokens plus refresh tokens. Admin and viewer roles enforced on the server.
- **MQTT.** No anonymous access. Each controller gets its own credentials at Pilot login. EMQX asks the backend to check them and the topic permissions: a controller may publish only on its own serial number and its aircraft's, and subscribe only to its own services and requests\_reply topics. The backend uses a separate privileged account.
- **Video ingest.** RTMP is not encrypted, and DJI's Mobile SDK documentation says it does not support RTMPS ([forum](https://sdk-forum.dji.net/hc/en-us/articles/6663305630105/comments/29818306830233)). We reduce the risk with single-use stream keys that expire after 60 s if unused, and we confirm the Pilot 2 behaviour in Phase 3.
- **Video playback.** Playback URLs are signed and expire. SRS asks the backend to approve each play request.
- **License parameters.** The JSBridge needs the App Key on the controller, so it cannot stay server-side. We serve it only over TLS, rate-limit the endpoint, and rotate it if it leaks.
- **Internal routes.** The SRS and EMQX callbacks are not routed through Nginx.
- **Audit.** Stream start and stop, logins and device binding are logged with the user and time.
- **Secrets.** Kept in environment files outside the repository for the POC; a secret manager before any wider use.
- **Reference code.** DJI's demo is for understanding the API calls only, and DJI warns it may contain unfixed security issues. We do not copy it into the product.

## 8. Implementation plan

The POC takes an estimated six weeks in five phases, and each phase ends on something we can show on the real aircraft.

&#91;embedded content: POC timeline · 5 phases, 6 weeks\]

Phases overlap on purpose: registration starts as soon as the first spike passes. The table below lists each exit criterion.

| Phase | Weeks | Work | Exit criterion |
| --- | --- | --- | --- |
| 0. Setup and spikes | 1 | DJI developer app and license; record controller and Pilot 2 firmware; VM, domain and certificates, including a test of other certificate authorities; Compose stack; simulator skeleton; evaluate the Cloud API 2 simulator | The controller opens our login page and the license check passes |
| 1. Registration and device registry | 1 to 2 | Pilot login page and JSBridge flow; EMQX auth and ACL; ingest of osd and state into `mqtt_log`; online and offline tracking; MQTT inspector | The aircraft shows online in the device list and raw OSD is visible in the inspector |
| 2. Telemetry and map | 2 to 3 | Model-specific mapper; Redis latest state; batched storage; WebSocket hub; map, trail and telemetry panel | The marker moves with under 1 s delay after the message reaches the broker |
| 3. Live video | 3 to 5 | SRS with callbacks; start and stop; WebRTC and HTTP-FLV players; video wall; lens and quality; heartbeat | Live camera view of the aircraft in the browser, with measured latency |
| 4. Multi-drone and hardening | 5 to 6 | Two or more controllers, simulator for larger counts; alerts; retention job; soak test; security checklist; demo and POC report | All acceptance criteria in section 9 are met |

**Team and access (assumed).** One backend engineer, one frontend engineer and part of a DevOps engineer's time. Hardware needed: one aircraft with its RC Plus 2 Enterprise from week 1, a second set for the multi-drone test in phase 4, and permission and a safe site for test flights.

## 9. Test plan and acceptance criteria

The POC passes when all six criteria below are met on real aircraft hardware. Thresholds are proposals for the team to confirm.

| ID | Criterion | Measured by |
| --- | --- | --- |
| AC-1 | A controller registers and the aircraft shows online in the dashboard within 10 s of login | Stopwatch test, three attempts |
| AC-2 | During a flight the marker, trail and telemetry panel update continuously, with under 1 s between broker receipt and browser display | Timestamps at broker, backend and browser |
| AC-3 | Live video starts within 10 s of the click and runs at 3 s typical latency for 30 minutes without a drop | Timestamp overlay, session log |
| AC-4 | Two real aircraft stream video and telemetry together for 30 minutes; the simulator drives 50 aircraft of telemetry with backend lag under 1 s | Field test and load test |
| AC-5 | A 60 s network loss on a controller shows offline, then recovers to online and live telemetry without manual action; a backend restart recovers within 30 s | Fault injection |
| AC-6 | The security checklist in section 7 passes, and unauthenticated MQTT and web access are rejected | Checklist review and a negative test |

**Test layers**

- **Unit:** message schemas, the model-specific mapper, the service-call correlation by `tid`.
- **Integration:** the simulator publishes recorded message sequences; tests assert on the database and WebSocket output. Real captures from phase 1 become the fixtures.
- **Field:** staged flights on a cleared site, with a log of timestamps and screenshots of each criterion.
- **Load and soak:** simulator at 50 aircraft; a two-hour run with four streams to find leaks and reconnect faults.
- **Security:** the checklist, plus attempts to connect to MQTT without credentials, publish to another controller's topics, and play a video with an expired URL.

## 10. Risks, open questions and next steps

The largest risk is that live video through Pilot 2 behaves differently from what DJI's documents suggest, so phase 0 tests it on real hardware first.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Release notes list Pilot-to-Cloud support, but we have not confirmed live video on our firmware | Core feature blocked | Phase 0 spike on the real aircraft; record firmware versions |
| Pilot 2 does not trust our certificate authority | MQTT or HTTPS login fails | Test authorities in phase 0; use a GoDaddy-issued certificate, as DJI documents |
| RTMP latency above the 3 s target | Weak demo | Measure early; fall back to Agora, or to WHIP if the aircraft accepts `url_type` 4 |
| Cellular uplink at the flight site is weak or unstable | Video drops or stalls | Use the quality setting; measure bitrate in phase 3 |
| Field names and result codes unconfirmed for the target aircraft; DJI's docs site renders client-side, so we read them from excerpts | Wrong mapping | Build the mapper from real captures; keep raw payloads; contract tests on captured messages |
| DJI's reference demo is unmaintained | No working sample to copy | Use it as a protocol reference only; own the schemas in `packages/protocol` |
| Test flights need permits and a safe site | Schedule slips | Book site and permissions before phase 2 |

**Open questions**

- What are the start date and the team size?
- Which hosting provider and region, and which domain will we use?
- Which map tile source should MapLibre use?
- Will the aircraft ever operate from a dock, or only with controllers? The dock path differs.
- Is flight control or media upload planned after the POC? It would add the DRC and file upload features.
- What counts as the target scale beyond the POC: aircraft, viewers and sites?

**Next steps.** Confirm the open questions, create the DJI developer app, and start phase 0 with one aircraft and its controller.

## 11. Sources

Checked 19 to 20 October 2026. DJI's documentation site renders in the browser, so details were read from search excerpts of these pages; we confirm them against live captures in phase 0.

- [Cloud API release notes](https://developer.dji.com/doc/cloud-api-tutorial/en/)
- [Cloud API product architecture](https://developer.dji.com/doc/cloud-api-tutorial/en/overview/product-architecture.html)
- [Pilot live stream guide](https://developer.dji.com/doc/cloud-api-tutorial/en/feature-set/pilot-feature-set/pilot-livestream.html)
- [Pilot live stream MQTT API](https://developer.dji.com/doc/cloud-api-tutorial/en/api-reference/pilot-to-cloud/mqtt/rc-pro/live.html)
- [Dock 2 live stream API (WebRTC WHIP value)](https://developer.dji.com/doc/cloud-api-tutorial/cn/api-reference/dock-to-cloud/mqtt/dock/dock2/live.html)
- [Pilot-to-cloud topic definition](https://developer.dji.com/doc/cloud-api-tutorial/en/api-reference/pilot-to-cloud/mqtt/topic-definition.html)
- [Pilot access to cloud (Chinese)](https://developer.dji.com/doc/cloud-api-tutorial/cn/feature-set/pilot-feature-set/pilot-access-to-cloud.html)
- [Source code deployment steps (license and Pilot login)](https://developer.dji.com/doc/cloud-api-tutorial/en/quick-start/source-code-deployment-steps.html)
- [Cloud API demo end-of-maintenance notice (Chinese)](https://developer.dji.com/doc/cloud-api-tutorial/cn)
- [Cloud API 2](https://developer.dji.com/cloud-api-2)
- DJI developer forum: [RTSP start via MQTT](https://sdk-forum.dji.net/hc/en-us/community/posts/35478215516057-Missing-RTSP-Livestream-Start-Feature-via-MQTT), [streaming with SRS](https://sdk-forum.dji.net/hc/zh-cn/community/posts/38872975988377-Cloud-Api-Streaming-issue), [no query interface](https://sdk-forum.dji.net/hc/en-us/community/posts/24798060361241-Retrieving-serious-low-battery-warning-threshold-and-low-battery-warning-threshold-via-Cloud-API), [Mobile SDK live streaming](https://sdk-forum.dji.net/hc/en-us/articles/6663305630105/comments/29818306830233), [video\_id source](https://sdk-forum.dji.net/hc/en-us/community/posts/45227633547033/comments/45257553836825)
