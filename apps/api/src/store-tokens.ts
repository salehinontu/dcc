import type { ApiTokenRecord } from '@dji/protocol'
import type { Db } from './db'

type Stamp = Date | string | null

const iso = (value: Stamp | undefined): string | null => {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export interface ApiTokenRow {
  id: string
  user_id: string
  name: string
  prefix: string
  device_sns: string[] | null
  created_at: Stamp
  expires_at: Stamp
  last_used_at: Stamp
  last_used_ip: string | null
  revoked_at: Stamp
  owner_email?: string
}

const toRecord = (row: ApiTokenRow): ApiTokenRecord => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  ownerEmail: row.owner_email ?? '',
  deviceSns: Array.isArray(row.device_sns) ? row.device_sns : null,
  createdAt: iso(row.created_at) ?? '',
  expiresAt: iso(row.expires_at),
  lastUsedAt: iso(row.last_used_at),
  lastUsedIp: row.last_used_ip,
  revokedAt: iso(row.revoked_at),
})

/** The API tokens. Only a hash of each secret is kept (see `api-tokens.ts`); nothing here ever returns one. */
export class TokenStore {
  constructor(private readonly db: Db) {}

  async create(input: {
    id: string
    userId: string
    name: string
    tokenHash: string
    prefix: string
    deviceSns: string[] | null
    expiresAt: Date | null
  }): Promise<ApiTokenRecord> {
    await this.db.query(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, device_sns, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        input.id,
        input.userId,
        input.name,
        input.tokenHash,
        input.prefix,
        input.deviceSns === null ? null : JSON.stringify(input.deviceSns),
        input.expiresAt,
      ],
    )
    return (await this.get(input.id))!
  }

  /** The token with this hash if it still works: not revoked, not past its expiry. */
  async findLive(tokenHash: string): Promise<ApiTokenRow | null> {
    const rows = await this.db.query<ApiTokenRow>(
      `SELECT * FROM api_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [tokenHash],
    )
    return rows[0] ?? null
  }

  async get(id: string): Promise<ApiTokenRecord | null> {
    const rows = await this.db.query<ApiTokenRow>(
      `SELECT t.*, u.email AS owner_email FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [id],
    )
    return rows[0] ? toRecord(rows[0]) : null
  }

  /** The owner of a token, for the checks that decide whether an account may see or revoke it. */
  async ownerOf(id: string): Promise<string | null> {
    const rows = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM api_tokens WHERE id = $1`,
      [id],
    )
    return rows[0]?.user_id ?? null
  }

  /** Newest first. `ownerIds` limits it to those accounts; undefined lists every token. */
  async list(ownerIds: string[] | undefined): Promise<ApiTokenRecord[]> {
    const rows = await this.db.query<ApiTokenRow>(
      `SELECT t.*, u.email AS owner_email
       FROM api_tokens t JOIN users u ON u.id = t.user_id
       ${ownerIds ? 'WHERE t.user_id = ANY($1::text[])' : ''}
       ORDER BY t.created_at DESC, t.id DESC LIMIT 500`,
      ownerIds ? [ownerIds] : [],
    )
    return rows.map(toRecord)
  }

  /** Stops it working at once. Revoking twice is the same as once. Returns whether it was newly revoked. */
  async revoke(id: string, by: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE api_tokens SET revoked_at = now(), revoked_by = $2
       WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [id, by],
    )
    return rows.length > 0
  }

  /** Remember that it was used, at most once a minute: reading data must not write a row per request. */
  async touch(id: string, ip: string | null): Promise<void> {
    await this.db.query(
      `UPDATE api_tokens SET last_used_at = now(), last_used_ip = $2
       WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
      [id, ip],
    )
  }
}
