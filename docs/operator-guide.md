# Operator guide — from drone to dashboard

This is the plain-language guide: what each piece is, what you need before the first
flight, how a drone gets added, and how to use the dashboard. For server installation see
[`README.md`](../README.md); for firmware, certificates and field tests see
[`hardware-bring-up.md`](./hardware-bring-up.md).

---

## 1. The pieces

```
Drone       ── radio ──  RC Plus 2 Enterprise  ── internet ──  our server  ──  browser
                            └─ DJI Pilot 2 runs here              (the app)      (the dashboard)
```

| Piece | What it is | Where it runs |
| --- | --- | --- |
| **Drone** | The drone, with its camera and sensors | In the air |
| **RC Plus 2 Enterprise** | The controller: a screen with joysticks | In the drone operator's hands |
| **DJI Pilot 2** | DJI's flight app: fly, camera, settings | Installed on the controller |
| **Our `/pilot` page** | The registration page Pilot 2 loads | Hosted by us, shown inside Pilot 2 |
| **Our dashboard** | Map, live wall and telemetry | Any normal browser |
| **The server** | Backend, MQTT broker, database, video server | A public VM |

Two rules worth remembering:

1. **The drone never talks to our server.** The controller does it on the drone's
   behalf. One controller is one gateway, so each drone needs its own controller.
2. **There is no general web browser on the controller.** Pilot 2 has a built-in web view;
   that is where our page opens.

---

## 2. Three accounts, three different jobs

| Account | Where you create or use it | Who uses it | What it is for |
| --- | --- | --- | --- |
| **DJI developer account** | developer.dji.com | You, once | Creating the Cloud API app: App ID, App Key, App License |
| **DJI account on the RC** | Pilot 2 on the controller | The drone operator | Controller/drone activation and firmware updates |
| **Our platform account** | Created by a developer or admin in the dashboard | Drone operator and ops team | Logging into `/pilot` and the dashboard |

They are independent. The RC's DJI account is never seen by our server. The developer
credentials are what our server uses to prove to Pilot 2 that we are a licensed platform.

Create the first developer account on the server with `npm run admin` (stop the API first when
using embedded PGlite). Sign in and use **Users and permissions** to create admins, users
or drone operators, set their passwords and assign actions for all or selected drones. The password an
admin sets works as it is, on the dashboard and on Pilot 2; users may change their own later. A
drone operator's access is fixed (see and bind every drone).

```bash
pnpm --filter @dji/api admin
```

- `developer` — the vendor; everything, and the only role that creates admins.
- `admin` — everything, including user management and controller approval.
- `subadmin` — exactly the permissions and drones an admin gives (for example: watch the map
  and video).
- `pilot` — the account typed into `/pilot` on the controller. Only drone operator accounts may bind a
  controller.

The first time a controller signs in it appears in the fleet rail under **Awaiting approval**.
Until an admin approves it, the controller holds no MQTT credentials and reports nothing.

See [account setup and the complete permission list](access-control.md).

### Two-step sign-in

Any account except a Drone operator can add a second check to its sign-in: a 6-digit code from **Google Authenticator** (or any
authenticator app) on the person's phone, so a stolen password alone opens nothing. It works without internet.

1. Open the padlock (**Email / password** on your row of **Users and permissions**) → **Two-step sign-in → Set up**.
2. Enter your password, scan the picture with the app (or type the key under it), enter the first 6-digit code.
3. **Keep the 10 recovery codes**, not on the same phone. Each signs you in once if the phone is lost. They are shown
   only once; **New recovery codes** makes a fresh set and cancels the old.
4. From then on, signing in asks for the password and then the code (**Use a recovery code** is under the box).
   A code works once, and five wrong ones in a row lock the second step for five minutes.

