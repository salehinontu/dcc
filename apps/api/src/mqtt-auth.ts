import { timingSafeEqual } from 'node:crypto'
import { can } from '@dji/protocol'
import { publicUser, verifyPassword } from './auth'
import { config } from './config'
import type { Store } from './store'

/**
 * EMQX asks this class two questions over the internal network:
 *   - may this username/password connect?
 *   - may this user publish or subscribe to this topic?
 *
 * A controller is issued credentials bound to its gateway serial number. It may publish
 * its own state and its own aircraft's state, and subscribe only to service and reply
 * topics for itself and its linked aircraft. Nothing else is allowed.
 */

const GATEWAY_PUBLISH = new Set([
  'osd',
  'state',
  'events',
  'events_reply',
  'requests',
  'requests_reply',
  'services_reply',
  'property/set_reply',
  'drc/up',
])

// Pilot 2 subscribes to events_reply during start-up; denying it makes the whole
// telemetry connection fail even though authentication succeeded.
const GATEWAY_SUBSCRIBE = new Set([
  'services',
  'requests_reply',
  'events_reply',
  'state_reply',
  'property/set',
  'drc/down',
])

const AIRCRAFT_PUBLISH = new Set([
  'osd',
  'state',
  'events',
  'events_reply',
  'requests',
  'requests_reply',
  'services_reply',
  'property/set_reply',
  'drc/up',
])

// Pilot 2 also subscribes on the aircraft serial (including Matrice 4T services).
// Only grant these topics after checking the stored controller/aircraft relationship.
const AIRCRAFT_SUBSCRIBE = GATEWAY_SUBSCRIBE

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export class MqttAuthorizer {
  constructor(private readonly store: Store) {}

  async authenticate(username: string, password: string): Promise<boolean> {
    if (!username) return false

    if (safeEqual(username, config.mqttUsername)) {
      return safeEqual(password, config.mqttPassword)
    }

    const credential = await this.store.findGatewayCredentialByUsername(username)
    if (!credential || credential.revoked) return false
    if (credential.user_id) {
      const owner = await this.store.findUserById(credential.user_id)
      if (
        !owner ||
        owner.disabled ||
        owner.must_change_password ||
        owner.session_version !== credential.session_version ||
        !can(publicUser(owner), 'drones.bind')
      )
        return false
    }
    if (credential.expires_at && new Date(credential.expires_at).getTime() < Date.now())
      return false

    // Credentials alone are not enough: an admin must have approved the controller serial.
    // A pending or rejected controller never gets a session, even with an old password.
    if (!(await this.store.isControllerApproved(credential.gateway_sn))) return false

    return verifyPassword(credential.password_hash, password)
  }

  async authorize(username: string, topic: string, action: string): Promise<boolean> {
    if (safeEqual(username, config.mqttUsername)) return true

    const credential = await this.store.findGatewayCredentialByUsername(username)
    if (!credential || credential.revoked) return false
    if (credential.user_id) {
      const owner = await this.store.findUserById(credential.user_id)
      if (
        !owner ||
        owner.disabled ||
        owner.must_change_password ||
        owner.session_version !== credential.session_version ||
        !can(publicUser(owner), 'drones.bind')
      )
        return false
    }
    if (credential.expires_at && new Date(credential.expires_at).getTime() < Date.now())
      return false

    // Checked per operation as well as at CONNECT: a controller rejected while its session
    // is open loses its topics on the next publish or subscribe.
    if (!(await this.store.isControllerApproved(credential.gateway_sn))) return false

    const isPublish = action === 'publish' || action === 'pub'
    const isSubscribe = action === 'subscribe' || action === 'sub'
    if (!isPublish && !isSubscribe) return false

    const parts = topic.split('/')
    if (parts.length < 4) return false

    const root = parts[0]
    const product = parts[1]
    const sn = parts[2]
    if (!root || !product || !sn) return false
    const rest = parts.slice(3).join('/')

    if (root === 'sys' && product === 'product' && sn === credential.gateway_sn) {
      if (rest === 'status' && isPublish) return true
      if (rest === 'status_reply' && isSubscribe) return true
      if (rest === 'network/probe' && isSubscribe) return true
      return false
    }

    if (
      root === 'sys' &&
      product === 'product' &&
      isSubscribe &&
      (rest === 'network/probe' || rest === 'status_reply')
    ) {
      const aircraft = await this.store.aircraftSnsForGateway(credential.gateway_sn)
      if (!aircraft.includes(sn)) return false
      if (credential.user_id) {
        const owner = await this.store.findUserById(credential.user_id)
        if (!owner || !can(publicUser(owner), 'drones.bind', sn)) return false
      }
      return true
    }

    if (root === 'thing' && product === 'product') {
      if (sn === credential.gateway_sn) {
        if (isPublish) return GATEWAY_PUBLISH.has(rest)
        return GATEWAY_SUBSCRIBE.has(rest)
      }

      const aircraft = await this.store.aircraftSnsForGateway(credential.gateway_sn)
      if (aircraft.includes(sn)) {
        // A disabled or deleted aircraft is refused at the broker, not just dropped by the
        // API, so "stopped" means the controller cannot publish for it at all. The gateway's
        // own topics above stay open: it must still be able to announce topology, which is
        // how the aircraft shows up again after a re-enable.
        if (await this.store.deviceUnavailable(sn)) return false
        if (credential.user_id) {
          const owner = await this.store.findUserById(credential.user_id)
          if (!owner || !can(publicUser(owner), 'drones.bind', sn)) return false
        }
        if (isPublish) return AIRCRAFT_PUBLISH.has(rest)
        return AIRCRAFT_SUBSCRIBE.has(rest)
      }
    }

    return false
  }
}
