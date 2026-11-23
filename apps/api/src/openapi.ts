import { API_TOKEN_PREFIX } from '@dji/protocol'

/**
 * The read-only API a customer's own program uses, described as OpenAPI 3.0 so a generator, Postman or an AI tool's
 * own client can read it. It lists exactly the routes an API token may call (`apiTokenRoutes` in `http/access.ts`):
 * keep the two in step. The same routes work with a signed-in session in a browser; a token is the way for a program.
 */

type Obj = Record<string, unknown>

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const nullable = (schema: Obj) => ({ ...schema, nullable: true })
const str = { type: 'string' }
const int = { type: 'integer' }
const num = { type: 'number' }
const bool = { type: 'boolean' }
const time = { type: 'string', format: 'date-time' }
const obj = (properties: Obj, required: string[] = []): Obj => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
})
const list = (items: Obj) => ({ type: 'array', items })

const json = (schema: Obj, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
})

const param = (name: string, where: 'path' | 'query', schema: Obj, description: string) => ({
  name,
  in: where,
  required: where === 'path',
  description,
  schema,
})

const sn = param('sn', 'path', str, 'The drone’s serial number, as listed by GET /api/devices.')
const id = (what: string) => param('id', 'path', { type: 'string' }, `The ${what}’s id.`)
const from = param('from', 'query', time, 'Only from this time (ISO 8601 with an offset).')
const to = param('to', 'query', time, 'Only up to this time.')
const before = param(
  'before',
  'query',
  time,
  'Only older than this time: pass the oldest time of the page you have to get the next one.',
)
const limit = (max: number, def: number) =>
  param('limit', 'query', { type: 'integer', minimum: 1, maximum: max, default: def }, 'Page size.')
const deviceSn = param('deviceSn', 'query', str, 'Only this drone.')
const minutes = (max: number, def: number) =>
  param(
    'minutes',
    'query',
    { type: 'integer', minimum: 1, maximum: max, default: def },
    'How far back, in minutes.',
  )

const errors = {
  '401': json(ref('Error'), 'No token, a wrong one, or one that was revoked or has expired.'),
  '403': json(
    ref('Error'),
    'The token may not read this (a token is read-only and limited to its drones).',
  ),
}

