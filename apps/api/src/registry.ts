import { EventEmitter } from 'node:events'
import {
  camerasFor,
  DRONE_COLORS,
  isOnlineTopo,
  liveCapacitySchema,
  liveStatusEntries,
  osdSchema,
  toTelemetrySample,
  topoSchema,
  type CameraSummary,
  type DeviceSummary,
  type Envelope,
  type LiveCapacity,
  type TelemetrySample,
  type TopicKind,
} from '@dji/protocol'
import { config } from './config'
import { iso, type Store } from './store'

export interface DeviceStatus {
  sn: string
  gatewaySn: string | null
  online: boolean
  lastSeenAt: string | null
}

/**
 * A drone standing on the ground sends a reading every second or two and nothing in it changes. Kept
 * in full, a drone left connected for weeks would write gigabytes a day for nothing, so an idle reading
 * is stored at most every `idleMs`; a drone in the air, or one that does not say its height, is stored
 * in full, because flight replay needs every reading of a flight.
 */
export function shouldStoreSample(
  sample: Pick<TelemetrySample, 'altRel' | 'speedH' | 'ts'>,
  lastStoredAt: number | undefined,
  idleMs: number,
): boolean {
  const idle = sample.altRel != null && sample.altRel < 1 && (sample.speedH ?? 0) < 0.5
  if (!idle) return true
  return (
    lastStoredAt === undefined || sample.ts - lastStoredAt >= idleMs || sample.ts < lastStoredAt
  )
}

export class Registry {
  readonly events = new EventEmitter()

  /** When each drone's last reading was stored, for `shouldStoreSample`. */
  private readonly lastStored = new Map<string, number>()

  private readonly knownDevices = new Set<string>()
  private readonly knownGateways = new Set<string>()

  constructor(
    private readonly store: Store,
    private readonly workspaceId: string,
  ) {}

  async init(): Promise<void> {
    for (const sn of await this.store.allDeviceSns()) this.knownDevices.add(sn)
    for (const sn of await this.store.allGatewaySns()) this.knownGateways.add(sn)
  }

  async list(): Promise<DeviceSummary[]> {
    const rows = await this.store.listDevices()
    return rows.map((row) => ({
      sn: row.sn,
      gatewaySn: row.gateway_sn,
      model: row.model,
      displayName: row.display_name,
      label: row.label,
      videoOnly: row.video_only,
      color: row.color ?? DRONE_COLORS[0],
      online: row.online,
      lastSeenAt: iso(row.last_seen_at),
      telemetry: row.sample_ts
        ? {
            sn: row.sn,
            ts: new Date(row.sample_ts).getTime(),
            lat: row.lat,
            lon: row.lon,
            altRel: row.alt_rel,
            altAbs: row.alt_abs,
            heading: row.heading,
            speedH: row.speed_h,
            speedV: row.speed_v,
            batteryPct: row.battery_pct,
            remainFlightS: row.remain_flight_s,
            mode: row.mode,
            gnss: row.gnss,
            rtk: row.rtk,
            raw: {},
          }
        : null,
      cameras: row.cameras ?? [],
    }))
  }

  async handle(kind: TopicKind, sn: string, env: Envelope, rawTopic: string): Promise<void> {
    const deviceGateway = kind === 'status' ? null : await this.store.deviceGatewaySn(sn)
    const gatewaySn = deviceGateway ?? sn
    const aircraftSn =
      kind === 'status' || (!deviceGateway && (await this.store.gatewayExists(sn))) ? undefined : sn
    if (!(await this.store.gatewayCanBind(gatewaySn, aircraftSn))) return
    switch (kind) {
      case 'status':
        await this.handleStatus(sn, env, rawTopic)
        return
      case 'osd':
        await this.handleOsd(sn, env, rawTopic)
        return
      case 'state':
        await this.handleState(sn, env, rawTopic)
        return
      case 'events':
      case 'requests':
        await this.store.logMessage(rawTopic, env, true).catch(() => undefined)
        return
      default:
        return
    }
  }

