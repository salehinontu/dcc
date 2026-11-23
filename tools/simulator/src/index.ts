import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import mqtt, { type MqttClient } from 'mqtt'
import ffmpeg from '@ffmpeg-installer/ffmpeg'
import { LiveMethod, parseTopic, topic, type Envelope, type Topo } from '@dji/protocol'

/**
 * Publisher that behaves like a Pilot 2 gateway: topology on connect, OSD once a second,
 * live capacity in state, and replies to live-stream service calls. It does not push real
 * video; it only drives the control plane, which is enough to exercise the whole app.
 */

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883'
const MQTT_USERNAME = process.env.MQTT_USERNAME
const MQTT_PASSWORD = process.env.MQTT_PASSWORD
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? ffmpeg.path
const COUNT = Math.max(1, Number(process.env.SIM_DRONES ?? 3))
const RATE_MS = Math.max(200, Number(process.env.SIM_RATE_MS ?? 1000))
const ORIGIN_LAT = Number(process.env.SIM_ORIGIN_LAT ?? 23.8103)
const ORIGIN_LON = Number(process.env.SIM_ORIGIN_LON ?? 90.4125)
// To see the battery alerts without waiting an hour: start low and drain fast, e.g.
// SIM_BATTERY_START=33 SIM_BATTERY_DRAIN=0.5 (percent per second).
const BATTERY_START = Math.min(100, Math.max(6, Number(process.env.SIM_BATTERY_START ?? 96)))
const BATTERY_DRAIN = Math.max(0, Number(process.env.SIM_BATTERY_DRAIN ?? 0.006))
// Simulates a slow controller uplink: delay both the reply and the first ffmpeg frame.
const START_DELAY_MS = Math.max(0, Number(process.env.SIM_START_DELAY_MS ?? 0))

// Placeholder for "this video is already being pushed". Real Pilot most likely rejects a
// duplicate start with a non-zero code; the exact value is unconfirmed, and the API only
// relies on it being non-zero (it stops and retries once).
const SIM_ALREADY_STREAMING = 513003

interface LiveEntry {
  quality: number
  startedAt: number
}

interface SimDrone {
  index: number
  rcSn: string
  droneSn: string
  payloadSn: string
  cameraIndex: string
  videos: { videoIndex: string; videoType: string }[]
  radius: number
  phase: number
  batteryStart: number
  live: Map<string, LiveEntry>
}

function serial(prefix: string, index: number): string {
  return `1Z${prefix}${String(index + 1).padStart(9, '0')}`
}

const drones: SimDrone[] = Array.from({ length: COUNT }, (_, index) => ({
  index,
  rcSn: serial('SIMRC', index),
  droneSn: serial('SIMDRN', index),
  payloadSn: serial('SIMPAY', index),
  cameraIndex: '39-0-7',
  videos: [
    { videoIndex: 'normal-0', videoType: 'normal' },
    { videoIndex: 'wide-0', videoType: 'wide' },
    { videoIndex: 'zoom-0', videoType: 'zoom' },
    { videoIndex: 'ir-0', videoType: 'thermal' },
  ],
  radius: 260 + index * 120,
  phase: (index * Math.PI * 2) / COUNT,
  batteryStart: BATTERY_START - index * 3,
  live: new Map(),
}))

let client: MqttClient
let timer: NodeJS.Timeout | undefined
let subscribeTimer: NodeJS.Timeout | undefined
const startedAt = Date.now()

const VIDEO_ENABLED = process.env.SIM_VIDEO !== '0'
const publishers = new Map<string, ChildProcess>()

/**
 * Stand in for the aircraft's encoder: publish a test pattern to the RTMP URL the backend
 * handed to us. This makes the video path real without a drone or a camera.
 */
function startPublisher(videoId: string, url: string): void {
  if (!VIDEO_ENABLED || !url) return
  stopPublisher(videoId)

  const child = spawn(
    FFMPEG_PATH,
    [
      '-re',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-b:v',
      '1500k',
      '-g',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-f',
      'flv',
      url,
    ],
    { stdio: 'ignore' },
  )

  child.on('error', (error) => console.error('[sim] ffmpeg failed', error.message))
  child.on('exit', (code) => {
    if (publishers.get(videoId) === child) publishers.delete(videoId)
    if (code !== 0 && code !== null) console.error(`[sim] ffmpeg exited with ${code}`)
  })

  publishers.set(videoId, child)
  console.log(`[sim] publishing test video for ${videoId}`)
}

function stopPublisher(videoId: string): void {
  const child = publishers.get(videoId)
  if (!child) return
  child.kill()
  publishers.delete(videoId)
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

function publish(target: string, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(target, JSON.stringify(payload), { qos: 1 }, (error) =>
      error ? reject(error) : resolve(),
    )
  })
}

