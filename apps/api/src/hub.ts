import type { ServerMessage } from '@dji/protocol'

export interface SocketLike {
  send(data: string): void
  close?(code?: number, reason?: string): void
  readyState: number
}

interface Client {
  id: string
  socket: SocketLike
  channels: Set<string>
  userId?: string
  jti?: string
  filter?: (message: ServerMessage) => Promise<boolean>
}

const OPEN = 1

export class Hub {
  private readonly clients = new Map<string, Client>()

  add(
    id: string,
    socket: SocketLike,
    userId?: string,
    filter?: Client['filter'],
    jti?: string,
  ): void {
    this.clients.set(id, { id, socket, channels: new Set(), userId, filter, jti })
  }

  remove(id: string): void {
    this.clients.delete(id)
  }

  setChannels(id: string, action: 'add' | 'remove', targets: string[]): void {
    const client = this.clients.get(id)
    if (!client) return
    for (const target of targets) {
      if (action === 'add') client.channels.add(target)
      else client.channels.delete(target)
    }
  }

  /** Deliver once per client, even when it subscribes to several matching channels. */
  publish(targets: string[], message: ServerMessage): void {
    const payload = JSON.stringify(message)
    for (const client of this.clients.values()) {
      if (client.socket.readyState !== OPEN) continue
      if (targets.some((target) => client.channels.has(target))) {
        try {
          if (client.filter) {
            void client
              .filter(message)
              .then((allowed) => {
                if (allowed && this.clients.has(client.id) && client.socket.readyState === OPEN)
                  client.socket.send(payload)
              })
              .catch(() => client.socket.close?.(4003, 'access changed'))
          } else client.socket.send(payload)
        } catch {
          this.clients.delete(client.id)
        }
      }
    }
  }

  /** The account's rights changed: the socket must reconnect to pick up new grants. */
  disconnectUser(userId: string): void {
    for (const client of this.clients.values()) {
      if (client.userId !== userId) continue
      this.clients.delete(client.id)
      client.socket.close?.(4003, 'access changed; sign in again')
    }
  }

  /**
   * End every live socket for an account, or for one session when `jti` is given. 4001 is
   * "your session is gone, sign in again", as opposed to 4003's "your rights changed" — the
   * browser must not retry either, but only 4001 means the credential itself is dead.
   */
  closeUser(userId: string, jti?: string): void {
    for (const client of [...this.clients.values()]) {
      if (client.userId !== userId) continue
      if (jti !== undefined && client.jti !== jti) continue
      this.clients.delete(client.id)
      client.socket.close?.(4001, 'session revoked')
    }
  }

  count(): number {
    return this.clients.size
  }
}
