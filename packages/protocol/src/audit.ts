/** How an audited request ended: it was done, it was refused as not allowed, or it failed (bad input, wrong password...). */
export const AUDIT_OUTCOMES = ['success', 'failure', 'denied'] as const
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

/** One line of the audit trail. The hash ties it to the line before it, so a change or a gap shows. */
export interface AuditEvent {
  seq: number
  /** When it happened, an ISO instant. */
  time: string
  actorEmail: string | null
  actorRole: string | null
  /** A dotted code such as `user.updated`; the part before the dot is its category. */
  action: string
  outcome: AuditOutcome
  /** The HTTP status the request ended with, where there was one. */
  status: number | null
  targetType: string | null
  targetId: string | null
  /** What the target was called when it happened (an email, a drone's name...), so it reads after a delete. */
  targetLabel: string | null
  details: Record<string, unknown> | null
  ip: string | null
  userAgent: string | null
  hash: string
}

export interface AuditFilter {
  /** Instants, ISO. */
  from?: string
  to?: string
  /** Part of an account's email: what that account did, and what was done to it. */
  actor?: string
  /** The first part of an action code: `user`, `recording`... */
  category?: string
  outcome?: AuditOutcome
  /** Words looked for in the actor, action, target, address and details. */
  q?: string
}

export interface AuditPage {
  events: AuditEvent[]
  total: number
  /** The categories present in the trail, to fill the filter. */
  categories: string[]
}

/** The answer of the integrity check. */
export interface AuditIntegrity {
  ok: boolean
  checked: number
  headSeq: number
  headHash: string
  /** The first line that does not fit, when `ok` is false. */
  brokenAt?: number
  reason?: string
  /** Lines a Developer deleted on purpose (each deletion is itself recorded). Their place in the chain still checks out. */
  redacted?: number
}

/** What each action code means in words, for the screen and the export. A code not listed shows as itself. */
export const AUDIT_ACTIONS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.password_accepted': 'Password accepted, waiting for the two-step code',
  'auth.mfa_setup_started': 'Started setting up two-step sign-in',
  'auth.mfa_enabled': 'Turned on two-step sign-in',
  'auth.mfa_disabled': 'Turned off two-step sign-in',
  'auth.mfa_recovery_codes': 'Made new recovery codes',
  'auth.password_changed': 'Changed own password',
  'auth.email_changed': 'Changed own sign-in email',
  'pilot.login': 'Drone operator account signed in on a controller',
  'pilot.controller_login': 'Controller asked to be enrolled',
  'pilot.credentials_issued': 'Controller was given its MQTT credentials',
  'pilot.bind': 'Controller bound a drone',
  'user.created': 'Created an account',
  'user.updated': 'Changed an account',
  'user.deleted': 'Deleted an account',
  'user.mfa_reset': 'Reset an account’s two-step sign-in',
  'controller.approved': 'Approved a controller',
  'controller.rejected': 'Rejected a controller',
  'controller.unbound': 'Unbound a controller',
  'drone.updated': 'Changed a drone (name, label, colour)',
  'drone.deleted': 'Deleted a drone',
  'drone.disabled': 'Paused or resumed a drone',
  'video_source.created': 'Added a video-only drone',
  'video_source.rekeyed': 'Gave a video-only drone a new address',
  'video_source.deleted': 'Removed a video-only drone',
  'stream.viewed': 'Opened a live feed',
  'stream.frame': 'Took pictures from a live feed through the API',
  'api_token.created': 'Made an API token',
  'api_token.revoked': 'Revoked an API token',
  'stream.stopped': 'Stopped a live feed for everyone',
  'stream.resumed': 'Resumed a live feed',
  'stream.updated': 'Changed a feed’s quality',
  'screenshot.captured': 'Captured a screenshot',
  'screenshot.downloaded': 'Downloaded a screenshot',
  'screenshot.deleted': 'Deleted screenshots',
  'screenshot.people_counted': 'Counted people in a screenshot',
  'screenshot.people_verified': 'Verified a people count',
  'recording.started': 'Started a server recording',
  'recording.stopped': 'Stopped a server recording',
  'recording.auto_changed': 'Changed automatic recording of a drone',
  'recording.uploaded': 'Uploaded a video',
  'recording.played': 'Played a recording',
  'recording.downloaded': 'Downloaded a recording',
  'recording.deleted': 'Deleted a recording',
  'recording.annotated': 'Changed the tags or note of a recording',
  'recording.location_changed': 'Changed the folder videos are kept in',
  'recording.folder_created': 'Made a folder on the server',
  'zone.created': 'Drew a zone',
  'zone.updated': 'Changed a zone',
  'zone.deleted': 'Deleted a zone',
  'alert.acknowledged': 'Acknowledged an alert',
  'audit.started': 'The audit trail was started',
  'audit.exported': 'Exported the audit trail',
  'audit.verified': 'Checked the audit trail’s integrity',
  'audit.deleted': 'Deleted audit lines',
  'cli.user_created': 'Server console: created an account',
  'cli.password_reset': 'Server console: reset a password',
  'cli.developer_created': 'Server console: created a Developer',
  'cli.mfa_reset': 'Server console: reset an account’s two-step sign-in',
  'cli.gateway_revoked': 'Server console: revoked a controller’s credentials',
  'cli.controller_changed': 'Server console: changed a controller’s enrolment',
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTIONS[action] ?? action
}