If your organisation requires it, you see only the set-up screen after signing in until you finish it, and you cannot
turn it off. **Lost phone:** ask an administrator to press **Reset 2FA** on your row (you sign in with just your password
and set it up again); the Developer of a server with no other Developer uses the server console (`mfa-reset`).
Accounts with it on show **2FA** beside their status.

---

## 3. Before the first flight

- [ ] The server is deployed and reachable at `https://app.example.com`
- [ ] The DJI App ID, App Key and License are in the server environment
- [ ] At least one `pilot` platform account exists
- [ ] An admin is available to approve the controller on first sign-in
- [ ] The controller is logged into a DJI account
- [ ] Pilot 2 and the drone firmware are up to date
- [ ] The controller has internet (SIM card or Wi-Fi)
- [ ] The drone is linked to that controller

Firmware and account checks are detailed in sections 2 and 3 of
[`hardware-bring-up.md`](./hardware-bring-up.md).

---

## 4. How a drone is added

You do **not** type a serial number anywhere. The controller registers itself and reports
its drone.

1. Power on the controller and the drone.
2. Make sure the controller has internet.
3. In Pilot 2, open **Cloud Services** (some versions call it *Cloud Platform*).
4. Enter the full address:

   ```
   https://app.example.com/pilot
   ```

5. The page verifies our licence, then asks for an email and password. Use an **our
   platform** account, not the DJI account.
6. Watch the six steps turn green: Licence, Login, API module, MQTT, Workspace, Live
   streaming. The page ends at **Connected**.
7. Open the dashboard. The drone appears in the fleet list and on the map within a few
   seconds.

Behind the scenes Pilot 2 publishes a topology message naming the controller and its
drone; the backend creates or updates the device. That message *is* the add.

### Adding another drone

Repeat the same steps with the second controller. No server change is needed. Each drone
gets its own row, marker and video tile.

---

## 5. The controller page

The page is not a browsing experience. It has one job: connect the controller to our cloud.

- It only works **inside Pilot 2**. Opened in a normal browser it shows a notice saying the
  Pilot bridge is missing.
- It does not replace Pilot 2's flight screen. The drone operator still flies with Pilot 2 as usual.
- If the licence step fails, nothing else can succeed. Check the three DJI values on the
  server first.
- If the MQTT step fails, check that the controller has internet and that the broker
  hostname and port are reachable.

---

## 6. The dashboard

Sign in at `https://app.example.com` with a platform account.

### Header

- **LIVE / RECONNECTING** — the live connection to the server.
- **X / Y online** — drones currently reporting.
- Your email and **Sign out**.

### Sidebar — the fleet

- Search box: filters by display name, label (nickname), serial number or model.
- One row per drone: name, serial suffix, altitude, speed, battery, online dot.
- Admins see a pencil (✎) on hover to rename the drone. Names are saved and survive
  reconnects and restarts.
- Battery bar turns red below 25%.

### Map tab

- One marker per drone. The selected marker is pink; the others blue.
- The selected drone's last ten minutes are drawn as a trail.
- Clicking a marker opens a details card with **View live**. Under the battery it shows how
  long the drone can still fly ("35 min left"). That figure is the drone's own estimate, so it
  moves with how it is flown and can change by a minute or two. It reads "time left —" while the
  drone is on the ground, or if its model does not report it. The full-screen view shows the
  same figure as **Time left**.
- **View live** opens that drone full screen. Opening a feed asks the server to start it
  if it is not already running.

### Recordings tab

- **Two ways to record a live drone, kept apart.** On a Live wall tile, **REC** records on the **server**
  and the laptop button beside it records **on this computer**. In the full-screen view they are
  **Record to server** and **On this computer**, beside **Capture**. A server recording keeps a copy of the
  drone's live video on the server: it carries on if you close the tab, and everyone allowed to see
  recordings can find it afterwards under Recordings. **On this computer** saves a file on your own computer
  and uploads nothing. While either is running its button stays on screen with the running time (the server
  one says SERVER); press it again to stop. A drone set to record automatically shows AUTO and is stopped
  under Recordings.