  private async handleStatus(gatewaySn: string, env: Envelope, rawTopic: string): Promise<void> {
    const parsed = topoSchema.safeParse(env.data ?? {})
    if (!parsed.success) {
      await this.store.logMessage(rawTopic, env, false).catch(() => undefined)
      return
    }

    const data = parsed.data

    // A controller that an admin has not approved may not announce a topology at all, so it
    // can neither create gateways nor claim aircraft. The MQTT authorizer also refuses its
    // credentials; this is the second gate, in case a session predates the rejection.
    // Topology is infrequent, so query the database rather than trusting the in-memory set,
    // which would still hold a controller revoked while the process was running.
    if (!(await this.store.isControllerApproved(gatewaySn))) {
      await this.store.logMessage(rawTopic, env, false).catch(() => undefined)
      await this.store
        .logDeviceEvent(gatewaySn, 'controller.claim_rejected', {
          reason: 'controller_not_approved',
        })
        .catch(() => undefined)
      return
    }

    this.knownGateways.add(gatewaySn)

    if (!isOnlineTopo(data)) {
      await this.store.markGatewayOffline(gatewaySn)
      this.emitStatus({ sn: gatewaySn, gatewaySn: null, online: false, lastSeenAt: null })
      for (const device of await this.store.devicesByGateway(gatewaySn)) {
        this.emitStatus({
          sn: device.sn,
          gatewaySn,
          online: false,
          lastSeenAt: null,
        })
      }
      return
    }

    // The topology payload carries DJI type codes rather than model names. Leave the
    // model unset so the UI falls back to the display name or "Aircraft".
    await this.store.upsertGateway(gatewaySn, this.workspaceId, null)
    this.emitStatus({
      sn: gatewaySn,
      gatewaySn: null,
      online: true,
      lastSeenAt: new Date().toISOString(),
    })

    const present = new Set<string>()
    for (const sub of data.sub_devices ?? []) {
      if ((sub.domain ?? 0) !== 0) continue
      // Both gates: the account behind the controller must still hold `drones.bind` for this
      // aircraft (their RBAC, re-read per message), and the aircraft must not be owned by a
      // different controller or deleted (the enrolment claim below).
      if (
        (await this.store.deviceUnavailable(sub.sn)) ||
        !(await this.store.gatewayCanBind(gatewaySn, sub.sn))
      )
        continue
      const claim = await this.store.claimDevice({
        sn: sub.sn,
        gatewaySn,
        workspaceId: this.workspaceId,
        model: null,
        domain: sub.domain ?? null,
        type: sub.type ?? null,
        subType: sub.sub_type ?? null,
        controlIndex: sub.index ?? null,
      })
      if (claim === 'conflict') {
        // The aircraft belongs to another controller, or the admin has not listed it for
        // this one. Do not create, rebind or mark anything offline: the real owner keeps it.
        await this.store.logMessage(rawTopic, env, false).catch(() => undefined)
        await this.store
          .logDeviceEvent(sub.sn, 'topology.claim_rejected', {
            controllerSn: gatewaySn,
            reason: 'bound_elsewhere',
          })
          .catch(() => undefined)
        continue
      }
      present.add(sub.sn)
      if (!this.knownDevices.has(sub.sn)) {
        // A new aircraft gets the first colour nobody else is using.
        await this.store.fleet.assignMissingColors().catch(() => undefined)
      }
      this.knownDevices.add(sub.sn)
      this.emitStatus({
        sn: sub.sn,
        gatewaySn,
        online: true,
        lastSeenAt: new Date().toISOString(),
      })
    }

    for (const device of await this.store.devicesByGateway(gatewaySn)) {
      if (!present.has(device.sn)) {
        await this.store.setDeviceOffline(device.sn)
        this.emitStatus({ sn: device.sn, gatewaySn, online: false, lastSeenAt: null })
      }
    }
  }

