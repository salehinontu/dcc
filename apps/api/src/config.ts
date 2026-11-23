import { DEFAULT_BRANDING, filePrefixFor } from '@dji/protocol'
import { config as loadEnv } from 'dotenv'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url))
loadEnv({ path: rootEnv })
loadEnv({ path: '.env', override: true })

function str(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

function num(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function bounded(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max} (got "${raw}")`)
  }
  return Math.floor(value)
}

/** `RECORDING_SEGMENT_SECONDS`: 0 or unset = never cut a recording; otherwise 10 s to 24 h. */
function segmentSeconds(): number {
  const raw = process.env.RECORDING_SEGMENT_SECONDS
  if (raw === undefined || raw === '' || Number(raw) === 0) return 0
  return bounded('RECORDING_SEGMENT_SECONDS', 0, 10, 86_400)
}

/** `1`, `true`, `yes` or `on` (any case) is on; anything else is off; unset keeps the fallback. */
function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value)
}

const GIB = 1024 ** 3

// Two-step sign-in: a six-digit code from Google Authenticator or any other TOTP app. Anyone but a Pilot may switch it on
// for themselves; these roles must (they are held at a restricted screen until they do). A Pilot signs in on a
// controller, where there is nowhere to type a code, so it never takes part.
const MFA_ROLES = ['developer', 'admin', 'subadmin'] as const
const mfaRequiredRoles = str('MFA_REQUIRED_ROLES', '')
  .split(',')
  .map((role) => role.trim().toLowerCase())
  .filter(Boolean)
for (const role of mfaRequiredRoles) {
  if (!(MFA_ROLES as readonly string[]).includes(role))
    throw new Error(
      `MFA_REQUIRED_ROLES may list developer, admin and subadmin (got "${role}"); a drone operator signs in on a controller and cannot type a code`,
    )
}

// Alerts about the aircraft itself. 0 switches a battery rule off. An aircraft is judged only while it is flying.
const batteryLowPct = bounded('ALERT_BATTERY_LOW_PERCENT', 30, 0, 100)
const batteryCriticalPct = bounded('ALERT_BATTERY_CRITICAL_PERCENT', 15, 0, 100)
if (batteryLowPct > 0 && batteryCriticalPct >= batteryLowPct)
  throw new Error(
    `ALERT_BATTERY_CRITICAL_PERCENT (${batteryCriticalPct}) must be lower than ALERT_BATTERY_LOW_PERCENT (${batteryLowPct})`,
  )

function hexColor(name: string, fallback: string): string {
  const value = str(name, fallback)
  if (!/^#[0-9a-fA-F]{6}$/.test(value))
    throw new Error(`${name} must be a #rrggbb colour (got "${value}")`)
  return value.toLowerCase()
}

// Branding: one image serves every customer; each installation names and colours itself here.
const brandName = str('BRAND_NAME', DEFAULT_BRANDING.name)
const brandFilePrefix = str('BRAND_FILE_PREFIX', filePrefixFor(brandName))
if (!/^[A-Za-z0-9_-]{1,32}$/.test(brandFilePrefix)) {
  throw new Error('BRAND_FILE_PREFIX may only use letters, digits, - and _ (at most 32)')
}

const whepInternalTemplate = str(
  'MEDIA_WHEP_INTERNAL_TEMPLATE',
  'http://127.0.0.1:8889/live/{key}/whep',
)
if (!/^https?:\/\//.test(whepInternalTemplate)) {
  throw new Error('MEDIA_WHEP_INTERNAL_TEMPLATE must start with http:// or https://')
}
if (!whepInternalTemplate.includes('{key}')) {
  throw new Error('MEDIA_WHEP_INTERNAL_TEMPLATE must contain a {key} placeholder')
}

// Where the server recorder reads a live stream from: the media server, on the same host or
// compose network, never through the internet. Also never sent to a browser.
const rtmpInternalTemplate = str('MEDIA_RTMP_INTERNAL_TEMPLATE', 'rtmp://127.0.0.1:1935/live/{key}')
if (!/^rtmp:\/\//.test(rtmpInternalTemplate)) {
  throw new Error('MEDIA_RTMP_INTERNAL_TEMPLATE must start with rtmp://')
}
if (!rtmpInternalTemplate.includes('{key}')) {
  throw new Error('MEDIA_RTMP_INTERNAL_TEMPLATE must contain a {key} placeholder')
}

export const config = {
  port: num('PORT', 3000),
  publicHost: str('PUBLIC_HOST', 'localhost'),
  /**
   * Which hops may tell the API who the client is (X-Forwarded-For). The default trusts loopback and private networks,
   * which is where Nginx sits (the compose network); the client address is then the last one Nginx appended, so the
   * rate limits, the logs and the lock-out see the real visitor, not Nginx. Anything that reaches the API directly from a
   * public address is believed as it is. `false` turns it off; a list of addresses or CIDRs replaces the default.
   */
  trustProxy: str('TRUST_PROXY', 'loopback,uniquelocal'),
  /** Wrong passwords in a row before an account's sign-in is locked, and for how long. */
  loginMaxFailures: num('LOGIN_MAX_FAILURES', 10),
  loginLockSeconds: num('LOGIN_LOCK_MINUTES', 15) * 60,
  jwtSecret: str('JWT_SECRET', 'dev-secret-change-me'),
  databaseUrl: process.env.DATABASE_URL,
  dataDir: str('DATA_DIR', '.data'),

  // Captured feed stills. Docker mounts a named volume here so they survive rebuilds.
  screenshotDir: str('SCREENSHOT_DIR', `${str('DATA_DIR', '.data')}/screenshots`),
  screenshotMaxBytes: num('SCREENSHOT_MAX_BYTES', 8 * 1024 * 1024),
  // Screenshot file names use operators' local time.
  timeZone: str('APP_TIME_ZONE', 'Asia/Dhaka'),

  // People counting on stills: a YOLOX ONNX model run on this server (`pnpm models:fetch`).
  // Two-stage count: a quick pass with the small model answers in seconds, then the large
  // model refines it in the background. Either model file may be absent.
  peopleModelPath: str('PEOPLE_MODEL_PATH', `${str('DATA_DIR', '.data')}/models/yolox_l.onnx`),
  peopleQuickModelPath: str(
    'PEOPLE_QUICK_MODEL_PATH',
    `${str('DATA_DIR', '.data')}/models/yolox_s.onnx`,
  ),
  // The small model scores far-away people low, so it needs a higher bar to count anyone.
  peopleQuickCountScore: bounded('PEOPLE_QUICK_COUNT_SCORE_PERCENT', 50, 5, 95) / 100,
  // Source-pixel size of the quick pass's upscaled tiles. Larger is faster and sees less.
  peopleQuickTile: bounded('PEOPLE_QUICK_TILE', 448, 256, 640),
  // ONNX Runtime threads per model; default is every core, since runs are serialized.
  peopleThreads: bounded('PEOPLE_THREADS', availableParallelism(), 1, 64),
  // Detections at or above the count score are counted; those between the minimum and the
  // count score are shown as possible people for the operator to accept or ignore. Lower
  // values find more people and more false marks.
  peopleMinScore: bounded('PEOPLE_MIN_SCORE_PERCENT', 20, 5, 95) / 100,
  peopleCountScore: bounded('PEOPLE_COUNT_SCORE_PERCENT', 30, 5, 95) / 100,
  // Start counting as soon as a still is captured, so the result is ready when an operator
  // opens it. Skipped while this many counts are already waiting.
  peopleAutoCount: process.env.PEOPLE_AUTO_COUNT !== '0',
  peopleAutoMaxQueue: bounded('PEOPLE_AUTO_MAX_QUEUE', 4, 1, 50),

  // Development only: the simulator publishes topology like a controller, so it has to be
  // enrolled. Set by tools/dev/start.mjs and the dev Compose file; never in production.
  seedSimulator: process.env.SEED_SIMULATOR === '1',

  mqttUrl: str('MQTT_URL', 'mqtt://127.0.0.1:1883'),
  // Pilot 2 requires a scheme: ssl://host:8883 for TLS, tcp://host:1883 for plain MQTT.
  mqttPublicHost: str('MQTT_PUBLIC_HOST', 'tcp://localhost:1883'),
  mqttUsername: str('MQTT_USERNAME', 'dji-server'),
  mqttPassword: str('MQTT_PASSWORD', 'dji-server'),
  mqttCredentialTtlHours: num('MQTT_CREDENTIAL_TTL_HOURS', 168),

  // Same-origin deployments do not need CORS at all; the dev server proxies /api.
  // Set CORS_ORIGINS to an empty string in production.
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Video and pictures for a customer's own program (an AI tool): see `streams/export.ts`.
  apiAccess: {
    /** How many live video feeds may be handed out at once (each is one read of the media server, copied, not re-encoded). */
    liveMax: bounded('API_LIVE_MAX', 8, 1, 100),
    /** How long a request waits for a drone that is not streaming yet before it is told to try again. */
    waitSeconds: bounded('API_STREAM_WAIT_SECONDS', 20, 1, 120),
  },

  alerts: {
    /** Raise an alert when an aircraft that is flying stops reporting or drops off its controller. */
    linkLost: flag('ALERT_LINK_LOST', true),
    /** A warning at or below this battery percentage, a critical alert at or below the second one. */
    batteryLowPct,
    batteryCriticalPct,
    /** Also critical when the aircraft's own estimate of flight time left falls to this many seconds. */
    remainCriticalSeconds: bounded('ALERT_REMAIN_CRITICAL_SECONDS', 120, 0, 3600),
  },

  mfa: {
    requiredRoles: [...new Set(mfaRequiredRoles)],
    /** Shown beside the account in the authenticator app. */
    issuer: brandName,
    /**
     * Seals each account's shared secret in the database, so a copy of the database (a backup) alone yields no codes.
     * Empty derives the key from JWT_SECRET; set it to keep the secrets readable if JWT_SECRET is ever rotated.
     */
    encryptionKey: str('TOTP_ENCRYPTION_KEY', ''),
    /** This many wrong codes in a row lock the account's second step for `lockSeconds`. */
    maxFailures: 5,
    lockSeconds: 300,
  },

  brand: {
    name: brandName,
    subtitle: str('BRAND_SUBTITLE', DEFAULT_BRANDING.subtitle),
    company: str('BRAND_COMPANY', DEFAULT_BRANDING.company),
    tagline: str('BRAND_TAGLINE', DEFAULT_BRANDING.tagline),
    filePrefix: brandFilePrefix,
    primaryColor: hexColor('BRAND_PRIMARY_COLOR', DEFAULT_BRANDING.primaryColor),
    accentColor: hexColor('BRAND_ACCENT_COLOR', DEFAULT_BRANDING.accentColor),
    /** A PNG, JPEG, WebP or SVG file; empty keeps the built-in mark. */
    logoPath: str('BRAND_LOGO_PATH', ''),
  },

  dji: {
    appId: str('DJI_APP_ID', ''),
    appKey: str('DJI_APP_KEY', ''),
    license: str('DJI_APP_LICENSE', ''),
    platformName: str('DJI_PLATFORM_NAME', brandName),
    workspaceId: str('DJI_WORKSPACE_ID', '00000000-0000-4000-8000-000000000001'),
    workspaceName: str('DJI_WORKSPACE_NAME', 'Demo Workspace'),
  },

  media: {
    rtmpHost: str('MEDIA_RTMP_HOST', 'localhost:1935'),
    // The API's WHEP proxy talks to this address. It is never sent to a browser.
    whepInternalTemplate,
    rtmpInternalTemplate,
  },

  // Video the server records itself (see packages/protocol/src/recordings.ts). Docker mounts a
  // named volume here; recordings are large, so size the disk before turning many on.
  recordings: {
    dir: str('RECORDING_DIR', `${str('DATA_DIR', '.data')}/recordings`),
    // Set by a Docker install, where the folder is whatever the compose file mounts at that path: choosing
    // another one in the app would write inside the container, and lose the videos when it is recreated.
    dirLocked: flag('RECORDING_DIR_LOCKED', false),
    // The storage areas a Developer may choose a folder in (see `parseStorageRoots`); empty = anywhere on the disk.
    roots: str('RECORDING_ROOTS', ''),
    ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: str('FFPROBE_PATH', 'ffprobe'),
    // 0 (the default): no time limit. A recording is one file that runs until the drone's feed ends (the drone
    // is switched off, or the stream stops). A number of seconds (10 or more) cuts a long recording into clips of
    // about that length instead.
    segmentSeconds: segmentSeconds(),
    // A recording whose feed has been gone this long ends by itself.
    gapSeconds: bounded('RECORDING_GAP_SECONDS', 300, 10, 3600),
    // Recordings running at once. A copy of a stream is cheap, but each one writes to disk.
    maxActive: bounded('RECORDING_MAX_ACTIVE', 100, 1, 500),
    // Automatic recording: every drone with no choice of its own records each time it connects when
    // this is on. A drone can be set on or off by itself in the Recordings screen either way.
    autoDefault: flag('RECORDING_AUTO_DEFAULT', false),
    // The server deletes only AUTOMATIC clips by itself (a manual recording or an upload is kept until
    // a person deletes it). Older than this many days goes; 0 keeps them until the room is needed.
    retentionDays: bounded('RECORDING_RETENTION_DAYS', 30, 0, 3650),
    // The most the recordings may use, in GB; the oldest automatic clips go first. 0: no limit but the floor.
    maxBytes: Math.round(num('RECORDING_MAX_GB', 0) * GIB),
    // The floor: if free disk falls below this the oldest automatic clips are deleted, and if that is
    // not enough recording pauses (and resumes by itself) so the disk never fills and breaks the database.
    minFreeBytes: Math.round(num('RECORDING_MIN_FREE_GB', 20) * GIB),
    cleanupSeconds: bounded('RECORDING_CLEANUP_SECONDS', 60, 5, 3600),
    // The largest file one upload may be. The reverse proxy must allow at least this much.
    uploadMaxBytes: num('RECORDING_UPLOAD_MAX_BYTES', 4 * 1024 * 1024 * 1024),
  },

  // What a drone connected for weeks writes to the database. A drone standing on the ground sends a
  // reading every second or two and nothing in it changes, so it is stored only this often; one that
  // is flying is stored in full, which is what flight replay needs.
  telemetry: {
    idleIntervalSeconds: bounded('TELEMETRY_IDLE_INTERVAL_SECONDS', 30, 1, 3600),
    // Readings older than this are deleted. 0 keeps them: flight replay reads them.
    retentionDays: bounded('TELEMETRY_RETENTION_DAYS', 0, 0, 36500),
    // The raw MQTT log (events, requests, state and messages that could not be read) is what real
    // aircraft captures are studied from, and it grows slowly, so nothing is deleted unless this is set.
    mqttLogRetentionDays: bounded('MQTT_LOG_RETENTION_DAYS', 0, 0, 3650),
  },

  stream: {
    lingerSeconds: bounded('STREAM_LINGER_SECONDS', 60, 0, 600),
    startDeadlineSeconds: bounded('STREAM_START_DEADLINE_SECONDS', 60, 15, 300),
    replyTimeoutMs: bounded('STREAM_REPLY_TIMEOUT_MS', 30_000, 5_000, 120_000),
  },
} as const

if (config.peopleCountScore < config.peopleMinScore) {
  throw new Error('PEOPLE_COUNT_SCORE_PERCENT must not be below PEOPLE_MIN_SCORE_PERCENT')
}

export function rtmpUrl(streamKey: string): string {
  return `rtmp://${config.media.rtmpHost}/live/${streamKey}`
}