- A recording is one video file with no time limit: it runs until the drone is switched off or its
  stream stops, however long that is. It appears in the **Recordings** list once it is finished. If
  the link drops, the part already recorded is kept, and when the feed returns the recording carries
  on in a new file. It stops when you press
  **Stop server rec** (or **Stop** on the red strip at the top of the Recordings tab), or when the
  feed has been gone for five minutes.
- The **Recordings** tab lists the clips, newest first. Filter by drone and by a date and time
  range (a clip is shown if any part of it falls in the range). **Play** opens the player with the
  usual controls and a speed choice (0.5× to 4×); when a clip ends the next clip of the same
  recording starts by itself. **Download** saves the clip as a normal MP4 file named with the drone,
  date and time. **Delete** removes the file from the server for good, and needs its own right.
- **Tags and a note on every video.** Open a video (press its picture, or **Play**) and under it you find **Tags**
  and **Note**. Type a tag and press **Enter** (or type a comma) to add it; the **x** on a tag removes it; tags are
  saved at once. Write a note and press **Save note**. A tag is a short word or phrase (up to 30 letters, any
  language, up to 20 tags a video), the same word in capitals or small letters counts as one. Tags show on the
  video's card and in the list, and pressing a tag shows every video with it. **Search** (the Name box) finds a
  video by its name, folder, **tag or note**, and the **Tag** filter lists the tags in use with how many videos each
  has. Everyone who can see a video reads its tags and note; whoever may record on its drone (or, for an upload,
  upload) can change them, and each change is in the Audit log.
- **Upload video** (top right, for accounts with the right) keeps a video recorded elsewhere here: a
  file from your own computer goes up to the server and is saved in its main folder, inside the folder you
  name. Choose the file (or drop it on the box), give it a **name**, and type the **folder** it should go
  in. Pick an existing folder from the list, or type a new name: a folder that does not exist yet is
  created when the video is saved, and it stays. You can also say which drone it came from. The file
  goes up as it is, and the server then makes it playable in a browser: a card shows "Making it ready"
  until it is done (MP4 from a phone or camera takes seconds; a format a browser cannot play, such as
  H.265, is converted and can take as long as the video itself). Uploads belong to your own team: no
  other customer sees them. The largest file is set by the installation (4 GB unless changed).
- Videos show as a **grid** of thumbnails, like the screenshots, or as a **list**: the **Grid / List**
  buttons switch and the choice is remembered. Filter by **folder**, drone, **kind** (recorded from
  drones or uploaded), a word in the **name**, and a date and time range.
- **Where the videos are kept.** The server keeps them in one main folder on its own disk (the install
  sets where it starts). A **Developer** sees it in the Automatic recording box as **Videos are saved in** and
  presses **Change folder**: the picker shows the _server's_ storage areas and folders (not your computer's),
  you open folders, make a **New folder** and press **Use this folder**. Recordings in progress carry on in
  the new folder. Videos already saved stay where they are and keep playing; new ones go to the new folder.
  Other accounts do not see the path.
- **After you upload a video** the list shows it at once: any search or filter that would hide it is
  cleared, the list is ordered by **Recently added** so it is first, and a green line says where it went. The
  page also looks again by itself every 20 seconds, and **Refresh** does it now. **Order** lets you sort by when
  the footage was recorded (newest or oldest first) or by when it was added.
- **Automatic recording** is the small box above the videos (for accounts that may record). **Choose the drones
  that record automatically** opens the list: switch a drone on and the server records it **all the time**, from
  the moment it connects, with nobody at a screen and nothing to press; **Turn on for all** and **Turn off for
  all** do the whole list. Each stretch is one video file with no time limit, named with the drone, date and
  time, marked **Automatic**. It runs until the drone is switched off or loses its link, and then shows in the
  list; when the drone is back, even a week later, the recording carries on in a new file. A drone parked on the
  ground is recorded too.
