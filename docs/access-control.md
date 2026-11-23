# Users, drone access, deletion and adaptive video

## First developer account

The API migrates the database automatically but no longer creates an account from
`ADMIN_EMAIL` / `ADMIN_PASSWORD`. On the server, run:

```bash
pnpm install
npm run admin
```

The script asks for an email, a hidden password and confirmation. It creates a
`developer` (the vendor's own account) directly in the configured database; no credentials are printed or passed
as command arguments. Passwords must contain 8–128 characters. Use a new email: the
script refuses to replace an existing account. It never stops active streams.

For host development, run this **before** `pnpm dev`. If using embedded PGlite, stop
the API before any CLI command: only one process may open that database. In Docker:

```bash
# Production (Postgres allows the API to stay running)
docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml exec api npm run admin
# Docker development
docker compose -f infra/docker-compose.dev.yml exec api npm run admin
```

An existing installation keeps its accounts and grants on migration. Existing admins
remain admins; `superadmin` accounts become `developer` and `user`/`viewer` accounts become
`subadmin` at start-up. Create a developer with the script to manage admins. Legacy
controller credentials are revoked during migration; sign in again in Pilot 2 to issue
credentials associated with the current account.

## Admin panel and permissions

Sign in and select **Users and permissions**. A developer can create admins, sub-admins and
drone operators; an admin can create sub-admins and drone operators. See [on-premise.md](on-premise.md) for who
does what when the product is installed for a customer. Each new account has the password chosen
in the panel, and that password works as it is: nothing forces a change. A user changes their own
sign-in email (needs the current password; no session is ended, so a drone operator's controller stays
connected) and password from the padlock in the left panel (the new one must differ from the old); doing so ends
their other sessions. A reset in the panel ends the account's sessions and the new password works
right away. Passwords are stored only as Argon2id hashes, so nobody, a developer included, can
read an existing password: a forgotten one is replaced with a reset. (`must_change_password`
remains in the schema as a manual safeguard; no screen or route sets it, and start-up clears it.)

Roles identify an account; explicit grants control access. A developer has all
access. The panel starts new accounts with no grants. The permissions are:

| Permission | Capability |
| --- | --- |
| `users.manage` | List, create, disable, delete and update permitted accounts, reset passwords; the Users screen |
| `inventory.manage` | The Controllers and drones screen: see and approve the team's own controllers and drones |
| `map.view` | The Operations map screen (hides the screen only; positions need `telemetry.view`) |
| `wall.view` | The Live wall screen (the video itself needs `streams.view`) |
| `shots.view` | The Screenshots screen; its data is closed with it (the pictures need `screenshots.view`) |
| `recs.view` | The **Recordings** screen; its data is closed with it (the videos need `recordings.view`). The Live wall's REC buttons still know what is recording without it |
| `history.view` | The Flight history screen; its data is closed with it (the flights need `flights.view`) |
| `fleet.view` | The Drones screen (names, colours, status, drone operators) |
| `zones.view` | Read no-fly zones and geofences (the built-in ones and the team's own) |
| `alerts.view` | The Alerts screen and acknowledging alerts, for the drones the account can see |
| `drones.view` | See aircraft and identity/camera status |
| `drones.rename` | Rename an aircraft |
| `drones.delete` | Delete an aircraft while retaining its history |
| `drones.bind` | Register a controller and bind/rebind an aircraft in Pilot 2 |
| `telemetry.view` | Read live telemetry, history and trails |
| `streams.view` | Watch video, create playback sessions, report connection quality |
| `streams.control` | Stop/resume video and set quality or lens |
| `screenshots.view` | List, open and download stored frames |
| `screenshots.capture` | Upload a frame captured from a live feed; record a feed on this computer |
| `screenshots.delete` | Delete stored frames for good (row, people count and file); an Admin has it, others are given it |
| `recordings.view` | Watch and download the videos of a drone (recorded on the server or uploaded for it) |
| `recordings.record` | Start and stop a server recording; switch a drone's automatic recording on or off |
| `recordings.delete` | Delete videos for good, one or many |
| `recordings.upload` | Upload video files into the archive, into folders; account-wide |
| `zones.manage` | Draw, edit and delete no-fly zones and geofences |
| `flights.view` | Open the flight history |
| `system.debug` | Read the fleet-wide MQTT debug log (requires all-aircraft scope) |
| `api.manage` | Open **API access**: make and revoke read-only API tokens for the customer's own programs (see [api.md](api.md)). A token can never be wider than the account that made it, and a Developer cannot make one (a customer's Admin does). An Admin has it; others are given it. Account-wide. |
| `audit.view` | Open the **Audit log**, filter it, export it (CSV or JSON); the integrity check is the API `/api/audit/verify`. An Admin has it; others are given it. A reader sees their own team's lines, without anything a Developer did; a Developer sees every line and is the only one who may delete lines. Account-wide. |

For all-aircraft scope, checked global permissions apply to every current and future
aircraft. With per-aircraft scope, each serial has its own independent grants;
`drones.view` plus the requested action are required for that aircraft. Unlisted aircraft
are hidden. Account-wide permissions (`users.manage`, `inventory.manage`, the screens `map.view`, `wall.view`, `shots.view`,
`recs.view`, `history.view`, `fleet.view`, `zones.view`, `alerts.view`, `audit.view`, `api.manage`, and `zones.manage`,
`recordings.upload`, `system.debug`) are never granted through a drone override. In the user form every screen in the
menu is one switch under **Screens**. Historical aircraft serials can be added manually to the form.

**Whose accounts you see.** Every admin is its own customer. An admin, and the sub-admins who
work for it, see and manage only the sub-admins and drone operators that belong to that admin; another
admin's accounts do not exist for them (they are missing from the list and answer "not found").
A developer sees every account, grouped by admin, with who created each. A new sub-admin or drone operator
belongs to the admin that made it; a developer chooses the admin in the form, or none (then only
developers see the account). An admin that still has accounts cannot be deleted or demoted. Only
accounts are separated: aircraft, controllers, screenshots, zones and flights are shared by every
admin on the installation.

An admin, or a sub-admin with `users.manage`, can create and edit sub-admins and drone operators with any
subset of their own access, `users.manage` included, but never beyond their own scope and never
the admin role. A drone operator's access is fixed (`drones.view` and `drones.bind` on every aircraft).
Only a developer manages admin
accounts. No account can edit itself through the panel or edit a developer; server CLI
password recovery remains available. Disabling or changing access invalidates that user's
sessions, disconnects dashboard sockets and closes their media sessions.

Every protected API request reloads account state from the database, checks session
version, first-login state and resource permission. New API routes default to denied
until a permission rule is added to `src/http/access.ts`. List endpoints filter results;
individual resource endpoints check their actual drone, including screenshot files and
playback sessions. Live messages and watches apply the same rules. Active sockets and playback sessions independently
recheck account state every two seconds for CLI changes and expiry. The full
screenshot picture uses `private, no-store` so permission changes cannot be bypassed by a cached API response. The small
gallery copy of a still (640 px, a few dozen kB) may be kept by the signed-in browser for an hour (`private, max-age=3600`,
never by a shared cache) so the gallery and viewer are fast; it follows the same per-drone rights.

## Two-step sign-in

Any account but a Drone operator can turn on a time-based one-time code (RFC 6238; Google Authenticator and every other
authenticator app) as a second step of the dashboard sign-in. `MFA_REQUIRED_ROLES` (developer, admin, subadmin) makes it
compulsory for a role: such an account is held at the set-up screen (every other route answers
`403 mfa_enrolment_required`, as with a forced password change) until it is on, and cannot turn it off. A Drone operator is
exempt: its sign-in is on a controller, which an Admin must approve. Whoever may edit an account (`users.manage`, within
the same customer; a Developer for any but its own) can reset its two-step sign-in; a reset ends the account's sessions.
Setting it up, turning it off and making recovery codes need the password again; five wrong codes lock the second step
for five minutes; a code works once.

## Disable, delete and rebind

There are two ways to take an aircraft out of service, and they differ in **who can put it
back**.

### Disable — a reversible pause

Admins will find this under **Controllers and aircraft** (`/inventory/aircraft`). The
account needs `drones.delete` for that serial. Disabling sets `devices.disabled_at`, hides
the aircraft from the map, wall, fleet list and search, stops its streams and closes playback
sessions. Telemetry, camera-capacity and command topics for that aircraft are refused **at
the broker** (`mqtt-auth.ts`), so its controller cannot publish for it at all; the
controller's own topics stay open, because announcing topology is how the aircraft comes
back.

An admin re-enables it at any time, with no controller involved. It reappears offline and
comes online when it next reports.

Use this for maintenance, grounding or end of mission.

### Delete — the aircraft is gone

Use **Delete** beside an aircraft. The account needs `drones.delete` for that serial.
Deletion records `devices.deleted_at` and an audit event, and behaves like a disable, with
one deliberate difference: **only the original controller can undo it.**

Its device row, name, telemetry, stream history, MQTT log, events, screenshots and image
files remain. Authorized users can still read historical telemetry by serial and screenshots
through the gallery/API.

Ordinary topology, telemetry, camera-capacity messages and old stream keys cannot
restore a deleted drone. New telemetry is discarded and MQTT aircraft topics are denied.
Other aircraft connected to the same controller continue operating.

To reconnect, sign in on the original controller's `/pilot` page with `drones.bind`
access to that aircraft, use **Rebind a deleted aircraft**, enter its aircraft serial,
then reconnect the aircraft in Pilot 2. This calls `POST /api/pilot/bind` with
`{ "deviceSn": "<aircraft serial>" }` using a controller-bound bearer token. A normal
startup bind with no aircraft serial does not restore anything. Rebinding requires the
stored controller relationship, clears the deletion marker and records an audit event;
it leaves the aircraft offline until fresh telemetry/topology arrives. Retained data is
never purged by either operation.

There is **no admin restore button, by design.** Holding the aircraft's own controller is
the only proof it is physically in your custody, which is exactly what matters when a drone
was deleted because it was lost or stolen. An admin override would remove that proof.

Use delete for a lost, stolen or retired aircraft — not for maintenance.

### Seeing the inventory

**Controllers and aircraft** (its own menu, next to **Users and permissions**) has two tabs,
each with its own address (`/inventory/controllers`, `/inventory/aircraft`):

- **Controllers** — every RC that has ever contacted the server, by status (`pending`,
  `approved`, `rejected`), with its aircraft, when it asked and who decided. Approve, reject
  and unbind from here; the rail's "Awaiting approval" block only ever shows the pending
  ones.
- **Aircraft** — active, disabled and deleted in separate sections. Disabled rows have an
  enable/disable button; deleted rows say "Restore from the controller" and have none.

`GET /api/admin/devices` backs the aircraft tab and returns every row, including hidden
ones. Both endpoints need `inventory.manage`, and both show only what the account's team owns or may
see (a Developer sees everything): another customer's controllers answer 404.

## Adaptive streaming

Each active player reports its concurrent player count, interval RTP packet loss and
decode stalls every ten seconds, plus an explicit low-data signal (data saver or 2G) when
the browser gives one. A prolonged
stall also reports congestion before reconnecting. Reports require a playback session
owned by that user, plus `streams.view` for the stream's aircraft; the caller cannot
supply an arbitrary quality command.

A low-data signal budgets 65% of 0.5 Mbps across the visible players and maps that to
DJI's Smooth / SD / HD / UHD bitrate ladder. The browser's own `downlink` estimate is not
used: it is measured on HTTP transfers, not on the video, and on 2026-10-30 it held healthy
walls at Smooth. At 5% packet loss or a stall a stream steps down one level, but only when
the same viewer reports trouble twice in a row (about 20 seconds), never on a single blip.
For 30 seconds after any quality change and after the controller (re)starts its push,
reports are not counted at all: the controller is re-encoding and the player is waiting
for a keyframe, and acting on that is what made streams step down and up every minute.
Reports from different viewers are combined conservatively: the weakest active viewer
constrains the shared stream. Reports expire after 30 seconds. Recovery requires two
minutes of healthy feedback and rises one level at a time, up to the last manually chosen
ceiling (initially SD). Every automatic change is logged as `[adaptive] id=… quality a -> b`.
Manual quality 0 (Auto) delegates adaptation to DJI and disables server-driven changes.

Quality changes use `live_set_quality`; storage and broadcasts update only after the
controller accepts the command. A browser's Network Information API is an estimate and
is not available in every browser. RTP feedback remains usable without it. This does
not directly measure the RC's Wi-Fi upload speed, and cannot create spare bandwidth
below DJI's minimum bitrate. Video is shared per aircraft, so a quality change affects
all its viewers. Real Pilot 2 hardware should be checked under a throttled connection.

References: [DJI Pilot live streaming service](https://developer.dji.com/doc/cloud-api-tutorial/en/api-reference/pilot-to-cloud/mqtt/others/rc/live.html),
[WebRTC statistics specification](https://www.w3.org/TR/webrtc-stats/).

## Checks

```bash
pnpm --filter @dji/api test
pnpm typecheck
pnpm lint
pnpm build
CHROME_PATH=/usr/bin/google-chrome pnpm test:rbac:ui
```

The integration tests use in-memory PGlite and injected HTTP/WebSocket clients. They
exercise the password rules, permission and scope isolation, account management,
revocation, retained drone history and explicit RC rebind. Adaptive quality tests use a
controlled clock to verify the low-data budget, the settle window, the two-report rule,
weakest-viewer behavior, report expiry and slow recovery.

The browser check starts isolated loopback servers with an in-memory database, then tests
user creation, per-drone grant persistence, password replacement and restricted navigation.
Screenshots are saved under `.data/screenshots/rbac/`. No existing database is opened.
