import { createServer } from 'node:net'
import { Aedes } from 'aedes'

/**
 * Local MQTT broker for development. Production uses EMQX with TLS and per-controller
 * credentials; this exists so the API and simulator can run without Docker.
 */
const port = Number(process.env.MQTT_PORT ?? 1883)
const broker = await Aedes.createBroker({ id: 'dji-dev-broker' })

broker.on('client', (client) => {
  console.log(`[broker] client connected: ${client.id}`)
})

broker.on('clientDisconnect', (client) => {
  console.log(`[broker] client disconnected: ${client.id}`)
})

broker.on('publish', (packet, client) => {
  if (!client) return
  // OSD and state arrive every second per aircraft; log only the low-volume topics.
  if (/\/(status|services|services_reply)$/.test(packet.topic)) {
    console.log(`[broker] ${packet.topic}`)
  }
})

const server = createServer(broker.handle)
server.listen(port, () => {
  console.log(`[broker] listening on mqtt://127.0.0.1:${port}`)
})

const shutdown = () => {
  server.close(() => broker.close(() => process.exit(0)))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