function envelope(data: unknown, method?: string): Envelope {
  return {
    tid: randomUUID(),
    bid: randomUUID(),
    timestamp: Date.now(),
    ...(method ? { method } : {}),
    data,
  }
}

function topoData(drone: SimDrone, online: boolean): Topo {
  return {
    domain: 2,
    type: 167,
    sub_type: 0,
    version: '1.0.0',
    sub_devices: online
      ? [
          { sn: drone.droneSn, domain: 0, type: 100, sub_type: 0, index: 0, version: '1.0.0' },
          { sn: drone.payloadSn, domain: 1, type: 89, sub_type: 0, index: 0, version: '1.0.0' },
        ]
      : [],
  }
}

function capacityData(drone: SimDrone) {
  return {
    available_video_number: 1,
    coexist_video_number_max: 2,
    device_list: [
      {
        sn: drone.droneSn,
        available_video_number: 1,
        coexist_video_number_max: 2,
        camera_list: [
          {
            camera_index: drone.cameraIndex,
            available_video_number: 1,
            coexist_video_number_max: 2,
            video_list: drone.videos.map((video) => ({
              video_index: video.videoIndex,
              video_type: video.videoType,
            })),
          },
        ],
      },
    ],
  }
}

function liveStatusData(drone: SimDrone) {
  return {
    live_status: {
      live_status: [...drone.live.entries()].map(([videoId, entry]) => ({
        video_id: videoId,
        video_quality: entry.quality,
        status: true,
      })),
    },
  }
}

function position(drone: SimDrone, elapsedSeconds: number) {
  const angle = drone.phase + (elapsedSeconds / 240) * Math.PI * 2
  const metersPerDegreeLat = 111_320
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos((ORIGIN_LAT * Math.PI) / 180)
  return {
    lat: ORIGIN_LAT + (drone.radius / metersPerDegreeLat) * Math.sin(angle),
    lon: ORIGIN_LON + (drone.radius / metersPerDegreeLon) * Math.cos(angle),
    heading: ((angle * 180) / Math.PI + 90) % 360,
    altitude: 70 + 15 * Math.sin(elapsedSeconds / 40),
  }
}

function droneOsd(drone: SimDrone, elapsedSeconds: number) {
  const p = position(drone, elapsedSeconds)
  const percent = Math.max(
    5,
    Number((drone.batteryStart - elapsedSeconds * BATTERY_DRAIN).toFixed(1)),
  )
  return {
    latitude: p.lat,
    longitude: p.lon,
    // Like a real Matrice: `elevation` is the height above take-off, `height` an ellipsoid
    // height (about -37 m at ground level in Dhaka).
    height: Number((p.altitude - 37).toFixed(1)),
    elevation: Number(p.altitude.toFixed(1)),
    horizontal_speed: 8.5,
    vertical_speed: Number((Math.cos(elapsedSeconds / 40) * 2.5).toFixed(1)),
    attitude_head: Number(p.heading.toFixed(1)),
    attitude_pitch: -2,
    attitude_roll: 1.5,
    battery: {
      capacity_percent: percent,
      // Like a real Matrice: seconds of flight left, roughly 23 s per percent in the air.
      remain_flight_time: Math.round((percent - 5) * 23),
    },
    mode_code: 5,
    gps_number: 18,
    rtk_number: 32,
    position_state: { is_fixed: 1, quality: 5 },
  }
}

function rcOsd(drone: SimDrone, elapsedSeconds: number) {
  const p = position(drone, elapsedSeconds)
  return {
    latitude: p.lat,
    longitude: p.lon,
    height: -37,
    elevation: 0,
    attitude_head: Number(p.heading.toFixed(1)),
    battery: { capacity_percent: 91 },
    mode_code: 5,
    gps_number: 17,
  }
}

function elapsedSeconds(): number {
  return (Date.now() - startedAt) / 1000
}

async function tick(): Promise<void> {
  const t = elapsedSeconds()
  for (const drone of drones) {
    await publish(topic.osd(drone.rcSn), envelope(rcOsd(drone, t)))
    await publish(topic.osd(drone.droneSn), envelope(droneOsd(drone, t)))
  }
}

