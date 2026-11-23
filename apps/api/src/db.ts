import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import { config } from './config'

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  exec(sql: string): Promise<void>
  close(): Promise<void>
}

/**
 * Development uses an embedded Postgres (PGlite) so the app runs with no services
 * installed. Setting DATABASE_URL switches to a real Postgres with the same schema.
 */
export async function openDb(): Promise<Db> {
  if (config.databaseUrl && config.databaseUrl.startsWith('postgres')) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl })
    // An idle connection can be cut by the server (a Postgres restart, a failover, a reboot of the
    // host). pg then emits 'error' on the pool, and with no listener Node throws it and the whole
    // API exits. The pool already drops the dead client and opens a new one on the next query, so
    // logging is all that is needed; the API stays up and recovers when the database is back.
    pool.on('error', (error) => console.error('[db] idle connection error', error.message))
    return {
      async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
        const result = await pool.query(sql, params as unknown[])
        return result.rows as T[]
      },
      async exec(sql: string): Promise<void> {
        await pool.query(sql)
      },
      async close(): Promise<void> {
        await pool.end()
      },
    }
  }

  const dir = `${config.dataDir}/pglite`
  mkdirSync(dir, { recursive: true })
  const db = new PGlite(dir)
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await db.query<T>(sql, params as never[])
      return result.rows as T[]
    },
    async exec(sql: string): Promise<void> {
      await db.exec(sql)
    },
    async close(): Promise<void> {
      await db.close()
    },
  }
}

const RESET_STREAMS_SQL = `
  UPDATE streams
  SET state = 'stopped', error = 'api restarted', stopped_at = now(),
      rev = rev + 1, updated_at = now()
  WHERE state IN ('starting', 'live')`

// The reset above may be skipped (CLI commands), so duplicates could still exist on an old
// database. It is only created after the API's reset in practice; if a CLI gets here first
// it fails loudly rather than silently touching live streams.
const ONE_ACTIVE_STREAM_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS streams_one_active
    ON streams (device_sn, video_id) WHERE state IN ('starting', 'live')`

export async function migrate(db: Db, options: { resetStreams?: boolean } = {}): Promise<void> {
  const schema = await readFile(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8')
  await db.exec(schema)

  // A freshly started API holds no viewers or media sessions, so any stream still marked
  // active is stale. This must run before the unique index, which old duplicate rows
  // violate. The CLI calls migrate() without this flag: managing users must never stop a
  // stream that the running API still owns.
  if (options.resetStreams) await db.exec(RESET_STREAMS_SQL)
  await db.exec(ONE_ACTIVE_STREAM_SQL)
}
