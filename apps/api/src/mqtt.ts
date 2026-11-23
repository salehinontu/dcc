import { randomUUID } from 'node:crypto'
import mqtt, { type MqttClient } from 'mqtt'
import {
  SUBSCRIBE_TOPICS,
  envelopeSchema,
  parseTopic,
  topic as topics,
  type Envelope,
  type TopicKind,
} from '@dji/protocol'
import { config } from './config'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface MqttHandlers {
  onMessage: (kind: TopicKind, sn: string, env: Envelope, rawTopic: string) => Promise<void>
  onInvalid: (rawTopic: string, payload: unknown) => Promise<void>
}

export class MqttBridge {
  private client: MqttClient | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly subscribedListeners: (() => void)[] = []
  private topicsSubscribed = false

  constructor(private readonly handlers: MqttHandlers) {}

  /** Runs after every successful SUBACK, and immediately if already subscribed. */
  onSubscribed(listener: () => void): void {
    this.subscribedListeners.push(listener)
    if (this.subscribed) queueMicrotask(listener)
  }

  /**
   * Connect after the HTTP server is listening. EMQX calls /internal/mqtt/auth to
   * authenticate this connection, so connecting before the API is reachable is refused
   * and the client can give up instead of reconnecting.
   */
  start(): void {
    if (this.client) return

    const client = mqtt.connect(config.mqttUrl, {
      clientId: 'dji-api',
      username: config.mqttUsername,
      password: config.mqttPassword,
      clean: true,
      reconnectPeriod: 2000,
      // EMQX authenticates us through /internal/mqtt/auth. During a stack restart that
      // endpoint can be briefly unavailable, so retry even after a CONNACK refusal.
      reconnectOnConnackError: true,
    })
    this.client = client
    this.topicsSubscribed = false

    // EMQX authorises SUBSCRIBE through /internal/mqtt/acl. Right after an API restart its
    // HTTP connector can still be marked down, so the SUBACK fails; retry until it works.
    const subscribe = (): void => {
      client.subscribe(SUBSCRIBE_TOPICS, { qos: 1 }, (error, granted) => {
        // EMQX refuses with QoS 128 in the SUBACK; mqtt.js surfaces that as a granted QoS,
        // not an error, so checking only `error` marks a denied subscription as successful.
        const refused = granted?.some((entry) => entry.qos === 128) ?? false
        if (error || refused) {
          console.error(
            '[mqtt] subscribe failed, retrying in 5 s',
            error?.message ?? 'subscription refused',
          )
          setTimeout(() => {
            if (this.client === client && client.connected && !this.topicsSubscribed) subscribe()
          }, 5_000).unref()
          return
        }
        this.topicsSubscribed = true
        for (const listener of this.subscribedListeners) {
          try {
            listener()
          } catch (error) {
            console.error('[mqtt] subscribed listener failed', error)
          }
        }
      })
    }

    client.on('connect', () => {
      console.log(`[mqtt] connected to ${config.mqttUrl}`)
      // clean: true means subscriptions do not survive a reconnect.
      this.topicsSubscribed = false
      subscribe()
    })

    client.on('reconnect', () => console.log('[mqtt] reconnecting'))
    client.on('error', (error) => console.error('[mqtt] error', error.message))
    client.on('message', (rawTopic, payload) => void this.onMessage(rawTopic, payload))
  }

  get connected(): boolean {
    return this.client?.connected ?? false
  }

  /** Connected and subscribed: messages published now will reach the registry. */
  get subscribed(): boolean {
    return this.client?.connected === true && this.topicsSubscribed
  }

  publish(target: string, payload: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = this.client
      if (!client) {
        reject(new Error('MQTT bridge not started'))
        return
      }
      client.publish(target, JSON.stringify(payload), { qos: 1 }, (error) =>
        error ? reject(error) : resolve(),
      )
    })
  }

  callService(
    gatewaySn: string,
    method: string,
    data: unknown,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    const tid = randomUUID()
    const message: Envelope = {
      tid,
      bid: randomUUID(),
      timestamp: Date.now(),
      method,
      data,
    }

    return new Promise((resolve, reject) => {
      const client = this.client
      if (!client) {
        reject(new Error('MQTT bridge not started'))
        return
      }

      const timer = setTimeout(() => {
        this.pending.delete(tid)
        reject(new Error(`service ${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)

      this.pending.set(tid, { resolve, reject, timer })

      client.publish(topics.services(gatewaySn), JSON.stringify(message), { qos: 1 }, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(tid)
        reject(error)
      })
    })
  }

  private resolveReply(tid: string, data: unknown): void {
    const pending = this.pending.get(tid)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(tid)

    const result = (data as { result?: unknown } | undefined)?.result
    if (typeof result === 'number' && result !== 0) {
      pending.reject(new Error(`service rejected with result ${result}`))
      return
    }
    pending.resolve(data)
  }

  private async onMessage(rawTopic: string, payload: Buffer): Promise<void> {
    const parsed = parseTopic(rawTopic)
    if (!parsed) return

    let json: unknown
    try {
      json = JSON.parse(payload.toString())
    } catch {
      await this.handlers.onInvalid(rawTopic, payload.toString()).catch(() => undefined)
      return
    }

    const envelope = envelopeSchema.safeParse(json)
    if (!envelope.success) {
      await this.handlers.onInvalid(rawTopic, json).catch(() => undefined)
      return
    }

    if (parsed.kind === 'services_reply') {
      this.resolveReply(envelope.data.tid, envelope.data.data)
      return
    }

    // Pilot 2 resends update_topo every few seconds until the cloud acknowledges it on
    // status_reply, and does not treat the gateway as online before that.
    if (parsed.kind === 'status' && envelope.data.method === 'update_topo') {
      this.publish(topics.statusReply(parsed.sn), {
        tid: envelope.data.tid,
        bid: envelope.data.bid,
        timestamp: Date.now(),
        method: 'update_topo',
        data: { result: 0 },
      }).catch((error) => console.error('[mqtt] status_reply failed', error))
    }

    await this.handlers
      .onMessage(parsed.kind, parsed.sn, envelope.data, rawTopic)
      .catch((error) => console.error('[mqtt] handler failed', error))
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('backend shutting down'))
    }
    this.pending.clear()

    const client = this.client
    this.client = null
    if (client) await client.endAsync()
  }
}
