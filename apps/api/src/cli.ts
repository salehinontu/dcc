import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import {
  ASSIGNABLE_ROLES,
  defaultPermissions,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@dji/protocol'
import { hashPassword } from './auth'
import { config } from './config'
import { migrate, openDb } from './db'
import { AuditLog, type AuditEntry } from './audit'
import { Store } from './store'

const [command, ...rest] = process.argv.slice(2)

function arg(name: string): string | undefined {
  const index = rest.indexOf(`--${name}`)
  return index >= 0 ? rest[index + 1] : undefined
}

function required(name: string): string {
  const value = arg(name)
  if (!value) {
    console.error(`Missing --${name}`)
    process.exit(1)
  }
  return value
}

/** Same floor as the HTTP routes; a CLI-created account must not be weaker than a reset one. */
function passwordFrom(name: string): string {
  const value = required(name)
  if (value.length < PASSWORD_MIN_LENGTH) {
    console.error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    process.exit(1)
  }
  return value
}

function commaList(name: string): string[] {
  const value = arg(name)
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function usage(): never {
  console.log(`Usage:
  npm run admin    # interactively create a developer (the vendor's own account)
  DEVELOPER_PASSWORD=… tsx src/cli.ts admin --email <email>   # the same, unattended (installer)
  tsx src/cli.ts create --email <email> --password <password> [--role admin|subadmin|pilot] [--admin <admin email>]
  tsx src/cli.ts password --email <email> --password <password>
  tsx src/cli.ts mfa-reset --email <email>     # turn off an account's two-step sign-in (a lost phone)
  tsx src/cli.ts list
  tsx src/cli.ts revoke-gateway --sn <controller serial>
  tsx src/cli.ts controller-list [--status pending|approved|rejected]
  tsx src/cli.ts controller-approve --sn <controller serial> [--aircraft <sn,sn>] [--by <email>]
  tsx src/cli.ts controller-reject --sn <controller serial> [--reason <text>]
  tsx src/cli.ts controller-unbind --sn <controller serial> [--reason <text>]`)
  process.exit(1)
}

async function main(): Promise<void> {
  const db = await openDb()
  await migrate(db)
  const store = new Store(db)
  const audit = new AuditLog(db)
  // What is done at the server's console is in the audit trail too, under the actor "server console".
  const consoleLine = (entry: Omit<AuditEntry, 'actorEmail' | 'actorRole' | 'outcome'>) =>
    audit.write({
      actorEmail: 'server console',
      actorRole: 'console',
      outcome: 'success',
      ...entry,
    })
  await store.seedWorkspace(
    config.dji.workspaceId,
    config.dji.workspaceName,
    config.dji.platformName,
  )

  switch (command) {
    case 'admin': {
      // Unattended (the installer): `admin --email <email>` with the password in DEVELOPER_PASSWORD, never on the command
      // line, where any user of the server could read it in the process list.
      const unattendedEmail = arg('email')
      if (unattendedEmail) {
        const email = unattendedEmail.trim().toLowerCase()
        const password = process.env.DEVELOPER_PASSWORD ?? ''
        if (
          !z.email().safeParse(email).success ||
          password.length < PASSWORD_MIN_LENGTH ||
          password.length > PASSWORD_MAX_LENGTH
        )
          throw new Error(
            `Use a valid --email and a ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} character DEVELOPER_PASSWORD.`,
          )
        const existing = await store.findUserByEmail(email)
        if (existing) {
          if (existing.role !== 'developer')
            throw new Error(`${email} already exists and is not a Developer.`)
          console.log(`Developer ${email} already exists; left as it is.`)
          break
        }
        const developerId = randomUUID()
        await store.createUser(developerId, email, await hashPassword(password), 'developer')
        await consoleLine({
          action: 'cli.developer_created',
          targetType: 'user',
          targetId: developerId,
          targetLabel: email,
        })
        console.log(`Created developer ${email}`)
        break
      }
      if (!process.stdin.isTTY) throw new Error('Run npm run admin in an interactive terminal.')
      let hidden = false
      const output = new Writable({
        write(chunk, _encoding, callback) {
          if (!hidden) process.stdout.write(chunk)
          callback()
        },
      })
      const prompt = createInterface({ input: process.stdin, output, terminal: true })
      let email: string
      let password: string
      try {
        email = (await prompt.question('Developer email: ')).trim().toLowerCase()
        process.stdout.write(
          `Password (${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters, hidden): `,
        )
        hidden = true
        password = await prompt.question('')
        process.stdout.write('\nConfirm password: ')
        const confirm = await prompt.question('')
        hidden = false
        process.stdout.write('\n')
        if (password !== confirm) throw new Error('Passwords do not match.')
        if (
          !z.email().safeParse(email).success ||
          password.length < PASSWORD_MIN_LENGTH ||
          password.length > PASSWORD_MAX_LENGTH
        )
          throw new Error(
            `Use a valid email and a ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} character password.`,
          )
      } finally {
        prompt.close()
      }
      if (await store.findUserByEmail(email))
        throw new Error('Email already exists. Choose a separate developer email.')
      const developerId = randomUUID()
      await store.createUser(developerId, email, await hashPassword(password), 'developer')
      await consoleLine({
        action: 'cli.developer_created',
        targetType: 'user',
        targetId: developerId,
        targetLabel: email,
      })
      console.log(`Created developer ${email}`)
      break
    }
    case 'create': {
      const email = required('email').toLowerCase()
      const password = passwordFrom('password')
      const role = arg('role') ?? 'subadmin'
      if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
        console.error('Role must be admin, subadmin or pilot')
        process.exit(1)
      }

      if (
        !z.email().safeParse(email).success ||
        password.length < PASSWORD_MIN_LENGTH ||
        password.length > PASSWORD_MAX_LENGTH
      )
        throw new Error(
          `Use a valid email and a ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} character password.`,
        )
      const existing = await store.findUserByEmail(email)
      if (existing?.role === 'developer')
        throw new Error('Use user:password to recover a developer password.')
      const passwordHash = await hashPassword(password)
      if (existing) {
        await store.setUserAccess(existing.id, {
          role,
          permissions: defaultPermissions(role),
          allDrones: true,
          dronePermissions: {},
          disabled: false,
        })
        await store.updateUser(existing.id, passwordHash, role)
        // The API cannot be reached from here, so its sockets see the revocation on their
        // next keepalive check; the rows are what makes that check fail.
        await store.revokeUserSessions(existing.id)
        await consoleLine({
          action: 'cli.user_created',
          tenantId: existing.admin_id,
          targetType: 'user',
          targetId: existing.id,
          targetLabel: email,
          details: { updatedExisting: true, role },
        })
        console.log(`updated ${email} (${role}); existing sessions revoked`)
      } else {
        // A Sub-admin or Pilot made here belongs to the Admin named by --admin, or to none.
        let adminId: string | null = null
        const adminEmail = arg('admin')
        if (adminEmail && role !== 'admin') {
          const admin = await store.findUserByEmail(adminEmail)
          if (admin?.role !== 'admin') throw new Error(`${adminEmail} is not an Admin account.`)
          adminId = admin.id
        }
        const permissions = defaultPermissions(role)
        const createdId = randomUUID()
        await store.createUser(createdId, email, passwordHash, role, {
          permissions,
          allDrones: true,
          dronePermissions: {},
          adminId,
        })
        await consoleLine({
          action: 'cli.user_created',
          tenantId: role === 'admin' ? createdId : adminId,
          targetType: 'user',
          targetId: createdId,
          targetLabel: email,
          details: { role },
        })
        console.log(`created ${email} (${role})`)
      }
      break
    }

    case 'password': {
      const email = required('email').toLowerCase()
      const existing = await store.findUserByEmail(email)
      if (!existing) {
        console.error(`No user ${email}`)
        process.exit(1)
      }
      await store.updateUser(
        existing.id,
        await hashPassword(passwordFrom('password')),
        existing.role,
      )
      await store.revokeUserSessions(existing.id)
      await consoleLine({
        action: 'cli.password_reset',
        tenantId: existing.role === 'developer' ? null : existing.admin_id,
        targetType: 'user',
        targetId: existing.id,
        targetLabel: email,
      })
      console.log(`password updated for ${email}; existing sessions revoked`)
      break
    }

    // A lost phone with nobody left who can reset it from the dashboard (the only Developer, say): the server console can.
    case 'mfa-reset': {
      const email = required('email').toLowerCase()
      const existing = await store.findUserByEmail(email)
      if (!existing) {
        console.error(`No user ${email}`)
        process.exit(1)
      }
      await store.disableTotp(existing.id)
      await store.revokeUserSessions(existing.id)
      await consoleLine({
        action: 'cli.mfa_reset',
        tenantId: existing.role === 'developer' ? null : existing.admin_id,
        targetType: 'user',
        targetId: existing.id,
        targetLabel: email,
      })
      console.log(`two-step sign-in reset for ${email}; existing sessions revoked`)
      break
    }

    case 'list': {
      const users = await store.listUsers()
      for (const user of users)
        console.log(`${user.email}\t${user.role}\t${user.totp_enabled_at ? '2fa' : '-'}`)
      break
    }

    case 'revoke-gateway': {
      const sn = required('sn')
      await store.revokeGatewayCredential(sn)
      await consoleLine({
        action: 'cli.gateway_revoked',
        targetType: 'controller',
        targetId: sn,
        targetLabel: sn,
      })
      console.log(`revoked MQTT credentials for ${sn}`)
      break
    }

    case 'controller-list': {
      const status = arg('status')
      const rows = (await store.listEnrollments()).filter((row) => !status || row.status === status)
      if (rows.length === 0) console.log('no controllers enrolled')
      for (const row of rows) {
        console.log(
          [
            row.controller_sn,
            row.status,
            row.user_id ?? '-',
            row.aircraft_sns.join(',') || '-',
            row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
          ].join('\t'),
        )
      }
      break
    }

    case 'controller-approve': {
      const sn = required('sn')
      const by = arg('by') ?? 'cli'
      const approved = await store.approveEnrollment(sn, commaList('aircraft'), by)
      if (!approved) {
        console.error(`Could not approve ${sn}`)
        process.exit(1)
      }
      await store.logDeviceEvent(sn, 'controller.approved', { by, via: 'cli' })
      await consoleLine({
        action: 'cli.controller_changed',
        targetType: 'controller',
        targetId: sn,
        targetLabel: sn,
        details: { change: 'approved', by },
      })
      console.log(`approved ${sn}`)
      break
    }

    case 'controller-reject':
    case 'controller-unbind': {
      const sn = required('sn')
      const reason = arg('reason') ?? (command === 'controller-unbind' ? 'unbound' : 'rejected')
      const revoked = await store.revokeEnrollment(sn, arg('by') ?? 'cli', reason)
      if (!revoked) {
        console.error(`No enrolment for ${sn}`)
        process.exit(1)
      }
      await store.logDeviceEvent(
        sn,
        command === 'controller-unbind' ? 'controller.unbound' : 'controller.rejected',
        { via: 'cli', reason },
      )
      await consoleLine({
        action: 'cli.controller_changed',
        targetType: 'controller',
        targetId: sn,
        targetLabel: sn,
        details: { change: command === 'controller-unbind' ? 'unbound' : 'rejected', reason },
      })
      console.log(`revoked ${sn}: ${reason}`)
      break
    }

    default:
      usage()
  }

  await db.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
