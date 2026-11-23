# Drone Fleet read-only API

For the person who writes a program that reads the fleet: an AI analysis tool, a data warehouse, a custom dashboard.
Everything here is **read-only**: a token can look at drones, telemetry, flights, alerts, pictures, recordings and live
video, and can never change or delete anything.

The machine-readable description (OpenAPI 3) is `GET /api/v1/openapi.json`, and the **API description** button on the
API access screen downloads it. Import it into Postman, or generate a client from it.

## 1. Get a token

An Admin opens **API access** in the menu, presses **New token**, names it ("Acme AI analytics"), chooses which drones it
may read and how long it works, and copies the token **once** (it starts with `ne_` and is never shown again). Revoke it
on the same screen at any time; it stops working at once.

A token can never see more than the account that made it, never changes anything, and is not a password: it has no
two-step code and no 12-hour session. Keep it like a password (a secret file or environment variable, never in source
code or a web page). If it leaks, revoke it and make a new one.

Send it in every request:

```text
Authorization: Bearer ne_xxxxxxxx...
```

Use HTTPS. The token goes in the header only, never in the address: addresses end up in logs.

## 2. Try it

```bash
export NE=https://your-server
export T=ne_xxxxxxxx...

curl -H "Authorization: Bearer $T" $NE/api/v1/whoami      # who am I, which drones, when does it expire
curl -H "Authorization: Bearer $T" $NE/api/devices        # the drones, with their latest telemetry
```

## 3. What you can read

| Address | What it gives |
| --- | --- |
| `GET /api/v1/whoami` | This token, its expiry and the drones it may read. Call it first. |
| `GET /api/devices` | Every drone: name, online, last seen, latest telemetry, cameras. |
| `GET /api/devices/{sn}/telemetry?minutes=30` | Stored samples (about one a second while flying), up to 24 hours. |
| `GET /api/devices/{sn}/trail?minutes=5` | Recent positions, for a trail. |
| `GET /api/streams` | Which drones are streaming video now. |
| `GET /api/devices/{sn}/frame` | **One JPEG of what the drone sees now.** |
| `GET /api/devices/{sn}/live` | **The live video** (MPEG-TS over HTTP). |
| `GET /api/flights`, `/api/flights/{id}` | Take-off to landing, with the path and its alerts. |
| `GET /api/alerts?active=1` | No-fly zone alerts, geofence alerts, contact lost and battery alerts. |
| `GET /api/zones` | No-fly zones and geofences. |
| `GET /api/screenshots`, `/{id}`, `/{id}/image`, `/{id}/thumbnail`, `/{id}/people` | Stored pictures and the people counted on them. |
| `GET /api/recordings`, `/{id}`, `/{id}/video`, `/{id}/thumbnail` | Recorded video; `/video` supports HTTP `Range`. Each has `tags` and `note` (what people wrote); `?q=` searches name, folder, tags and notes, `?tag=` one tag. |
| `GET /api/recordings/tags` | The tags in use, with how many videos carry each. |

Lists are newest first, and paged with `limit` and `before` (pass the oldest time you have). Times are ISO 8601 in UTC.
Anything else answers `403 not_available_to_api_tokens`, and anything that is not a `GET` answers `403
api_token_read_only`.

**Telemetry fields** (`telemetry` in `/api/devices`, one per sample): `lat`, `lon` (degrees; `null` until the drone has a
position), `altRel` (metres above take-off), `heading`, `speedH` and `speedV` (m/s), `batteryPct`, `remainFlightS` (the
drone's own estimate of flight time left), `mode`, `gnss` (satellites), `rtk`, and `ts` (milliseconds since 1970).

## 4. Pictures for an AI model

```python
import os, time, requests, numpy as np, cv2

BASE, TOKEN = os.environ["NE"], os.environ["T"]
H = {"Authorization": f"Bearer {TOKEN}"}
SN = "1ZABCDE000000001"

while True:
    r = requests.get(f"{BASE}/api/devices/{SN}/frame", headers=H, timeout=40)
    if r.status_code == 503:                       # the drone is not sending video yet
        time.sleep(int(r.headers.get("Retry-After", 5))); continue
    r.raise_for_status()
    image = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
    taken = r.headers["X-Frame-Time"]              # when the picture was taken (ISO 8601)
    # ... run the model on `image` ...
    time.sleep(1)                                  # one a second is plenty; limit is about 2 a second
```

Asking for a picture starts the drone's video if nobody is watching (it can take a few seconds, up to about 20; then the
answer is `503` with `Retry-After`) and keeps it up for a minute after your last request. Pictures taken within the same
second are shared, so several programs asking at once cost one decode.

