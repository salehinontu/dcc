// Local E2E fixture: in-memory database, fake controller, loopback HTTP only.
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { hashPassword } from '../../src/auth'
import { migrate, type Db } from '../../src/db'
import { Hub } from '../../src/hub'
import { Registry } from '../../src/registry'
import { buildServer } from '../../src/server'
import { Store } from '../../src/store'
import { MqttAuthorizer } from '../../src/mqtt-auth'
import { StreamManager } from '../../src/streams/manager'
import { WhepSessions } from '../../src/streams/whep'
import type { MqttBridge } from '../../src/mqtt'
const embedded = new PGlite()
const db: Db = {
  query: async <T>(sql: string, params?: unknown[]) => (await embedded.query<T>(sql, params)).rows,
  exec: async (sql) => {
    await embedded.exec(sql)
  },
  close: () => embedded.close(),
}
await migrate(db)
const store = new Store(db)
await store.createUser(
  randomUUID(),
  'root@example.com',
  await hashPassword('test-root-password'),
  'developer',
)
for (const sn of ['alpha', 'bravo'])
  await store.claimDevice({
    sn,
    gatewaySn: 'controller',
    workspaceId: 'w',
    model: 'Aircraft',
    domain: 0,
    type: 1,
    subType: 0,
    controlIndex: 0,
  })
const hub = new Hub()
const registry = new Registry(store, 'w')
await registry.init()
const bridge = {
  connected: true,
  subscribed: true,
  callService: async () => ({}),
} as unknown as MqttBridge
const whep = new WhepSessions()
const manager = new StreamManager({ store, hub, bridge, whep })
const app = await buildServer({
  store,
  hub,
  registry,
  bridge,
  whep,
  manager,
  authorizer: new MqttAuthorizer(store),
})
await app.listen({ port: Number(process.env.RBAC_API_PORT ?? 3209), host: '127.0.0.1' })

process.on('SIGTERM', () => {
  manager.dispose()
  void app
    .close()
    .then(() => db.close())
    .finally(() => process.exit(0))
})