  private async handleOsd(sn: string, env: Envelope, rawTopic: string): Promise<void> {
    if (await this.store.deviceUnavailable(sn)) return
    if (!this.knownDevices.has(sn)) {
      // First sight: the aircraft must be bound to a controller an admin has approved, and a
      // bare gateway serial may only report once it is approved. Steady-state OSD is left to
      // the broker ACL, which re-checks the enrolment on every publish.
      const owner = await this.store.deviceGateway(sn)
      if (owner === undefined) {
        if (await this.store.gatewayExists(sn)) {
          if (!(await this.store.isControllerApproved(sn))) {
            await this.store.logMessage(rawTopic, env, false).catch(() => undefined)
            return
          }
          this.knownGateways.add(sn)
          await this.store.touchGateway(sn).catch(() => undefined)
          return
        }
        await this.store.logMessage(rawTopic, env, false).catch(() => undefined)
        return
      }
      if (!owner || !(await this.store.isControllerApproved(owner))) {
        await this.store.logMessage(rawTopic, env, false).catch(() => undefined)
        return
      }
      this.knownDevices.add(sn)
    }

    const raw = (env.data ?? {}) as Record<string, unknown>
    const parsed = osdSchema.safeParse(raw)
    const data = parsed.success ? (parsed.data as Record<string, unknown>) : raw
    const sample = toTelemetrySample(sn, data, env.timestamp || Date.now())

    this.emitTelemetry(sample)

    const keep = shouldStoreSample(
      sample,
      this.lastStored.get(sn),
      config.telemetry.idleIntervalSeconds * 1000,
    )
    if (keep) this.lastStored.set(sn, sample.ts)
    await Promise.all([
      this.store.touchDevice(sn).catch(() => undefined),
      keep
        ? this.store.insertSample(sample).catch((error) => {
            console.error('[registry] failed to store sample', error)
          })
        : undefined,
    ])
  }

  private async handleState(
    sn: string,
    env: Envelope,
    rawTopic: string,
    attempt = 0,
  ): Promise<void> {
    const data = (env.data ?? {}) as Record<string, unknown>

    // `live_status` is logged and surfaced, not used to drive stream state until real
    // hardware captures confirm its semantics (same rule as the provisional OSD mapper).
    if (data.live_status !== undefined) {
      this.events.emit('liveStatus', { gatewaySn: sn, entries: liveStatusEntries(data) })
    }

    if (data.live_capacity === undefined) {
      await this.store.logMessage(rawTopic, env, true).catch(() => undefined)
      return
    }

    const capacity = liveCapacitySchema.safeParse(data.live_capacity)
    if (!capacity.success) {
      await this.store.logMessage(rawTopic, env, false).catch(() => undefined)
      return
    }

    // The gateway owns `live_capacity`, and its `device_list` names the aircraft whose
    // cameras it describes. Some models also publish state against the aircraft itself.
    const isDevice = this.knownDevices.has(sn) || (await this.store.deviceExists(sn))
    if (isDevice) {
      const owner = await this.store.deviceGateway(sn)
      if (!owner || !(await this.store.isControllerApproved(owner))) {
        await this.store.logMessage(rawTopic, env, false).catch(() => undefined)
        return
      }
      await this.applyCapacity(sn, capacity.data)
      return
    }

    const isGateway = this.knownGateways.has(sn) || (await this.store.gatewayExists(sn))
    if (!isGateway || !(await this.store.isControllerApproved(sn))) {
      await this.store.logMessage(rawTopic, env, false).catch(() => undefined)
      return
    }

    await this.store.touchGateway(sn).catch(() => undefined)
    let notYet = false
    for (const device of capacity.data.device_list ?? []) {
      const owner = await this.store.deviceGateway(device.sn)
      // The first time a controller connects, its cameras can be described before the aircraft's
      // topology has been stored. Dropping that message would leave the aircraft with no camera, and
      // nothing to record or watch, until it said it again (a controller only does when it changes).
      if (owner === undefined) {
        notYet = true
        continue
      }
      // Only the controller that owns an aircraft may describe its cameras.
      if (owner !== sn) continue
      await this.applyCapacity(device.sn, capacity.data)
    }
    if (notYet && attempt < 3) {
      const retry = setTimeout(
        () => void this.handleState(sn, env, rawTopic, attempt + 1).catch(() => undefined),
        2000 * (attempt + 1),
      )
      retry.unref()
    }
  }

  private async applyCapacity(sn: string, capacity: LiveCapacity): Promise<void> {
    if (await this.store.deviceUnavailable(sn)) return
    const gateway = await this.store.deviceGatewaySn(sn)
    if (gateway && !(await this.store.gatewayCanBind(gateway, sn))) return
    const cameras: CameraSummary[] = camerasFor(capacity, sn).map((camera) => ({
      cameraIndex: camera.camera_index,
      videos: (camera.video_list ?? []).map((video) => ({
        videoIndex: video.video_index,
        videoType: video.video_type,
      })),
    }))
    await this.store.setDeviceCapacity(sn, capacity, cameras)
    this.events.emit('capacity', { sn, cameras })
  }

  private emitTelemetry(sample: TelemetrySample): void {
    this.events.emit('telemetry', sample)
  }

  private emitStatus(status: DeviceStatus): void {
    this.events.emit('status', status)
  }
}
