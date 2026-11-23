import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FlightTracker } from '../flights/tracker'
import type { GeoEngine } from '../geo/engine'
import type { Hub } from '../hub'
import type { AuditLog } from '../audit'
import type { Janitor } from '../janitor'
import type { MqttBridge } from '../mqtt'
import type { MqttAuthorizer } from '../mqtt-auth'
import type { VideoLibrary } from '../recordings/library'
import type { MediaExport } from '../streams/export'
import type { RecordingPlace } from '../recordings/place'
import type { RecordingManager } from '../recordings/recorder'
import type { Registry } from '../registry'
import type { Store } from '../store'
import type { StreamManager } from '../streams/manager'
import type { WhepSessions } from '../streams/whep'

export interface Deps {
  store: Store
  registry: Registry
  hub: Hub
  bridge: MqttBridge
  authorizer: MqttAuthorizer
  manager: StreamManager
  whep: WhepSessions
  /** Zone alerts and flight tracking; absent where only the plain REST API is under test. */
  geo?: GeoEngine
  flights?: FlightTracker
  /** Server-side recording; absent where only the plain REST API is under test. */
  recorder?: RecordingManager
  /** Uploaded videos and thumbnails; absent where only the plain REST API is under test. */
  library?: VideoLibrary
  /** Storage rules and figures for recordings; absent where only the plain REST API is under test. */
  janitor?: Janitor
  /** The main folder videos are kept in; absent where only the plain REST API is under test. */
  place?: RecordingPlace
  /** The audit trail; absent where only the plain REST API is under test (then nothing is recorded). */
  audit?: AuditLog
  /** Pictures and live video for a customer's own program; defaults to one reading the configured media server. */
  mediaExport?: MediaExport
}

export type RouteGuard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>

export interface RouteContext extends Deps {
  requireUser: RouteGuard
  requireViewer: RouteGuard
  requireOperator: RouteGuard
  requireAdmin: RouteGuard
  requirePilotPreauth: RouteGuard
  requirePilot: RouteGuard
}