async function handleService(target: string, raw: Buffer): Promise<void> {
  const parsed = parseTopic(target)
  if (!parsed || parsed.kind !== 'services') return

  const drone = drones.find((candidate) => candidate.rcSn === parsed.sn)
  if (!drone) return

  let request: Envelope
  try {
    request = JSON.parse(raw.toString()) as Envelope
  } catch {
    return
  }

  const payload = (request.data ?? {}) as Record<string, unknown>
  const videoId = String(payload.video_id ?? '')
  let result = 0

  switch (request.method) {
    case LiveMethod.start:
      if (!videoId.startsWith(`${drone.droneSn}/`)) {
        result = 1
        break
      }
      // Pilot does not silently restart an encoder that is already publishing; a duplicate
      // start is rejected. Keep the existing publisher untouched.
      if (drone.live.has(videoId)) {
        result = SIM_ALREADY_STREAMING
        break
      }
      drone.live.set(videoId, {
        quality: Number(payload.video_quality ?? 2),
        startedAt: Date.now(),
      })
      await delay(START_DELAY_MS)
      startPublisher(videoId, String(payload.url ?? ''))
      break
    case LiveMethod.stop:
      if (!drone.live.delete(videoId)) result = 1
      stopPublisher(videoId)
      break
    case LiveMethod.setQuality: {
      const entry = drone.live.get(videoId)
      if (!entry) {
        result = 1
        break
      }
      entry.quality = Number(payload.video_quality ?? entry.quality)
      break
    }
    case LiveMethod.lensChange:
      if (!drone.live.has(videoId)) result = 1
      break
    default:
      result = 1
  }

  await publish(topic.servicesReply(drone.rcSn), {
    tid: request.tid,
    bid: request.bid ?? randomUUID(),
    timestamp: Date.now(),
    method: request.method,
    data: { result },
  })

  if (
    request.method === LiveMethod.start ||
    request.method === LiveMethod.stop ||
    request.method === LiveMethod.setQuality
  ) {
    await publish(topic.state(drone.rcSn), envelope(liveStatusData(drone)))
  }
}

/**
 * EMQX answers a denied SUBSCRIBE with QoS 128 in the SUBACK; mqtt.js reports that as a
 * granted QoS, not an error. Without this check a simulator that subscribed while the API
 * was restarting stays connected forever without receiving service calls, and every stream
 * start times out.
 */
function subscribeServices(): void {
  if (!client?.connected) return

  client.subscribe('thing/product/+/services', { qos: 1 }, (error, granted) => {
    const refused = granted?.some((entry) => entry.qos === 128) ?? false
    if (!error && !refused) {
      console.log('[sim] subscribed to service topics')
      return
    }
    console.error(
      `[sim] service subscribe failed, retrying in 5 s (${error?.message ?? 'refused'})`,
    )
    if (subscribeTimer) clearTimeout(subscribeTimer)
    subscribeTimer = setTimeout(subscribeServices, 5_000)
    subscribeTimer.unref()
  })
}

function connect(): void {
  client = mqtt.connect(MQTT_URL, {
    // Unique per process: a stale simulator left running must not kick this one off the
    // broker every time it reconnects.
    clientId: `dji-simulator-${process.pid}`,
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    clean: true,
    reconnectPeriod: 2000,
    // The API backs EMQX authentication; retry if it is briefly unavailable during a
    // restart instead of giving up on the CONNACK refusal.
    reconnectOnConnackError: true,
  })

  client.on('connect', async () => {
    console.log(`[sim] connected to ${MQTT_URL} with ${drones.length} aircraft`)

    // Subscribe first: a service call can arrive as soon as the topology is published, and
    // a stalled publish must not keep the simulator deaf to commands.
    if (subscribeTimer) {
      clearTimeout(subscribeTimer)
      subscribeTimer = undefined
    }
    subscribeServices()

    for (const drone of drones) {
      await publish(topic.status(drone.rcSn), envelope(topoData(drone, true), 'update_topo'))
      await publish(
        topic.state(drone.rcSn),
        envelope({ live_capacity: capacityData(drone), ...liveStatusData(drone) }),
      )
    }

    if (timer) clearInterval(timer)
    timer = setInterval(() => {
      tick().catch((error) => console.error('[sim] tick failed', error))
    }, RATE_MS)
  })

  client.on('message', (target, payload) => {
    handleService(target, payload).catch((error) => console.error('[sim] service failed', error))
  })

  client.on('error', (error) => console.error('[sim] mqtt error', error.message))
}

async function shutdown(): Promise<void> {
  if (timer) clearInterval(timer)
  if (subscribeTimer) clearTimeout(subscribeTimer)
  for (const videoId of [...publishers.keys()]) stopPublisher(videoId)
  if (client?.connected) {
    for (const drone of drones) {
      await publish(
        topic.status(drone.rcSn),
        envelope(topoData(drone, false), 'update_topo'),
      ).catch(() => undefined)
    }
  }
  client?.end(true, {}, () => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

connect()