export function buildOpenApi(serverUrl: string, version: string): Obj {
  const get = (summary: string, description: string, parameters: Obj[], responses: Obj): Obj => ({
    get: {
      summary,
      description,
      parameters,
      responses: { ...responses, ...errors },
      security: [{ bearerAuth: [] }],
    },
  })

  return {
    openapi: '3.0.3',
    info: {
      title: 'Drone Fleet read-only API',
      version,
      description:
        'Read the fleet’s data and video from your own program, for example an AI analysis tool. ' +
        'Everything here is read-only. Send your API token in the `Authorization: Bearer` header; an administrator ' +
        'makes it on the API access screen and chooses which drones it may read. Times are ISO 8601 (UTC). ' +
        'Lists are newest first and paged with `limit` and `before`.',
    },
    servers: [{ url: serverUrl }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Drones and telemetry' },
      { name: 'Video' },
      { name: 'Flights and alerts' },
      { name: 'Pictures' },
      { name: 'Recordings' },
      { name: 'Account' },
    ],
    paths: {
      '/api/v1/whoami': {
        ...get(
          'Who am I',
          'What this token is, when it expires, and which drones it may read. Call it first.',
          [],
          {
            '200': json(ref('Whoami')),
          },
        ),
      },
      '/api/devices': {
        ...get(
          'List drones',
          'Every drone this token may read, with its state and its latest telemetry sample.',
          [],
          { '200': json(obj({ devices: list(ref('Device')) })) },
        ),
      },
      '/api/devices/{sn}/telemetry': {
        ...get(
          'Telemetry history',
          'Stored telemetry samples (about one a second while flying), oldest first.',
          [sn, minutes(1440, 30)],
          { '200': json(obj({ samples: list(ref('TelemetryRow')) })) },
        ),
      },
      '/api/devices/{sn}/trail': {
        ...get(
          'Recent path',
          'The positions of the last few minutes, for drawing a trail.',
          [sn, minutes(240, 5)],
          {
            '200': json(
              obj({
                points: list(obj({ ts: time, lat: num, lon: num, alt: nullable(num) })),
              }),
            ),
          },
        ),
      },
      '/api/streams': {
        ...get('Video feeds', 'Which drones are streaming now.', [], {
          '200': json(obj({ streams: list(ref('Stream')) })),
        }),
      },
      '/api/devices/{sn}/frame': {
        ...get(
          'One picture from the live video',
          'A JPEG of what the drone sees now. If the drone is not streaming the server asks it to and waits up to ' +
            'about 20 seconds; if it still is not, the answer is 503 with `Retry-After`. Ask as often as you need up ' +
            'to about 2 a second: pictures taken in the same second are shared. Header `X-Frame-Time` says when the ' +
            'picture was taken.',
          [sn],
          {
            '200': {
              description: 'A JPEG picture.',
              content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } },
            },
            '503': json(
              ref('Error'),
              'The drone is not sending video yet: try again after `Retry-After` seconds.',
            ),
          },
        ),
      },
      '/api/devices/{sn}/live': {
        ...get(
          'The live video',
          'The drone’s live video as MPEG-TS over HTTP, H.264 or H.265 exactly as the drone sends it (not re-encoded), ' +
            'video only. Open it like a stream URL: `ffmpeg -i <url>`, VLC, GStreamer, or OpenCV through ffmpeg; send ' +
            'the Authorization header (ffmpeg: `-headers "Authorization: Bearer ..."`). It ends if the drone’s stream ' +
            'restarts; open it again. Several programs may watch at once up to the server’s limit (429 beyond it).',
          [sn],
          {
            '200': {
              description: 'A never-ending MPEG-TS video stream.',
              content: { 'video/mp2t': { schema: { type: 'string', format: 'binary' } } },
            },
            '429': json(ref('Error'), 'The server is at its live feed limit.'),
            '503': json(
              ref('Error'),
              'The drone is not sending video yet: try again after `Retry-After` seconds.',
            ),
          },
        ),
      },
      '/api/flights': {
        ...get(
          'List flights',
          'Take-off to landing, with distance, duration, top speed and lowest battery.',
          [deviceSn, from, to, before, limit(100, 30)],
          { '200': json(obj({ flights: list(ref('Flight')) })) },
        ),
      },
      '/api/flights/{id}': {
        ...get(
          'One flight with its path',
          'The flight, its path (thinned to at most 1500 points) and its alerts.',
          [id('flight')],
          { '200': json(ref('FlightDetail')) },
        ),
      },
      '/api/alerts': {
        ...get(
          'Alerts',
          'Zone alerts (no-fly, geofence) and alerts about the drone itself (contact lost, low battery).',
          [
            deviceSn,
            param(
              'active',
              'query',
              { type: 'string', enum: ['0', '1'] },
              '`1`: only the alerts still open.',
            ),
            before,
            limit(200, 50),
          ],
          { '200': json(obj({ alerts: list(ref('Alert')) })) },
        ),
      },
      '/api/zones': {
        ...get(
          'No-fly zones and geofences',
          'The zones drawn for this installation, with their shapes.',
          [],
          {
            '200': json(obj({ zones: list(ref('Zone')) })),
          },
        ),
      },
      '/api/screenshots': {
        ...get(
          'List pictures',
          'Stills captured by operators, with the number of people counted on them, newest first.',
          [deviceSn, from, to, before, limit(100, 48)],
          { '200': json(obj({ screenshots: list(ref('Screenshot')) })) },
        ),
      },
      '/api/screenshots/{id}': {
        ...get(
          'One picture’s details',
          'Where and when it was taken and what was counted on it.',
          [id('screenshot')],
          {
            '200': json(obj({ screenshot: ref('Screenshot') })),
          },
        ),
      },
      '/api/screenshots/{id}/image': {
        ...get('The picture itself', 'The full-size image, JPEG or PNG.', [id('screenshot')], {
          '200': {
            description: 'The image.',
            content: {
              'image/jpeg': { schema: { type: 'string', format: 'binary' } },
              'image/png': { schema: { type: 'string', format: 'binary' } },
            },
          },
        }),
      },
      '/api/screenshots/{id}/thumbnail': {
        ...get('A small copy of the picture', 'A 640-pixel-wide JPEG.', [id('screenshot')], {
          '200': {
            description: 'A JPEG thumbnail.',
            content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } },
          },
        }),
      },
      '/api/screenshots/{id}/people': {
        ...get(
          'People found in a picture',
          'The people the server’s own detector found, as fractions of the frame, and the counts.',
          [id('screenshot')],
          { '200': json(obj({ people: ref('PeopleResult') })) },
        ),
      },
      '/api/recordings': {
        ...get(
          'List recorded video',
          'Clips the server recorded from live feeds, and videos uploaded to it.',
          [
            deviceSn,
            param('q', 'query', str, 'Words from the name, folder, a tag or the note.'),
            param('tag', 'query', str, 'Only videos with this tag (any case).'),
            from,
            to,
            limit(200, 50),
            param(
              'offset',
              'query',
              { type: 'integer', minimum: 0, default: 0 },
              'How many to skip.',
            ),
          ],
          { '200': json(obj({ recordings: list(ref('Recording')), total: int })) },
        ),
      },
      '/api/recordings/tags': {
        ...get(
          'Tags in use',
          'The tags people put on videos, with how many videos carry each.',
          [],
          {
            '200': json(obj({ tags: list(obj({ name: str, count: int })) })),
          },
        ),
      },
      '/api/recordings/{id}': {
        ...get(
          'One recording’s details',
          'Duration, size, drone and when it was recorded.',
          [id('recording')],
          {
            '200': json(obj({ recording: ref('Recording') })),
          },
        ),
      },
      '/api/recordings/{id}/video': {
        ...get(
          'The recorded video',
          'The video file (MP4 or WebM). It supports HTTP `Range`, so a program can read the middle of it.',
          [id('recording')],
          {
            '200': {
              description: 'The whole file.',
              content: { 'video/mp4': { schema: { type: 'string', format: 'binary' } } },
            },
            '206': { description: 'The part of the file that was asked for (`Range`).' },
          },
        ),
      },
      '/api/recordings/{id}/thumbnail': {
        ...get('A still from the recording', 'A JPEG.', [id('recording')], {
          '200': {
            description: 'A JPEG.',
            content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } },
          },
        }),
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: `An API token (it starts with \`${API_TOKEN_PREFIX}\`), made on the API access screen.`,
        },
      },
      schemas: {
        Error: obj({ error: str, message: str }, ['error']),
        Whoami: obj(
          {
            kind: { type: 'string', enum: ['token', 'session'] },
            name: nullable(str),
            expiresAt: nullable(time),
            drones: list(obj({ sn: str, name: str })),
            permissions: list(str),
          },
          ['kind', 'drones'],
        ),
        Telemetry: obj({
          sn: str,
          ts: { type: 'integer', description: 'Milliseconds since 1970.' },
          lat: nullable(num),
          lon: nullable(num),
          altRel: nullable({ ...num, description: 'Metres above the take-off point.' }),
          altAbs: nullable(num),
          heading: nullable({ ...num, description: 'Degrees.' }),
          speedH: nullable({ ...num, description: 'Horizontal speed, m/s.' }),
          speedV: nullable(num),
          batteryPct: nullable(num),
          remainFlightS: nullable({
            ...int,
            description: 'Seconds of flight the aircraft itself estimates are left.',
          }),
          mode: nullable(int),
          gnss: nullable(int),
          rtk: nullable(int),
        }),
        TelemetryRow: obj({
          ts: time,
          lat: nullable(num),
          lon: nullable(num),
          alt_rel: nullable(num),
          speed_h: nullable(num),
          battery_pct: nullable(num),
        }),
        Device: obj(
          {
            sn: str,
            gatewaySn: nullable(str),
            model: nullable(str),
            displayName: nullable(str),
            label: nullable(str),
            videoOnly: bool,
            color: str,
            online: bool,
            lastSeenAt: nullable(time),
            telemetry: nullable(ref('Telemetry')),
            cameras: list(
              obj({ cameraIndex: str, videos: list(obj({ videoIndex: str, videoType: str })) }),
            ),
          },
          ['sn', 'online'],
        ),
        Stream: obj({
          id: str,
          deviceSn: str,
          videoId: str,
          phase: { type: 'string', enum: ['starting', 'live', 'stopped', 'error'] },
          quality: int,
          error: nullable(str),
          startedAt: time,
          updatedAt: time,
        }),
        Flight: obj({
          id: str,
          deviceSn: str,
          deviceLabel: nullable(str),
          operatorEmail: nullable(str),
          startedAt: time,
          endedAt: nullable(time),
          status: { type: 'string', enum: ['active', 'completed'] },
          durationS: int,
          distanceM: num,
          maxAltM: nullable(num),
          maxSpeedMs: nullable(num),
          avgSpeedMs: nullable(num),
          minBatteryPct: nullable(num),
          startLat: nullable(num),
          startLon: nullable(num),
          endLat: nullable(num),
          endLon: nullable(num),
          maxRangeM: num,
          alertCount: int,
        }),
        FlightDetail: obj({
          flight: ref('Flight'),
          points: list(
            obj({
              ts: int,
              lat: num,
              lon: num,
              alt: nullable(num),
              speed: nullable(num),
              heading: nullable(num),
              battery: nullable(num),
            }),
          ),
          alerts: list(ref('Alert')),
        }),
        Alert: obj({
          id: str,
          kind: {
            type: 'string',
            enum: [
              'no_fly_warning',
              'no_fly_breach',
              'geofence_exit',
              'link_lost',
              'battery_low',
              'battery_critical',
            ],
          },
          severity: { type: 'string', enum: ['warning', 'critical'] },
          deviceSn: str,
          deviceLabel: nullable(str),
          zoneId: nullable(str),
          zoneName: nullable(str),
          flightId: nullable(str),
          lat: nullable(num),
          lon: nullable(num),
          altRel: nullable(num),
          distanceM: nullable({
            ...num,
            description:
              'To the zone edge, negative inside; null for an alert about the drone itself.',
          }),
          message: str,
          raisedAt: time,
          clearedAt: nullable(time),
          acknowledgedAt: nullable(time),
        }),
        Zone: obj({
          id: str,
          kind: { type: 'string', enum: ['no_fly', 'geofence'] },
          name: str,
          category: str,
          shape: {
            type: 'object',
            description:
              'A circle (`center`, `radiusM`) or a polygon (`rings`), in longitude/latitude.',
          },
          bufferM: num,
          enabled: bool,
          deviceSns: list(str),
          notes: str,
          source: { type: 'string', enum: ['builtin', 'custom'] },
          updatedAt: time,
        }),
        Screenshot: obj({
          id: str,
          deviceSn: str,
          deviceLabel: nullable(str),
          filename: str,
          contentType: str,
          sizeBytes: int,
          width: nullable(int),
          height: nullable(int),
          capturedAt: time,
          lat: nullable(num),
          lon: nullable(num),
          altRel: nullable(num),
          people: nullable(obj({ aiCount: int, verifiedCount: nullable(int) })),
        }),
        PeopleResult: {
          type: 'object',
          description:
            'The detector’s result: counts and the people found, as fractions of the frame.',
        },
        Recording: obj({
          id: str,
          sessionId: str,
          source: { type: 'string', enum: ['drone', 'upload'] },
          deviceSn: nullable(str),
          deviceName: nullable(str),
          title: nullable(str),
          state: str,
          startedAt: time,
          endedAt: time,
          durationS: num,
          sizeBytes: int,
          filename: str,
          tags: list(str),
          note: nullable(str),
        }),
      },
    },
  }
}
