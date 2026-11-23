# Drone Fleet — User Manual

How to sign in, watch drones, view live video, take screenshots, connect a controller, and
manage accounts.

**Who this is for:** operators, drone operators, and the admin who runs the system. No technical
knowledge is needed. Every place a step happens is marked, because most work happens on a
normal computer but connecting a controller happens on the RC Plus 2 handset.

**Covers:** the build of 2026-10-28, including controller approval, the Controllers and
drone panel, and disable/delete.

---

## Contents

**Getting started**

1. [Before you begin](#1-before-you-begin) — the three kinds of account
2. [Signing in and out](#2-signing-in-and-out)
3. [The main screen](#3-the-main-screen) — where everything is

**Using the console**

4. [Finding a drone](#4-finding-a-drone)
5. [Reading a drone](#5-reading-a-drone)
6. [Live video](#6-live-video) — including recording on your computer
7. [Screenshots](#7-screenshots)
8. [Renaming a drone](#8-renaming-a-drone)

**Setting up and changing a controller**

9. [Connecting a controller for the first time](#9-connecting-a-controller-for-the-first-time)
10. [Replacing a controller](#10-replacing-a-controller)
11. [Seeing every controller and drone](#11-seeing-every-controller-and-drone)
12. [Taking a drone out of service](#12-taking-a-drone-out-of-service)

**Accounts**

13. [Passwords](#13-passwords)
14. [Creating a new account](#14-creating-a-new-account)

**Zones, flights and drones**

15. [No-fly zones and geofences](#15-no-fly-zones-and-geofences)
16. [Alerts](#16-alerts)
17. [Flight history](#17-flight-history)
18. [Drone names, labels and colours](#18-drone-names-labels-and-colours)
19. [API access](#19-api-access) — letting your own program read the data and video

**When something is wrong**

20. [Fixing common problems](#20-fixing-common-problems)
21. [Word list](#21-word-list)

---

## How to read the steps

| Mark | Meaning |
| --- | --- |
| 🖥️ | This step happens on a **computer**, in a web browser |
| 📱 | This step happens on the **RC Plus 2 controller** |
| 👤 | **Drone operator** can do this |
| 🔑 | **Admin** can do this |
| ⚠️ | Read this — it can stop a flight or lose data |

Steps are numbered and bold. If you follow only the bold text, you will not go far wrong.

---

# 1. Before you begin

## The kinds of account

| Account | Who has it | What it can do |
| --- | --- | --- |
| **Developer** | the supplier of the system | everything; creates the Admin accounts |
| **Admin** | the person who runs the system | everything: approve controllers, manage accounts, rename, disable and delete drones; creates Sub-admins (with any of its own rights) and Drone operators |
| **Sub-admin** | other staff | exactly what the Admin allows, on all drones or chosen ones |
| **Drone operator** | the person on the remote | sign the controller in, nothing else; its access is fixed. **Only a drone operator account can connect a controller** |

⚠️ Only a **Drone operator** account can connect a controller. This is deliberate: it stops anyone with
an ordinary login from pretending to be a controller. Need another Admin? Ask the supplier.

## How the pieces fit together

The drone does **not** talk to our server. The **controller** does it on the drone's
behalf. So:

- every drone needs a controller,
- the controller needs to be **approved once** by an admin,
- and the controller page must stay open for the whole flight.

---

# 2. Signing in and out

## Signing in

1. Open **`https://fleet.example.com`** in a browser.
2. Type your **email** in the *Email* box.
3. Type your **password** in the *Password* box.
4. Press **Sign in**.

You stay signed in for **12 hours**.

⚠️ You are signed out straight away — without warning — if an admin resets your password or
changes what your account may do. The console returns to the sign-in page on its own. This is
normal; sign in again with your current password.

**"Invalid credentials"** — the email or password is wrong. Capitals and symbols count. If you
are sure it is right, ask an admin to reset it (see [section 13](#13-passwords)).

## Signing out

Press the **sign-out** button at the bottom of the left panel, next to your email.

- This ends the session **on that device only**. Other devices stay signed in.
- The copy of the session in that browser becomes useless — it cannot be replayed later.

---

# 3. The main screen

The screen has two parts: a **left panel** (the rail) and the **main area**.

## The left panel, from top to bottom

| Item | What it is |
| --- | --- |
| **Telemetry live** / **Reconnecting** | whether the console is receiving data right now |
| **Operations map** | the map view |
| **Live wall** | one video tile per online drone |
| **Screenshots** | every still picture that has been saved |
| **Awaiting approval** | appears **only** when a controller is waiting for a decision |
| **Users and permissions** | admins only — accounts and what each may do |
| **Controllers and drones** | admins only — every controller and drone, by status |
| **Search fleet** | filters the drone list |
| the drone list | click any drone to find it on the map |
| your email + two buttons | **change password** (lock) and **sign out** |

Each menu item has its own web address, so refreshing the page, using the browser's back
button, or sharing a link keeps you on the same screen:

| Screen | Address |
| --- | --- |
| Operations map | `/` |
| Live wall | `/live` |
| Screenshots | `/screenshots` |
| Users and permissions | `/users` (new account: `/users/new`) |
| Controllers and drones | `/inventory/controllers`, `/inventory/aircraft` |

Opening the address of a screen your account may not use takes you to the map instead.

## The top of the map

A line such as **`3 drones / 3 online / 0 streaming`**. It tells you at a glance how many
drones the console knows about, how many are reporting, and how many are sending video.

---

# 4. Finding a drone

## In the list

Type in the **Search fleet** box. It filters by **name**, **serial number** or **model**. Clear
the box to see everything again.

The list is grouped into **Online** and **Offline**.

## On the map

Click any drone in the left list. The map jumps to it and a card opens.

---

# 5. Reading a drone

The card shows the latest readings:

| Reading | Meaning |
| --- | --- |
| **Altitude** | height above the take-off point |
| **Speed** | horizontal speed |
| **Battery** | remaining charge |
| **Heading** | which way it is pointing |

Below them is a small chart of altitude over the last ten minutes, and the button **Open live
feed**.

## Online and offline

- **Green dot** — the drone is reporting.
- **Grey dot, "Offline"** — it is not.

When a drone goes offline the card keeps its last readings, in grey, under a heading like:

> **LAST KNOWN** — 4 minutes ago

⚠️ Read those numbers as **history, not live instruments**. The drone may have moved or
landed since. The live feed button is disabled while it is offline.

---

# 6. Live video

## The Live wall

1. Press **Live wall** in the left panel.
2. You get one tile per online drone.
3. **Click a tile** to make it fill the screen.

## Inside the full-screen view

| Button | What it does |
| --- | --- |
| **Back** | returns to where you came from |
| **Record** | records the video on your computer (see below); press it again to stop and save |
| **Capture** | takes a still picture and saves it on the server; **Count people** then appears for a few seconds |
| **Quality** | changes the video resolution |

Video starts by itself and stops about a minute after you leave the screen.

## Recording video on your computer

A recording is saved **on your computer**, not on the server. Your computer does the work,
so recording adds no load to the server.

1. On the **Live wall**, move the mouse over a tile. A **● REC** button appears at the bottom.
2. Click it. The **first time**, the browser asks you to choose a folder. Choose one, for
   example a folder called *Fleet recordings*. On a later visit it may ask once more to
   **Allow** access to that folder.
3. The button turns red and shows the time: **● 2:15 ■**. The drone also appears at the
   top of the wall with its time.
4. To stop, click the red button again, or its entry at the top of the wall. A message says
   **Recording saved** with the file name.

You can record several drones at the same time. Recording also works from the full-screen
view (**Record**), and it keeps going if you open the full-screen view, change the layout or
move to another screen.

Files are named **DRONE-FLEET\_*drone name*\_*date*\_*time*.mp4**, for example
`DRONE-FLEET_Drone-2_2026-10-29_19-11-46.mp4`, in your computer's time. To use another folder,
press **Recordings: …** at the top of the wall.

Good to know:

- **Keep the tab open** until you press stop. If the tab or the browser closes, the part
  being recorded is lost. The browser warns you before you leave the page.
- In Chrome and Edge the recording is **one file** until you press stop. If the video drops
  and comes back, it carries on in the same file (the file shows the last picture while the
  video is away). If the video stays away for more than **5 minutes**, the file is closed and
  a new one starts when the video returns. In Safari and Firefox each stretch of video is its
  own file.
- Recordings have **picture only**, no sound. Expect about **2 GB per hour** for each drone.
- While a recording runs you may see a file ending in **.crswap** in the folder. It becomes
  the .mp4 when you press stop.
- Chrome and Edge save straight into your folder. Safari and Firefox put each file in your
  **Downloads** folder when you press stop instead.
- You need the **Capture screenshots and record video** right on your account.

## If the video will not play

Do these in order:

1. Check the drone says **Online**.
2. Wait **ten seconds** — the stream can take a moment to start.
3. Press **Back** and open the drone again.
4. Lower the **Quality** — this helps on a weak network.

---

# 7. Screenshots

1. Press **Screenshots** in the left panel.
2. Filter by drone or by date at the top.
3. Click a picture to see it full size.
4. Press **Download** to save a copy to your computer.

To take a new one: open a live feed and press **Capture** (see [section 6](#6-live-video)).

Every picture is stored **on the server**, not on your computer, with the drone, date and
time attached.

## Deleting screenshots

You can delete a screenshot whenever you like. It is removed for good: the picture on the
server, and its people count. There is no undo.

- **One:** press the **trash** icon under the picture, or open it and press **Delete**.
- **Many:** press **Select**, tick the pictures (or **Select all … shown**), then **Delete
  selected**. The list follows the filters, so filter by drone or date first to clear one out.

Each time you are asked to confirm. This needs the **Delete screenshots** right on the drone,
which an Admin has and can give to others on the **Users and permissions** screen. Without it
the buttons do not appear. The system keeps a record of who deleted which file.

> There is no automatic cleanup. Delete what you no longer need, or ask the system owner.

## Counting people in a screenshot

1. Open the picture and press **People** (or press **Count people** right after **Capture**).
2. Wait while the AI counts — a large picture takes 10–20 seconds.
3. Every person the AI found gets a mark:

| Mark | Meaning |
| --- | --- |
| Gold dot | counted |
| Gold dot with an orange ring | counted, but the AI is unsure — look at it first |
| Dashed white ring | a possible person, **not** counted |
| Blue dot | a person you added by hand |

4. Check the picture. Use **+** to zoom in on dense groups.
   - Click a mark that is not a person to remove it.
   - Click a dashed ring that is a person to count it.
   - Click anyone without a mark to add them.
   - **Undo** reverses the last click; **Reset to AI** starts again.
5. When every person has exactly one filled mark, press **Save verified count**.

The number becomes **verified**, with your name and the time. In the gallery a verified count
shows a tick (for example **260 ✓**); an AI estimate that nobody has checked shows **~**.

> The AI count alone is an estimate. People standing close together, partly hidden, or very
> far from the camera can be missed. Only a verified count should be reported as exact.

---

# 8. Renaming a drone

> You can also rename drones and give each one a colour on the **Drones** screen (see [section 18](#18-drone-names-labels-and-colours)).

> 🖥️ **On a computer** · 🔑 **Admin**

1. Hover over a drone in the left panel.
2. Press the **pencil** icon.
3. Type the new name and press **Enter**.

The name is used everywhere, including search. The serial number never changes — the name is
only a label for people.

---

# 9. Connecting a controller for the first time

This happens **once per controller**. It takes two people: the drone operator on the controller, and an
admin at a computer.

## Before you start

- 📱 The controller has internet.
- 📱 The controller has the DJI certificate installed (the standard DJI setup).
- 👤 The drone operator has a **drone operator account** email and password. Ask an admin if not — see
  [section 14](#14-creating-a-new-account).
- 🔑 An admin is available to approve it. Have their phone number ready.

## Step 1 — the drone operator opens the fleet page

> 📱 **On the controller** · 👤 **Drone operator**

1. On the RC Plus 2, open **Pilot 2**.
2. Open **Cloud Services** and choose the **Drone Fleet** entry.
3. The fleet page opens.

## Step 2 — the drone operator signs in

> 📱 **On the controller** · 👤 **Drone operator**

1. Type the **drone operator email** in the first box.
2. Type the **drone operator password** in the second box.
3. Press **Connect controller**.

The controller checks the DJI licence, reads its own serial number, and asks the server to
join.

## Step 3 — the controller waits

> 📱 **On the controller** · nothing to do yet

The card changes to **Awaiting approval**, with **Waiting for an administrator** underneath.

Underneath, **Connection steps** shows seven steps. **Controller approval** is the one holding
everything up.

⚠️ **This is normal.** Nothing is being reported and there is no video yet. **Leave the page
open.**

## Step 4 — an admin approves it

> 🖥️ **On a computer** · 🔑 **Admin**

On a computer, signed in as an admin. There are two places to do this; both work.

**Fast route — from the left panel:**

1. Look for the **Awaiting approval** block in the left panel. It shows the controller's serial
   number and when it asked.
2. Press the **tick** (✓) to allow it, or the **cross** (✗) to refuse it.

**Full route — from the controller list:**

1. Open **Controllers and drones** in the left panel.
2. Find the controller by serial number. It shows **pending**.
3. Press **Approve**.

The controller is now allowed.

> ⚠️ If you cannot find it, make sure the drone operator has pressed **Connect controller**. Nothing
> appears in the list until they do.

## Step 5 — the drone operator checks approval

> 📱 **On the controller** · 👤 **Drone operator**

1. Press **Check approval** on the controller.
2. The seven steps turn green one by one:

   1. **Account sign-in** — Signed in
   2. **DJI licence** — Verified by Pilot 2
   3. **Controller approval** — Approved
   4. **Cloud API module** — Module loaded
   5. **Telemetry link** — MQTT connected
   6. **Workspace** — Workspace linked
   7. **Live video service** — Video service loaded

3. The card changes to **Controller connected**.

Within about ten seconds the drone appears on the map. 🖥️

## Step 6 — keep the page open

> 📱 **On the controller** · 👤 **Drone operator**

⚠️ **Keep the fleet page open for the whole flight.** Closing it, or letting the screen sleep,
stops the drone from reporting. The console will show it as **Offline**.

## If the controller is refused

The card shows **Controller not approved**. The controller stays blocked until an admin changes
the decision.

Contact the admin. They can approve it from **Controllers and drones** by pressing
**Approve** on the rejected row.

---

# 10. Replacing a controller

Use this when the **drone stays the same** but the controller is swapped.

The new controller will be refused at first, with a message that the drone belongs to
another controller.

⚠️ This is a safety feature: a drone can only belong to one controller at a time, so nobody
can secretly take over a drone already in use.

## Step 1 — release the old controller

> 🖥️ **On a computer** · 🔑 **Admin**

1. Sign in as an admin.
2. Open **Controllers and drones** in the left panel.
3. Find the **old** controller by serial number.
4. Press **Unbind**, then confirm.

The old controller now shows as **rejected**. That is expected — it is no longer allowed to send
anything.

⚠️ Do this **between flights**. Unbinding stops every drone on that controller from reporting
until they are connected again.

## Step 2 — connect the new controller

> 📱 **On the controller** · 👤 **Drone operator**

Follow [section 9](#9-connecting-a-controller-for-the-first-time) from the beginning.

---

# 11. Seeing every controller and drone

The left panel only shows **pending** controllers. To see everything, open **Controllers and
drones** in the left panel. There are two tabs.

## Controllers tab

Every controller that has ever contacted the server.

| Column | Meaning |
| --- | --- |
| **Controller** | the serial number printed on the handset |
| **Status** | **pending**, **approved** or **rejected** |
| **Drones** | the drones it is allowed to send |
| **Requested** | when it first asked |
| **Decided by** | who approved or rejected it, or why |

Buttons on each row:

| Button | What it does |
| --- | --- |
| **Approve** | allows a pending or rejected controller |
| **Reject** | blocks it. Its drones stop reporting until it is approved again |
| **Unbind** | releases an approved controller. Same effect as reject, different intent |

## Drones tab

Three sections, so you can always see what is out of service and why: **Active**,
**Disabled**, **Deleted**. See [section 12](#12-taking-a-drone-out-of-service).

---

# 12. Taking a drone out of service

There are two ways, and the difference is simple:

| | Who can undo it | Use it for |
| --- | --- | --- |
| **Disable** | an **admin**, from the console | maintenance, grounding, a pause |
| **Delete** | only the drone's **own controller** | lost, stolen, retired for good |

## Disable (temporary)

> 🖥️ **On a computer** · 🔑 **Admin**

Use for maintenance, grounding, or a pause.

1. Open **Controllers and drones** → **Drones** tab.
2. Find the drone in the **Active** section.
3. Press **Disable**.

What happens:

- it disappears from the map, the wall and the search
- its video stops
- the controller can no longer send data for it
- **its history is kept**

**To bring it back:** press **Enable** in the **Disabled** section. No controller is needed. It
shows as offline until it reports again.

## Delete (permanent)

> 🖥️ **On a computer** · 🔑 **Admin**

Use only when the drone is **lost, stolen, or retired for good**.

1. Find the drone in the left panel's drone list.
2. Hover over it and press the **trash** icon.
3. Confirm.

> The trash icon only appears for accounts allowed to delete that drone.

It is removed from the fleet exactly like a disable, but:

⚠️ **Only the original controller can bring it back.** The drone must be connected to that
controller, and rebound from the controller's own page (**Rebind a deleted drone**).

There is deliberately **no restore button** in the console. Someone holding the drone's
controller is the only proof the drone is really yours — which is exactly what matters when
a drone goes missing.

> **If in doubt, disable.** Deleting the wrong drone means getting the physical controller
> back before it can return to the map.

Both states are always listed on the **Drones** tab, in their own sections.

---

# 13. Passwords

Both routes need only a browser. Neither needs server access.

## Changing your own email (your sign-in ID)

> 🖥️ **On a computer** · anyone

Your **email is your sign-in ID**. Every account can change its own, whatever its role.

1. Sign in.
2. Press the small **lock** button at the bottom of the left panel (or **Email / password** on your
   own row of **Users and permissions**). The **Your account** page opens.
3. In **Your sign-in email**, type the **new email** and your **current password**.
4. Press **Change email**.

From then on you sign in with the new email; the old one stops working. **Nobody is signed out**,
and a drone operator's remote controller stays connected, so this is safe to do at any time. The same
page has **Change password** below it.

> If a new version of the console is released while a page is open, a bar at the bottom says
> **A new version is ready** with a **Reload** button. Press it when you are not recording.

## Changing your own password

> 🖥️ **On a computer** · anyone

Works for every account, including the drone operator account on the controller.

1. Sign in.
2. Press the small **lock** button at the bottom of the left panel, next to your email. (On
   **Users and permissions**, your own row also has an **Email / password** button.)
3. Type your **current** password.
4. Type the **new** password in both boxes.
5. Press **Change password**.

The new password must be at least **8 characters**.

⚠️ **What happens to other devices:** they are signed out **immediately**. If the console is
open on another computer, or the drone operator is signed in on the controller, that screen returns to
the sign-in page at once and needs the new password. **The device you are using stays signed
in** — you do not type the new password again.

## Resetting someone else's password

> 🖥️ **On a computer** · 🔑 **Admin**

Use when a person cannot sign in — for example they forgot it, or the drone operator is stuck on the
controller.

1. Sign in as an admin.
2. Open **Users and permissions**.
3. Press **Edit** on the person's row.
4. Type a new password in **New password**, or press **Generate**.
5. Press **Save changes**.
6. Tell them the new password. It works straight away; they can change it later themselves.

You cannot see anyone's existing password — nobody can. A reset replaces it.

⚠️ **An admin reset signs that person out everywhere, immediately** — every browser, and the
controller if it is signed in. If you reset the password of a drone operator whose drone is flying,
**that drone stops reporting** until the drone operator signs in again.

> Do this **between flights**, not during one. There is no way to reset a password without
> signing that person out — which is exactly what makes it the safe button when an account may
> be compromised.

## Whose accounts you see

Every Admin is its own customer, for example *Fire Service* and *Police* on the same system.

- An **Admin** (and the Sub-admins who work for it) sees only the Sub-admins and Drone operators that
  belong to that Admin. Another Admin's people do not appear and cannot be reached.
- A **Developer** sees everyone. **Users and permissions** shows one block per Admin with the
  count of its Sub-admins and Drone operators, and a **Created by** column says who made each account.
- A new Sub-admin or Drone operator belongs to the Admin that created it. When a Developer creates one,
  the form asks **Belongs to Admin**; leave it on *No Admin* and only Developers see the account.
- An Admin that still has Sub-admins or Drone operators cannot be deleted: delete them first.

> Only accounts are separated this way. Drones, controllers, screenshots, zones and flights
> are shared by every Admin on the same system.

## Deleting an account

> 🖥️ **On a computer** · 🔑 **Admin**

Use when someone has left and their account should be gone, not just paused.

1. Open **Users and permissions**.
2. Press **Delete** on the person's row and confirm.

The account is removed for good and cannot be brought back; make a new one if they return. Their
sessions end at once, and if it was a **Drone operator** account the remote controller it signed in is
disconnected until another Drone operator account signs in on it. Flights and screenshots they took part
in are kept.

To pause an account instead, use **Disable** (it can be switched back on with **Enable**).

You cannot delete **your own** account, or a **Developer**. Only a Developer can delete an
**Admin**; an Admin or a Sub-admin who manages users can delete the Sub-admins and Drone operators whose
access is within their own.

---

# 14. Creating a new account

1. Sign in as an admin.
2. Open **Users and permissions**.
3. Press **Create user**.
4. Fill in:
   - **Email address** — the person's address
   - **Password** — at least 8 characters, or press **Generate** for a strong one
     and **Copy** it. Tell them this.
   - **Role** — **Sub-admin** (a Developer also sees **Admin**; see [section 1](#1-before-you-begin)).
     A **Pilot** is not made here: see the end of this section
   - **Administration** — account-wide rights such as managing users (only shown if you may
     grant them)
   - **Drone access** — **Selected drones** (tick actions per drone; ticking any action
     also ticks **View drone**) or **All drones, including future ones**
5. Press **Create user**. Missing or invalid fields are pointed out before anything is saved.

The password you set is the one they use: nothing forces them to change it. They can change it any
time from the padlock at the bottom of the left panel.

**A Drone operator account** (the one a remote controller signs in with) is made on the **Drones** screen:
press **Add drone operator** next to **Add video-only drone**, type the email and a password (**Generate**
and **Copy** help), and press **Create**. A Developer also picks the Admin it works for. The drone operators
are listed under the drones on the same screen, where you can give one a **New password**,
**Disable** or **Enable** it, or **Delete** it. Drone operators are not listed on **Users and permissions**.

A Drone operator account only connects a remote controller, and it always gets exactly what that needs
(see and bind every drone). There is nothing to tick.

A **Sub-admin** gets the rights you tick, on all drones or chosen ones. You can give a Sub-admin
anything you have yourself, **Manage users** included; a Sub-admin who manages users can in turn
only give out what they hold, and can never create or change an Admin.

---

# 15. No-fly zones and geofences

Open **Zones and geofences** in the left panel. The map shows two kinds of area:

| Area | Colour | What happens |
| --- | --- | --- |
| **No-fly zone** | red, with a dashed red line around it | A drone that is **flying** gets a **warning** when it comes within the *warning distance* of the edge, and a **critical alert** when it goes inside. |
| **Geofence** | blue | You are alerted when a drone that is **flying** is **outside** it. Use it to keep a flight inside a site. |

Everyone who signs in can see the zones, a drone operator account included; only accounts with the
**Draw and edit no-fly zones and geofences** permission can change them.

The app comes with 42 no-fly zones: airports, air force bases, cantonments, the presidential
palace and similar sites. **They are approximate** (drawn from public map data, and some are
rough circles). They help you, but they do not replace the official permission from CAAB or
the authorities. Always check before you fly near them.

## Adding a zone or a geofence

1. Press **No-fly zone** or **Geofence** at the top right. (You need the **Draw and edit
   no-fly zones and geofences** permission; admins have it.)
2. **Circle:** click the map where the centre should be. Drag the round handle to move it, or
   the square handle to make it bigger or smaller. You can also type the radius in metres.
3. **Polygon:** press **Polygon**, then click each corner on the map. Click the first point (or
   press **Enter**, or **Finish**) to close the shape. **Undo point** removes the last corner,
   **Esc** stops drawing.
4. To reshape a polygon later: drag a corner to move it, click a small dot between two corners
   to add a corner, double-click a corner to remove it.
5. Give it a **name**. For a no-fly zone pick the **Type** and set the **Warning distance**.
6. For a geofence, choose **Every drone** or tick only the drone it applies to.
7. Press **Save zone**.

The **warning distance** is saved with the zone. The type suggests a usual distance (an airport
3 km, a military area 600 m, a government site 500 m); change it if you wish. Set **None** to be
told only when a drone goes inside.

## Changing or removing a zone

Click it in the list (or on the map), then **Edit**. **Active** switched off keeps the zone but
stops its alerts. **Delete** removes it; a zone that came with the app does not come back.

> **Why is nothing happening for a drone on the ground?** Alerts are only for drones that
> are flying (at least 2 m high). A drone parked inside an airport zone stays quiet until it takes off.

---

# 16. Alerts

An alert is raised for a drone that is **flying** when it:

- comes near a no-fly zone, goes inside one, or leaves a geofence;
- **loses contact**: it drops off its controller, or stops sending data (about 45 seconds of silence). The
  alert keeps the last position and height heard, and **stays open until the drone reports again**, so it is
  still there when you look. A drone that landed and was switched off does not raise it;
- runs **low on battery**: a warning at 30 %, and a critical alert at 15 % or when the drone's own estimate of
  flight time left falls to 2 minutes. (The numbers can be changed by whoever runs the server.) The battery
  alert closes when the flight ends.

When one is raised:

- a box appears at the top right of the screen and the computer beeps;
- the **Alerts** item in the left panel shows a red number;
- the drone's dot on the map pulses red.

Press **Show on map** to go to the drone, or **Acknowledge** to say you have seen it. A zone or battery
alert closes by itself when the drone moves away or lands; a contact alert closes when the drone is heard again. The **Alerts** screen lists them
all, newest first; filter by drone or show only the open ones. **Sound on/off** is at the top
right (it is remembered on this computer).

---

# 17. Flight history

A flight is recorded **by itself**: it starts when a drone rises above 2 m and ends when it
has been on the ground for about 20 seconds (or has been silent for a minute). Very short hops
are not kept.

Open **Flight history**. Each row shows when it started, the drone, how long, how far, the
highest point, top speed, lowest battery and how many alerts it caused. Filter by drone or
dates. A flight that is still in the air is marked **In flight**
and updates by itself.

Click a flight to see:

- the **whole path** on the map in the drone's colour, with **arrows showing the direction
  of travel**, **S** for take-off and **E** for landing, the zones around it, and a red **!** where
  an alert happened;
- height, speed, battery, distance and the farthest point from take-off;
- **Replay**: press it to watch the drone fly the path again at 1×, 5×, 20× or 60×, or drag the
  slider or the height and speed charts to jump to any moment.

---

# 18. Drone names, labels and colours

Open **Drones**. One row per drone:

- the **name** (type over it, for example *Drone 1*, then press **Enter**);
- an optional **label**, a nickname that sits beside the name (for example *Fire-1* or
  *Rescue team*). Type it in the **Label** column and press **Enter**; clear the box to remove
  it. It shows as *Drone 1 · Fire-1* on the map card, the left list, the live wall, flights,
  alerts and screenshots, and the search box finds a drone by it;
- the **colour** (pick one of the colours, or choose your own). It is the colour of the drone's
  dot and name on the map, its path and its trail. Red is not offered, because red means no-fly.

On the map every drone shows its name on a small label of its own colour.

## Video-only drones (a DJI Mini streaming from DJI Fly)

A drone that cannot connect through a controller, such as a DJI Mini 5 Pro, can still show its
**video** on the Live wall. You get no map position, battery, height, flight history or zone alert,
because DJI Fly sends only the picture.

1. On **Drones** press **Add video-only drone**, type a name (for example *Mini 5 Pro*) and press
   **Create**.
2. A panel shows **RTMP Address**, **Stream Key** and both joined in one box, each with **Copy**.
3. In DJI Fly open **Livestream**, choose RTMP, and paste the address and the key into the two
   boxes (or paste the joined address into RTMP Address and leave Stream Key empty). Choose
   **720P**, and **Smooth** if the upload is weak. Press **Start Livestream**.
4. Within a few seconds the drone appears on the Live wall, and in the left list as
   *Video only · streaming*. When the drone operator stops in DJI Fly the drone goes **Offline**; pressing
   Start again brings it back by itself.

Opening it full screen, **Capture**, **Count people** and **Record** work as for any drone. Start,
stop and quality are set only in DJI Fly, so those controls are not shown.

The address is a secret (the key is 20 letters and digits, with nothing easily mixed up, so it is
easy to type on the controller): anyone who has it can send video to this drone. On the **Drones** screen,
**Address** shows it again, **Make a new key** replaces it (the old one stops at once and a running
push is cut), and **Remove** deletes the drone for good. **Disable** also cuts the feed.

---

# 19. API access

If your organisation writes its own software, for example an **AI tool that analyses the video**, that software can read
the drones, telemetry, flights, alerts, pictures, recorded video and **live video** through a **token** instead of a
person's sign-in. A token is **read-only**: it can look, and can never change or delete anything.

1. Open **API access** in the left panel (Admins have it; an Admin can give it to others).
2. Press **New token**. Give it a name (what it is for), choose **every drone I can see** or only the drones it may read,
   and how long it should work.
3. **Copy the token now.** It is shown only once. Give it to the person who writes the program, together with
   [the API guide](api.md); the **API description** button downloads the machine-readable description.
4. To stop a program, press **Revoke** next to its token. It stops working at once.

The list shows when each token was last used and from which address. A token never sees more than the account that made
it. Keep it secret like a password: if it leaks, revoke it and make a new one. Everything a program does with a token that
could matter (opening a live video) is in the **Audit log**.

---

# 20. Fixing common problems

## On the computer

| What you see | What it means | What to do |
| --- | --- | --- |
| **"Invalid credentials"** | wrong email or password | check capitals and symbols; ask an admin to reset it |
| The map is empty | no drones are reporting | check the drone is on and the controller page is open |
| A drone is grey and says **Offline** | it stopped reporting | check the controller is still on the fleet page, and has internet |
| Video will not start | the stream did not come up | go back and open the drone again; lower the **Quality** |
| The left panel says **Reconnecting** | the computer lost contact with the server | check your internet; it reconnects on its own |
| Suddenly back at the sign-in page | your session ended — 12 hours passed, an admin reset your password, or your account changed | sign in again with your current password |
| A drone is missing from the list | it may be disabled or deleted | check the **Drones** tab in **Controllers and drones** |

## On the controller

| What you see | What it means | What to do |
| --- | --- | --- |
| **Awaiting approval** | nobody has approved this controller yet | ask an admin to approve it, then press **Check approval** |
| **Controller not approved** | an admin refused it | ask the admin why, and to press **Approve** |
| "This account cannot bind a controller" | the account is not a Drone operator account | use a **drone operator** account |
| "Drone binding permission required" | the drone operator account lacks `drones.bind` | ask an admin to grant it |
| "Email or password is incorrect" | wrong login | check the password; an admin can reset it |
| **Licence verification failed** | a problem on the server, not the controller | tell the system owner |
| Green steps, but no drone appears | the controller cannot reach the server | check the controller has internet; tell the system owner |
| "Too many requests" | too many tries in a short time | wait one minute and try again |
| The drone went offline mid-flight | the fleet page was closed, or the screen slept | reopen the fleet page and connect again |

---

# 21. Word list

| Word | What it means here |
| --- | --- |
| **No-fly zone** | a red area. A flying drone is warned when it comes near it and alerted when it goes inside |
| **Warning distance** | how far outside a no-fly zone's edge the warning starts. Saved per zone |
| **Geofence** | a blue area a drone must stay inside. You are alerted when it leaves |
| **Alert** | a message that a flying drone came near or entered a no-fly zone, left a geofence, lost contact, or is low on battery |
| **Flight** | one take-off to landing, recorded by itself |
| **Replay** | watching a recorded flight again on the map |
| **Drone** | the flying unit, with its camera. DJI's own documents call it an "aircraft" |
| **Controller / RC** | the RC Plus 2 handset with the screen. It sends the drone's data to us |
| **Pilot 2** | DJI's app on the controller. Our page opens inside it |
| **Gateway** | another word for controller |
| **Controller serial** | the unique number printed on the controller |
| **Pending / Awaiting approval** | the controller has asked to join but nobody has allowed it yet |
| **Approved** | an admin has allowed this controller |
| **Rejected** | an admin has refused it, or it was unbound |
| **Online / Offline** | whether the drone is reporting right now |
| **Live wall** | the screen with one video tile per drone |
| **Capture** | saving a still picture from a live video |
| **Drone operator account** | the login used on the controller. Only this kind can connect a controller |
| **Admin** | the account that manages controllers and people |
| **Disabled** | a drone paused. An admin can switch it back on |
| **Deleted** | a drone out of service for good. Only its own controller can bring it back |
| **Session** | one signed-in period. It lasts up to 12 hours, and an admin can end it sooner |

---

*For the person who runs the system: technical instructions are in `docs/deployment.md`,
`docs/rc-login.md` and `docs/access-control.md`.*
