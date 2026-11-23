# Installing for a customer (on-premise, white-label)

One build of the product serves every customer. Each installation gets its own name, colours
and logo from settings, its own database, and its own accounts. Nothing is shared between
installations, and nothing calls home to the vendor.

**For an actual install, use [client-install.md](client-install.md)**: the scripts in `deploy/` (install, health check,
backup and restore, upgrade with automatic rollback), the site survey, the acceptance test and the hand-over.

This guide is the short path for a new customer. The full server runbook (firewall, TLS,
backups, upgrades, troubleshooting) is [deployment.md](deployment.md); follow it for every
step that says "as in the runbook".

## Who does what

| Role | Who | Can do |
| --- | --- | --- |
| **Developer** | the vendor (you) | Everything. Created only from the server CLI. The only role that creates **Admins**. |
| **Admin** | the customer's lead | Every feature. Creates **Sub-admins** and **Drone operators** and decides what each Sub-admin may do. |
| **Sub-admin** | the customer's staff | Exactly the permissions the Admin gives (any of the Admin's own, user management included), on all aircraft or on chosen ones. |
| **Drone operator** | the person on the remote | Only signs in on the RC Plus 2 (DJI Pilot 2) to connect a controller. Its access is fixed; there is nothing to choose. |

An Admin never sees or edits Developer accounts, and cannot create another Admin. Ask the vendor
for a second Admin.

## 1. What the customer provides

- A Linux server (Ubuntu 22.04/24.04 or Debian 12) with Docker, **4 vCPU / 8 GB RAM** or more,
  and disk for screenshots (about 1 GB per 2,000 stills). No GPU needed. **Video needs far more
  disk**: see "Where the videos are kept" below.
- A DNS name for the dashboard (for example `drones.customer.com`), and the MQTT and media
  names if they differ.
- A TLS certificate for those names: their own, from their CA, or Let's Encrypt.
- Open ports as in the runbook: 443 (dashboard), 8883 (MQTT for the controllers), 1935 (RTMP
  video from the controllers), 8000/udp (WebRTC video to browsers).
- A **DJI Cloud API** app (App ID, App Key, License) from developer.dji.com. Each installation
  needs one; the controllers check its licence before they connect.
- Their logo (square PNG or SVG, ideally 512 px), product name and two colours.

## 2. Copy the release to the server

```bash
# From your machine: the code, without local data or secrets.
rsync -az --delete \
  --exclude=node_modules --exclude=.git --exclude=.data --exclude=dist --exclude=/.env \
  --exclude=infra/certs --exclude=infra/.env.production \
  ./ root@<server>:/opt/<customer>/
```

## 3. Configure

```bash
cd /opt/<customer>
cp infra/.env.production.example infra/.env.production
```

Fill in `infra/.env.production` as in the runbook (domain, public IP, database and JWT secrets,
EMQX cookie, MQTT and media hosts, DJI app). Then the branding block:

```ini
BRAND_NAME=Acme Sky
BRAND_SUBTITLE=Fleet Control
BRAND_COMPANY=Acme Aviation Ltd
BRAND_TAGLINE=Every flight, in sight
BRAND_PRIMARY_COLOR=#7c3aed
BRAND_ACCENT_COLOR=#10b981
BRAND_LOGO_PATH=/data/branding/logo.png
# Optional: start of screenshot and recording file names (default: the name in capitals)
# BRAND_FILE_PREFIX=ACME-SKY
```

Put the logo in `infra/branding/logo.png` (the compose file mounts that folder read-only). The
name also becomes the platform name Pilot 2 shows on the controller, unless `DJI_PLATFORM_NAME`
is set.

| Setting | Where it shows |
| --- | --- |
| `BRAND_NAME` | Menu, sign-in screen, browser tab, Pilot page, DJI Pilot 2 |
| `BRAND_SUBTITLE` | Under the name in the menu and on the sign-in screen |
| `BRAND_COMPANY` | Sign-in footer: "Copyright © …" |
| `BRAND_TAGLINE` | Sign-in headline |
| `BRAND_PRIMARY_COLOR` | Buttons, links, selection, sign-in panel |
| `BRAND_ACCENT_COLOR` | Active menu bar, selected aircraft, sign-in button |
| `BRAND_LOGO_PATH` | Menu, sign-in screen, Pilot page, browser tab icon |
| `BRAND_FILE_PREFIX` | Screenshot and recording file names |

Red, amber and green keep their meanings (no-fly zone, warning, OK) whatever the brand colours
are, so avoid a pure red as the primary colour.

Put the certificate in `infra/certs/` as in the runbook.

## Where the videos are kept (the main folder)

Recorded and uploaded videos are the one thing that needs a big disk: about **2 GB an hour for each
drone** at 4 Mbps (12 drones recording all day is about 0.5 TB a day). Decide with the customer where
they go, before you start:

1. **Choose a main folder** on the big disk (or a mounted NAS), for example `/srv/drone-fleet/videos`.
   Everything is kept inside it: a folder per drone for what the drones record, and `library/` for
   videos people upload, with the folders they name.
2. **Docker (this guide):** videos start in a Docker volume on the system disk. For a big disk or a NAS,
   mount it on the server (for example at `/mnt/bigdisk`) and tell Docker which host folder to offer, in
   `infra/.env.production`:

   ```bash
   STORAGE_HOST_DIR=/mnt/bigdisk
   ```

   The folder must exist and be writable (the container runs as root); preflight warns if it is missing.
   Inside the app it appears as the storage area **Server storage folder**.
