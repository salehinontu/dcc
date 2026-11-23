import { channels, type CameraSummary, type LiveStatusEntry } from '@dji/protocol'
import { config } from './config'
import { AlertMonitor } from './alerts/monitor'
import { FlightTracker } from './flights/tracker'
import { GeoEngine } from './geo/engine'
import { seedBuiltinZones } from './geo/seed'
import { migrate, openDb } from './db'
import { Hub } from './hub'
import { MqttBridge } from './mqtt'
import { MqttAuthorizer } from './mqtt-auth'
import { Registry } from './registry'
import { buildServer } from './server'
import { AuditLog } from './audit'
import { Janitor, janitorOptionsFromConfig } from './janitor'
import { VideoLibrary } from './recordings/library'
import { parseStorageRoots, RecordingPlace } from './recordings/place'
import { RecordingManager, recorderOptionsFromConfig } from './recordings/recorder'
import { Store } from './store'
import { StreamManager } from './streams/manager'
import { WhepSessions } from './streams/whep'

async function main(): Promise<void> {
  // Recorded before migrate: the schema reset marks every active row with this boot's
  // timestamp, and the manager uses it to stop the RC pushes the old process left behind.
  const bootAt = new Date()

  const db = await openDb()
  await migrate(db, { resetStreams: true })

  const store = new Store(db)
  await store.seedWorkspace(
    config.dji.workspaceId,
    config.dji.workspaceName,
    config.dji.platformName,
  )

  // The built-in no-fly zones, a colour for every aircraft, and a clean slate for flights and
  // alerts: nothing is in flight when the process starts, so whatever the old one left open
  // is closed here.
  const seeded = await seedBuiltinZones(store)
  if (seeded > 0) console.log(`[api] added ${seeded} built-in no-fly zone(s)`)
  await store.fleet.assignMissingColors()
  await store.fleet.clearAllOpenAlerts()

  // Sessions outlive the process; prune the long-expired ones at boot and daily. A row is
  // kept for a day past expiry so an expired-token request still finds it and can be told
  // apart from a revoked one.
  await store.deleteExpiredSessions().catch(() => undefined)

  // The simulator stands in for a controller in development, and an unapproved controller
  // may not publish topology. Enabled only by the dev launcher and the dev Compose file.
  if (config.seedSimulator) {
    const count = Math.max(1, Number(process.env.SIM_DRONES ?? 3))
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index + 1).padStart(9, '0')
      await store.approveEnrollment(`1ZSIMRC${suffix}`, [`1ZSIMDRN${suffix}`], 'dev-simulator')
    }
    console.log(`[api] approved ${count} simulator controller(s)`)
  }

  const hub = new Hub()
  const registry = new Registry(store, config.dji.workspaceId)
  await registry.init()
  const authorizer = new MqttAuthorizer(store)

  const bridge = new MqttBridge({
    onMessage: (kind, sn, env, rawTopic) => registry.handle(kind, sn, env, rawTopic),
    onInvalid: (rawTopic, payload) =>
      store.logMessage(rawTopic, payload, false).then(() => undefined),
  })

  const whep = new WhepSessions()
  const manager = new StreamManager({ store, bridge, hub, whep })
  // Where the videos are kept: the install's folder, or the one a Developer chose in the app.
  const audit = new AuditLog(db)
  // The first line of a trail says when it began; what happened before it was not recorded.
  if ((await audit.head()).seq === 0)
    await audit.write({
      action: 'audit.started',
      outcome: 'success',
      actorEmail: 'server',
      actorRole: 'system',
      details: { note: 'Events from before this line were not recorded here.' },
    })
  const place = new RecordingPlace(
    config.recordings.dir,
    config.recordings.dirLocked,
    store,
    parseStorageRoots(config.recordings.roots),
  )
  await place.load()
  const recorder = new RecordingManager({ store, manager }, recorderOptionsFromConfig(place))
  const library = new VideoLibrary(store, {
    get dir() {
      return place.dir
    },
    olderDirs: () => place.olderDirs,
    ffmpegPath: config.recordings.ffmpegPath,
    ffprobePath: config.recordings.ffprobePath,
    maxBytes: config.recordings.uploadMaxBytes,
  })
  const janitor = new Janitor({ store, recorder, library }, janitorOptionsFromConfig(place))
  // Uploads that were still being made playable when the API stopped are finished or marked failed.
  void library.resume().catch((error) => console.error('[library] resuming uploads failed', error))
  // A clip left half-written by a restart is valid up to its last fragment: archive it.
  void recorder
    .indexOrphans()
    .then(
      (added) => added > 0 && console.log(`[rec] archived ${added} clip(s) left by the last run`),
    )
    .catch((error) => console.error('[rec] indexing leftover clips failed', error))

  const flights = new FlightTracker(store)
  const geo = new GeoEngine(store, hub, (sn) => flights.activeFlightId(sn))
  await geo.reload()
  // Alerts about the aircraft itself: contact lost in the air, battery running low.
  const alerts = new AlertMonitor(store, hub, (sn) => flights.activeFlightId(sn), config.alerts)
  const recovered = await flights.recover()
  if (recovered > 0) console.log(`[api] closed ${recovered} flight(s) left open by the last run`)
  flights.events.on('ended', ({ sn }: { sn: string }) => {
    void geo.onFlightEnd(sn).catch((error) => console.error('[geo] flight end failed', error))
    void alerts.onFlightEnd(sn).catch((error) => console.error('[alerts] flight end failed', error))
  })

  registry.events.on('telemetry', (sample) => {
    hub.publish([channels.devices, channels.device(sample.sn)], { type: 'telemetry', data: sample })
    // Flights first (it knows whether the aircraft is flying), then the zone, link and battery checks.
    void flights
      .onSample(sample)
      .then((airborne) =>
        Promise.all([geo.onSample(sample, airborne), alerts.onSample(sample, airborne)]),
      )
      .catch((error) => console.error('[flights] sample failed', error))
  })

  registry.events.on('status', (status) => {
    hub.publish([channels.devices, channels.device(status.sn)], {
      type: 'device.status',
      data: status,
    })
    // Gateway statuses carry no aircraft serial (gatewaySn === null); only aircraft state
    // drives stream start/stop.
    if (status.gatewaySn) manager.deviceOnline(status.sn, status.online)
    if (status.gatewaySn && !status.online) {
      // The alert reads the flight id first: the tracker closes the flight right after.
      void alerts
        .onOffline(status.sn, 'disconnected', flights.activeFlightId(status.sn))
        .catch((error) => console.error('[alerts] offline failed', error))
      void flights
        .onOffline(status.sn)
        .catch((error) => console.error('[flights] offline failed', error))
    }
  })

  registry.events.on('capacity', (event: { sn: string; cameras: CameraSummary[] }) => {
    hub.publish([channels.devices, channels.device(event.sn)], {
      type: 'device.cameras',
      data: { sn: event.sn, cameras: event.cameras },
    })
    manager.capacityChanged(event.sn)
  })

  registry.events.on('liveStatus', (event: { gatewaySn: string; entries: LiveStatusEntry[] }) => {
    for (const entry of event.entries) {
      console.log(
        `[stream] live_status video_id=${entry.video_id ?? entry.video_index ?? '-'} status=${String(entry.status ?? '-')}`,
      )
    }
  })

  const app = await buildServer({
    store,
    registry,
    hub,
    bridge,
    authorizer,
    manager,
    whep,
    geo,
    flights,
    recorder,
    library,
    janitor,
    place,
    audit,
  })
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`[api] listening on http://localhost:${config.port}`)

  // Automatic recording and the storage rules start with the API and never need a person: a drone set
  // to record gets its recording at once (waiting for the drone to connect), a restart picks up where
  // it was, and the janitor keeps the disk from filling.
  janitor.start()
  recorder.startAuto()

  // The broker authenticates this connection through /internal/mqtt/auth, so the HTTP
  // server must be listening before the MQTT client connects.
  bridge.onSubscribed(() => {
    void manager
      .recoverAfterBoot(bootAt)
      .catch((error) => console.error('[stream] boot recovery failed', error))
  })
  bridge.start()

  const sweep = setInterval(() => {
    store
      .markStaleOffline(45)
      .then((stale) => {
        for (const sn of stale) {
          hub.publish([channels.devices, channels.device(sn)], {
            type: 'device.status',
            data: { sn, gatewaySn: null, online: false, lastSeenAt: null },
          })
          manager.deviceOnline(sn, false)
          void alerts
            .onOffline(sn, 'silent', flights.activeFlightId(sn))
            .catch((error) => console.error('[alerts] offline failed', error))
          void flights
            .onOffline(sn)
            .catch((error) => console.error('[flights] offline failed', error))
        }
      })
      .catch((error) => console.error('[api] offline sweep failed', error))

    void manager.sweep().catch((error) => console.error('[stream] sweep failed', error))
    void flights.sweep().catch((error) => console.error('[flights] sweep failed', error))
  }, 10_000)
  sweep.unref()

  const prune = setInterval(
    () => {
      void store
        .deleteExpiredSessions()
        .catch((error) => console.error('[api] session prune failed', error))
    },
    24 * 60 * 60 * 1000,
  )
  prune.unref()

  const shutdown = async (): Promise<void> => {
    clearInterval(sweep)
    clearInterval(prune)
    janitor.stop()
    await recorder.dispose()
    manager.dispose()
    await app.close()
    await bridge.close()
    await db.close()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((error) => {
  console.error('[api] fatal', error)
  process.exit(1)
})
