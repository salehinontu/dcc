# Installing Drone Fleet on a customer's server

The repeatable way to put the system on a customer's own server, hand it over, and keep it running. Every install goes
through the same steps and the same scripts, so nothing depends on memory. For the background (what each part of the
stack does, ports, DNS, TLS in depth) see [deployment.md](deployment.md); for branding and roles see
[on-premise.md](on-premise.md).

## The kit

| Script | Where it runs | What it does |
| --- | --- | --- |
| `deploy/release.sh` | your machine | Packs `releases/drone-fleet-<version>.tar.gz` and its SHA-256. `--with-images` adds the built images for a server without internet (needs Docker where you run it). Internal papers and settings are never included. |
| `deploy/install.sh` | the server | `--check` lists what is missing and changes nothing. Without it: settings with fresh secrets, certificate, start, first Developer account, nightly backup, health check every 5 minutes, optional firewall. Safe to run again. |
| `deploy/healthcheck.sh` | the server | Services, API and MQTT, disks, certificate, backups, clock. `--cron` alerts a webhook when the state changes. |
| `infra/backup.sh` | the server (as `/usr/local/bin/drone-fleet-backup`) | Nightly: database, screenshots, settings and certificates, checked, kept 14 days, copied to `BACKUP_TARGET`. |
| `deploy/restore.sh` | the server | `--verify` restores a backup into a scratch database and counts it (the live one is untouched); `--restore` brings a backup back. |
| `deploy/upgrade.sh` | the server | Snapshot, new code, build, database change tried on a copy, Nginx tested, switch, checks; rolls back by itself if the new version is not healthy. |
| `deploy/rollback.sh` | the server | The version before an upgrade, from its snapshot (code and images; `--with-database` too). |
| `deploy/support-bundle.sh` | the server | One file with versions, states, health and recent logs, secrets blanked, to send to support. |

Operations settings live in `/etc/default/drone-fleet` (written by the installer): `BACKUP_TARGET`, `BACKUP_RECORDINGS`,
`KEEP_DAYS`, `ALERT_WEBHOOK_URL`. The application's settings stay in `infra/.env.production`.

## 1. Before the visit: site survey

Send this to the customer's IT a week before. Every "no" or "don't know" is a problem found early instead of on the day.

- **Server:** Ubuntu 22.04/24.04 or Debian 12, 64-bit; 4+ CPU cores, 8+ GB memory (16 GB with people counting busy);
  40 GB for the system plus the video disk (about 2 GB an hour per drone at 4 Mbps; 30 days of 12 drones is about
  16 TB). Root or sudo for you.
- **Docker** Engine and the Compose plugin installed, starting at boot (or permission to install them).
- **Network:** is the server on the internet, on a private LAN, or both? Can the controllers (RC Plus 2, by Wi-Fi or SIM)
  reach it? A private APN or VPN for the controllers is the most secure layout.
- **Ports** the server must receive: 443 (dashboard), 8883 (MQTT for controllers), 1935 (RTMP video in), 8000/udp
  (live video to browsers), 80 (certificate renewal and redirect), 1936 (RTMPS, optional).
- **Name and certificate:** a DNS name (e.g. `drones.customer.gov`); a certificate from their CA, or Let's Encrypt if the
  name is public. A self-signed certificate works only on a closed LAN and DJI Pilot 2 may refuse it.
- **Clock:** NTP on (two-step sign-in codes and TLS depend on the time).
- **DJI:** a DJI Cloud API app (App ID, App Key, License) from developer.dji.com, one per install.
- **Backups:** where the second copy goes (a NAS folder mounted on the server, or another server over SSH), and whether
  the video archive is copied too.
- **Alerts:** a Slack, Teams, Google Chat or Discord incoming-webhook address for "something is wrong".
- **People:** who is the customer's Admin, which roles must use two-step sign-in (default: everyone but drone operators).
- **Branding:** product name, two colours, a square logo (PNG or SVG, 512 px).
- **Remote access** for updates and support: VPN or SSH, and who approves it.