3. **Choose the folder in the app (Developer only).** Open **Recordings**; the **Automatic
   recording** box shows **Videos are saved in …** and a **Change folder** button. The picker lists the
   _server's_ folders (not the computer in front of you): pick a storage area, open folders, make a
   **New folder** (for example `/storage/drone-fleet-videos`), press **Use this folder**. It is remembered
   across restarts, and recordings in progress carry on in the new folder. Videos already saved stay
   where they are and keep playing, and new ones go to the new folder; nothing is copied. On a plain
   server or a Windows machine running the API (no Docker) the picker offers the whole disk, with
   shortcuts to Home and to other disks and drives.
4. Set how long automatic footage is kept and how much disk to leave free (`RECORDING_RETENTION_DAYS`,
   `RECORDING_MAX_GB`, `RECORDING_MIN_FREE_GB` in `.env.production`), and decide whether drones record
   by themselves (`RECORDING_AUTO_DEFAULT=1`). The server deletes only _automatic_ clips, oldest first,
   and pauses recording before the disk fills.
5. **Backups:** the nightly backup does not include videos. Copy the main folder off the server on the
   customer's own schedule.

To bring in a video from a computer, anyone with the right presses **Upload video** on the Recordings
screen, chooses the file, names the folder it should go in (an existing one from the list, or a new
name that is created), and it is saved under the main folder.

## 4. Start and check

```bash
COMPOSE="docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml"
node tools/docker/preflight.mjs --prod
$COMPOSE up -d --build
$COMPOSE exec api pnpm models:fetch      # people counting, once
curl -s https://<domain>/api/health      # {"ok":true,"mqtt":true,"mqttSubscribed":true,...}
curl -s https://<domain>/api/branding    # the customer's name and colours
```

Open `https://<domain>` and check the name, colours and logo on the sign-in screen.

## 5. Accounts

```bash
# Your own Developer account, typed interactively; it never has to change its password.
$COMPOSE exec api npm run admin
```

1. Sign in as the Developer.
2. **Users and permissions → New user**, role **Admin**, the customer's email and a password.
   Give it to the customer. It works as it is; they can change it any time from the padlock.
3. The customer's Admin then creates their **Sub-admins** (choosing their permissions and
   aircraft) and one **Drone operator** account per remote controller.
4. The first time a remote signs in, it waits for approval: **Controllers and aircraft →
   Controllers → Approve** (an Admin or the Developer).

### Two-step sign-in (security)

Every account except a Drone operator can protect its sign-in with a **6-digit code from Google Authenticator** (or Microsoft
Authenticator, Authy, any authenticator app). It needs no internet and no third-party service: the codes are computed
from a secret shared once, by QR code, between the server and the person's phone.

- **Each person switches it on** from the padlock → **Two-step sign-in → Set up**: password, scan the picture, type
  the first code, and keep the **10 recovery codes** shown once (each signs in once if the phone is lost).
- **To make it compulsory**, list the roles in `infra/.env.production` and restart the api container:

  ```bash
  MFA_REQUIRED_ROLES=developer,admin,subadmin
  ```

  A person in one of those roles who has not set it up signs in but sees only the set-up screen until they have.
  They cannot turn it off. A Drone operator is never included: it signs in on the remote controller, where no code can be typed;
  its protection is that a controller must be approved by an Admin before it receives anything.
- **A lost phone:** someone who manages that account opens **Users and permissions** and presses **Reset 2FA** (their
  sessions end; they sign in with the password and set it up again). If nobody is left who can (the only Developer), use
  the server console:

  ```bash
  $COMPOSE exec api pnpm user:mfa-reset -- --email person@example.com
  ```

- **Wrong codes:** five in a row lock that account's second step for five minutes. A code works only once.
- **Secrets are sealed** in the database (AES-256-GCM, key from `JWT_SECRET`, or your own `TOTP_ENCRYPTION_KEY`), so a
  backup alone yields no codes. Keep that key with the rest of the secrets: lose it and everyone sets it up again.
- Every set-up, sign-in with a code, wrong code, turn-off and reset is in the **Audit log** (never the codes).

Sign-in through the customer's own identity provider (Google Workspace, Microsoft Entra, Keycloak, AD FS) is not built;
if the customer needs it, it is a separate piece of work on top of this.

## Several customers on one server

One installation can serve more than one customer: make one **Admin** per customer. Each Admin,
and the Sub-admins who work for it, sees only its own Sub-admins and Drone operators; you (the Developer)
see everyone, grouped by Admin. When you create a Sub-admin or Drone operator yourself, choose **Belongs to
Admin** in the form (from the command line: `--admin <admin email>`).

This separates **accounts** only. Aircraft, controllers, screenshots, zones and flights are shared
by all Admins on the installation. If customers must not see each other's fleet, give each its own
installation (the default in this guide).

## 6. Hand-over checklist

- [ ] Sign-in screen shows the customer's name, logo and colours; the browser tab too
- [ ] Developer and Admin accounts work; the Admin has changed the password you gave them
- [ ] A remote signed in through Pilot 2, was approved, and its aircraft appear on the map
- [ ] Live video plays on the Live wall from a browser outside the server's network
- [ ] Nightly backup installed (`infra/backup.sh`, see the runbook) and copied off the server
- [ ] The videos folder is on the big disk (Recordings screen, as Developer), a test video uploads and plays, and the retention and free-space settings are agreed with the customer
- [ ] `infra/.env.production` and `infra/certs/` stored safely by the customer

## Changing the branding later

Edit the `BRAND_*` lines or replace the logo, then restart the API:

```bash
$COMPOSE up -d api
```

No rebuild is needed. Open browser tabs show the new branding after a reload.