## 5. The live video

`/api/devices/{sn}/live` is the drone's video **exactly as it sends it** (H.264 or H.265, not re-encoded, video only),
as MPEG-TS over HTTP. Any ffmpeg-based tool reads it; pass the token as a header:

```bash
# Look at it
ffplay -headers "Authorization: Bearer $T"$'\r\n' $NE/api/devices/$SN/live

# One frame a second to JPEG files, for a model
ffmpeg -headers "Authorization: Bearer $T"$'\r\n' -i $NE/api/devices/$SN/live \
  -vf fps=1 -q:v 3 frame_%06d.jpg
```

From Python with OpenCV (it reads through ffmpeg, so the same header applies):

```python
import os, cv2
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = f"headers;Authorization: Bearer {TOKEN}\r\n"
cap = cv2.VideoCapture(f"{BASE}/api/devices/{SN}/live", cv2.CAP_FFMPEG)
while True:
    ok, frame = cap.read()
    if not ok: break           # the drone's stream restarted or stopped: open it again after a pause
    # ... run the model on `frame` ...
```

The video ends by itself if the drone's stream restarts; open it again. If the drone is not streaming the answer is `503`
with `Retry-After`. The server hands out a limited number of live feeds at once (8 unless the installer changed it);
beyond it the answer is `429`. Opening a feed asks the drone to stream, which uses its controller's network: open it
when you need it.

RTSP is not offered; the HTTP stream above works with every ffmpeg-based tool, and a program that insists on RTSP can be
fed through `ffmpeg ... -c copy -f rtsp` or MediaMTX.

## 6. Live telemetry and alerts without polling

A WebSocket pushes telemetry, drone status and alerts as they happen. Connect to `wss://your-server/ws` with the same
`Authorization` header, then subscribe:

```python
import asyncio, json, os, websockets

async def main():
    url = os.environ["NE"].replace("https", "wss", 1) + "/ws"
    async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {os.environ['T']}"}) as ws:
        await ws.send(json.dumps({"type": "subscribe", "channels": ["devices"]}))
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "telemetry":  print(msg["data"]["sn"], msg["data"]["batteryPct"])
            if msg["type"] == "alert":      print("ALERT", msg["data"]["message"])

asyncio.run(main())
```

Messages: `telemetry`, `device.status`, `alert` (raised, then again when cleared or acknowledged), `stream.state`,
`device.cameras`. Subscribe to `device:<sn>` for one drone. Only the drones the token may read are sent, and the socket
closes by itself when the token is revoked or expires. Send `{"type":"ping"}` now and then to keep it open.

## 7. Errors and limits

| Answer | Meaning |
| --- | --- |
| `401` | No token, a wrong one, or one that was revoked or has expired. |
| `403` | The token may not read that (another drone, or not on the list above). |
| `404` | It does not exist (or is not yours). |
| `429` | Too many requests, or the live feed limit. `Retry-After` says when. |
| `503` | The drone is not sending video yet. `Retry-After` says when. |

Pictures are limited to about 120 a minute and live feeds to 20 openings a minute, per address. Reads of data are not
limited, but be kind: telemetry once a second is plenty.

## 8. Not provided

Pushing results back (detections, counts) into the dashboard, webhooks, RTSP, and sending commands to a drone are not
part of this API. A token cannot change anything by design.