## 2. Install

On your machine:

```bash
deploy/release.sh                 # or: deploy/release.sh --with-images   (server without internet)
```

Copy `releases/drone-fleet-<version>.tar.gz` and its `.sha256` to the server, then on the server:

```bash
sha256sum -c drone-fleet-<version>.tar.gz.sha256
sudo mkdir -p /opt && sudo tar xzf drone-fleet-<version>.tar.gz -C /opt
sudo mv /opt/drone-fleet-<version> /opt/drone-fleet
cd /opt/drone-fleet
sudo deploy/install.sh --check
```

Fix everything `--check` reports, then install. Three typical layouts:

```bash
# The customer's own certificate
sudo deploy/install.sh --domain drones.customer.gov --developer-email you@vendor.com \
  --cert /root/fullchain.pem --key /root/privkey.pem --brand-name "Acme Sky" --logo /root/logo.png --firewall

# A public name: Let's Encrypt (you accept their terms by asking for it)
sudo deploy/install.sh --domain drones.customer.com --developer-email you@vendor.com --letsencrypt you@vendor.com --firewall

# A closed LAN, for a trial: self-signed
sudo deploy/install.sh --domain drones.lan --public-ip 192.168.10.5 --developer-email you@vendor.com --self-signed
```

Other options: `--public-ip` (the address browsers use for live video; found by itself otherwise), `--mfa-roles`
(default `developer,admin,subadmin`), `--with-ai` (downloads the people-counting model, about 250 MB). The
Developer's password is written once to `/root/drone-fleet-developer.txt` (root only): sign in, change it, and delete the
file. Then set, in `/etc/default/drone-fleet`, `BACKUP_TARGET` and `ALERT_WEBHOOK_URL`.

If the DJI app keys were not known at install, put them in `infra/.env.production` (`DJI_APP_ID`, `DJI_APP_KEY`,
`DJI_APP_LICENSE`) and run `docker compose --env-file infra/.env.production -f infra/docker-compose.prod.yml up -d api`.

## 3. Acceptance test (with the customer present)

Tick each one; the customer signs the sheet. Nothing here is skipped "for now".

| # | Check | How |
| --- | --- | --- |
| 1 | Health is green | `sudo deploy/healthcheck.sh` shows no FAIL |
| 2 | Sign-in with two-step | The Developer signs in, sets up Google Authenticator, signs out and in again with a code |
| 3 | Customer Admin | Created, signs in, sets up two-step sign-in, sees only their screens |
| 4 | Lock-out | Ten wrong passwords lock that account for 15 minutes; an admin's new password unlocks it |
| 5 | Controller | A drone operator signs in on the RC (DJI Pilot 2 → Cloud Services), the Admin approves it, the drone appears |
| 6 | Live video | The drone's feed plays on the Live wall, from a second computer too |
| 7 | Map and telemetry | The drone shows on the map with height, battery, time left |
| 8 | Screenshot and recording | A screenshot is captured; a server recording plays and downloads |
| 9 | Zones and alerts | A no-fly zone is drawn; flying into it raises an alert |
| 10 | Audit log | Steps 2 to 9 appear in the Audit log |
| 11 | Backup and restore | `sudo drone-fleet-backup`, then `sudo deploy/restore.sh --verify`: the counts match the live system |
| 12 | Second copy | The backup files are in `BACKUP_TARGET` |
| 13 | Alert | Stop one service (`docker compose ... stop srs`), wait for the webhook message, start it, wait for "recovered" |
| 14 | Reboot | The server reboots and everything comes back by itself |
| 15 | API access (if the customer will use it) | The Admin makes a token on API access; `curl -H "Authorization: Bearer <token>" https://<server>/api/v1/whoami` answers; a `POST` with it is refused; revoking it makes the same call answer 401 (see [api.md](api.md)) |

