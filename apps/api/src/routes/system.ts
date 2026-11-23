import type { FastifyInstance } from 'fastify'
import type { RouteContext } from '../http/context'

export function registerSystemRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, registry, hub, bridge, requireAdmin } = ctx

  app.get('/api/health', async () => ({
    ok: true,
    mqtt: bridge.connected,
    mqttSubscribed: bridge.subscribed,
    websocketClients: hub.count(),
    devices: (await registry.list()).length,
  }))

  app.get('/api/debug/messages', { preHandler: requireAdmin }, async () => ({
    messages: await store.recentMessages(200),
  }))
}