- **Deleting videos.** Each video has its own **Delete** button. To delete many at once press **Select** (next to
  Refresh): tick the videos (a tick box on each card, or in the first column of the list), or press **Select all N
  shown**, then **Delete selected** and confirm. The files are removed from the server for good. A video that is
  still being made ready cannot be ticked, and anything your account may not delete is skipped and counted in the
  green line that follows. The audit log records who deleted which videos.
- It cleans up after itself so the server never fills: automatic clips older than the retention (30 days unless
  the installation says otherwise) are deleted, and if the disk gets short (less than 20 GB free) the oldest
  automatic clips go first. If nothing is left to delete, a red strip says **Recording is paused**, and it
  starts again by itself when there is room. A recording you started by hand and a video you uploaded are never
  deleted automatically.
- A recording uses disk on the server (about 2 GB an hour for each drone at 4 Mbps; 12 drones recording all day is
  about 0.5 TB a day). Recordings and uploads are not part of the nightly backup.

### Audit log tab

For accounts with the **audit** right (an Admin has it; a Developer sees everything, anyone else only their own
team's lines). It answers who did what, to what, when, from where, and how it ended.

- **What is recorded.** Every sign-in (and every wrong password, with the address it came from), sign-out,
  password and email change; every account created, changed (which rights were gained or lost, role, disabled,
  password reset) or deleted; controllers approved, rejected or unbound; drones renamed, paused, deleted;
  live feeds opened, stopped and resumed; screenshots captured, downloaded and deleted; recordings started,
  stopped, uploaded, played, downloaded and deleted; the folder videos are kept in; zones drawn, changed and
  deleted; alerts acknowledged; and what the **server console** did (accounts and controllers made from the
  command line). A request that was **refused** (no right for it) or that **failed** is recorded too, as
  _Refused_ or _Failed_. A password is never written down.
- **Reading it.** Newest first. Filter by **account** (its actions *and* what was done to it), by **what**
  (accounts, recordings, sign-in...), by **result**, by a date and time range, or by any word (a name, an
  address). **Details** shows the changes in words, the browser, the event number and the raw record.
- **From the Users screen**, **Activity** on an account opens the log for that account only, and **Last
  sign-in** shows when it last signed in.
- **Export.** **Export CSV** (opens in a spreadsheet; anything that would run as a formula is stored as plain
  text) and **JSON** download the events on the screen's filter, oldest first, with the chain's head hash. Each
  export is itself recorded in the log.
- **Integrity.** Lines are never edited, and each line carries a hash of the line before it, so a changed or missing
  line can be found. The screen has no button for it; the check is the API `GET /api/audit/verify` (it says whether the
  chain is whole and how many lines were deleted on purpose). Keep the head figure from an export somewhere else (a
  printed page, a mail to yourself) so a later check can be compared with it.
- **What the platform operator does is not shown to a customer.** An Admin sees the lines of its own team. What a
  Developer (the vendor's own account) did, even to that team's accounts, is left out, in the screen, the
  filters, the search and the exports.
- **Deleting lines (Developer only).** Press **Select**, tick the lines (or **Select all N shown**, or **Select
  all N that match** the filter) and **Delete selected**. The lines are removed from every screen and export and
  what they said (who, what, where from) is erased; their place in the chain is kept so the check still works. A
  note that lines were deleted (how many, when, by whom) is written to the log, seen by Developers only, and
  cannot be deleted itself. Nobody else can delete lines.
- **Kept.** The server never deletes lines by itself. Archive old months by exporting them.

### Live wall tab

- One tile per online drone in the chosen layout.
- Opening the tab starts the visible feeds automatically. Other viewers share the same
  stream; closing your tab does not stop it while someone else is watching, and otherwise
  it stops about a minute after the last viewer leaves.
- Each tile shows the video, a `LIVE` / `CONNECTING` / `RECONNECTING` / `ERROR` badge, the
  name, battery, altitude and speed. Viewers have no start/stop controls; a failed feed
  offers **Retry**.
- Clicking a tile opens that drone **full screen**. **Back** or **Esc** returns. The
  tile pauses its own player while the full screen is open.
- In full screen: telemetry strip and the quality selector for administrators. Viewers
  cannot stop a stream or change quality for everyone.
- Administrators get **Stop for everyone** on a running tile and **Resume** on a stopped
  one.

### What online and offline mean

Online means the controller is connected and reporting. If the controller loses internet
or Pilot 2 closes, the drone turns grey after the topology message or the 45-second
silence timeout. It returns automatically when the controller reconnects.

---

## 7. Troubleshooting

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| `/pilot` will not load on the RC | Certificate not trusted, no internet, wrong URL | Use the full `/pilot` URL; try the CA test in the hardware guide |
| Page says "must be opened from Pilot 2" | Opened in a browser | Use Pilot 2 → Cloud Services |
| Licence step fails | Wrong/missing App ID, Key or License | Server `.env`, activation email completed |
| Login fails | Wrong account or password | Create/reset with `user:create` |
| MQTT step fails | Broker unreachable or credentials rejected | Controller internet; `MQTT_PUBLIC_HOST`; `/api/health` shows `mqtt: true` |
| Connected, but no drones on the map | Topology not received | Drone linked to the controller; ask an admin to check recent MQTT messages |
| Drone online, tile stuck at "Waiting for video" | Media server or camera not pushing | SRS/MediaMTX running; RTMP port 1935; `live_capacity` reported |
| Tile shows `ERROR` | The command was rejected | Hover the error text; check server logs |
| Search finds nothing | Name not saved, or filter still active | Press × in the search box; rename again |
| No pencil next to a name | Account is not admin | Sign in with an admin account |

---

## 8. Removing or retiring a drone

Users with `drones.delete` can use **Delete** beside a drone. It disappears from the
fleet and stops telemetry/video; all prior samples, logs, events and screenshots remain.
Ordinary controller reconnects do not restore it. On the original Pilot 2 controller,
sign in with binding permission, use **Rebind a deleted drone** and enter the drone
serial. Reconnect the drone to resume. See [delete and rebind](access-control.md#delete-and-rebind).

---

## 9. Glossary

| Term | Meaning |
| --- | --- |
| **Drone** | The flying unit itself (DJI's documents call it an "aircraft") |
| **RC / controller** | The RC Plus 2 Enterprise |
| **Gateway** | The controller, from the cloud's point of view |
| **Pilot 2** | DJI's flight app on the controller |
| **Cloud API** | DJI's protocol for connecting Pilot 2 to a third-party cloud |
| **Cloud Services** | The Pilot 2 menu where our platform URL is entered |
| **MQTT** | The message channel Pilot 2 uses to send telemetry and receive commands |
| **RTMP** | The video protocol Pilot 2 uses to push the camera to our server |
| **WHEP / WebRTC** | The protocol the browser uses to play that video with low latency |
| **Display name** | The human-friendly name you give a drone in the dashboard |
| **Label** | An optional nickname shown beside the name, for example *Drone 1 · Fire-1*; set on the Drones screen |
| **Workspace** | A DJI bookkeeping identifier; there is only one in this deployment |

---

## 10. Where to read more

- [`README.md`](../README.md) — running, configuration, deployment.
- [`deployment.md`](./deployment.md) — the production runbook: host, TLS, first boot,
  verification, backups and upgrades.
- [`hardware-bring-up.md`](./hardware-bring-up.md) — firmware, certificates, first
  registration, field tests, video measurements.
- [`../CLAUDE.md`](../CLAUDE.md) — how the code is organised, for developers and AI agents.
- [`poc-plan.md`](./poc-plan.md)
  — the original scope and acceptance criteria.