## 4. Hand-over

Give the customer, in writing:

- The dashboard address, the Admin account (they set their own password and two-step sign-in), and who to call.
- Where things are: the install `/opt/drone-fleet`, backups `/var/backups/drone-fleet` and `BACKUP_TARGET`, videos
  (`STORAGE_HOST_DIR` and the Docker volume), the operations log `/var/log/drone-fleet.log`.
- The signed acceptance sheet, the version installed (`cat /opt/drone-fleet/VERSION`), the user manual
  ([user-manual.md](user-manual.md)) and the Bengali tutorial ([tutorial-bn.md](tutorial-bn.md)).
- What they must keep safe: `infra/.env.production` and `infra/certs` (in every nightly `config-*.tgz` too). Losing the
  settings means everyone sets up two-step sign-in again and the database password must be reset.

## 5. Running it

**Every day, by itself:** the nightly backup (02:30) and the health check (every 5 minutes, alerts on change, repeated
every 6 hours while a problem lasts). Automatic video clips older than `RECORDING_RETENTION_DAYS` are deleted, and
recording pauses before the disk is full.

**Every month (10 minutes):** `sudo deploy/healthcheck.sh`, `sudo deploy/restore.sh --verify`, a look at disk growth,
and the operating system's security updates (`apt upgrade`, or `unattended-upgrades`).

**An upgrade:** pack the new version with `deploy/release.sh`, copy and unpack it next to the install
(`/opt/drone-fleet-<new version>`), then:

```bash
sudo /opt/drone-fleet-<new version>/deploy/upgrade.sh --app-dir /opt/drone-fleet
```

It takes a snapshot first, tries the database change on a copy of the data, and switches only if everything passes. If
the new version is not healthy after the switch it goes back by itself. Later, by hand:
`sudo /opt/drone-fleet/deploy/rollback.sh` (the newest snapshot; `--list` shows them all).

**Something is wrong:** `sudo deploy/healthcheck.sh`, then `sudo deploy/support-bundle.sh` and send the file it names.

**The server is lost:** on a new server, install the same version with the customer's `config-*.tgz` unpacked into
`infra/` first (so the same secrets and certificate are used), then `sudo deploy/restore.sh --restore <stamp>` with the
backup files copied into `/var/backups/drone-fleet`. Videos come back from `BACKUP_TARGET` if `BACKUP_RECORDINGS=1`.

## 6. Security checklist

Done by the installer: fresh random secrets per install (never copied from another), two-step sign-in compulsory for
dashboard roles, the account lock-out after 10 wrong passwords, sign-in rate limits per visitor, security headers
(HSTS, no framing, no sniffing, a restrictive Permissions-Policy), TLS 1.2/1.3 only, `/internal` closed, the settings
file and backups readable by root only, container logs capped, the firewall (with `--firewall`).

For the customer's IT:

- SSH with keys only, no password logins, `fail2ban`; no shared root password.
- Keep the server on a private network or behind a VPN where they can; open to the internet only 443 (and the
  controller ports if controllers come from outside).
- Turn on the operating system's automatic security updates.
- Keep the second backup copy on another machine, and test a restore every month.
- Review the Audit log and the Users list every month; disable accounts of people who leave.

## 7. Known limits

- Live video to browsers needs UDP 8000 between the browser and the server; there is no TURN fallback for networks that
  block UDP.
- RTMP from the DJI apps is plain (DJI does not document RTMPS); use a private network or VPN for the controller leg if
  the video must be encrypted in transit. MQTT over TLS from DJI Pilot 2 must be proven on the customer's hardware and
  certificate during acceptance (step 5).
- Sign-in through the customer's own identity provider (SSO: Microsoft Entra, Google Workspace, Keycloak) is not
  built; two-step sign-in is.
- The API is one process: one server per installation (enough for dozens of drones; see deployment.md for sizing).
