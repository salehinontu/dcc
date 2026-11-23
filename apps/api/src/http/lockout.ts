import { config } from '../config'
import type { Store, UserRow } from '../store'

/**
 * Password lock-out: after `LOGIN_MAX_FAILURES` wrong passwords in a row an account's sign-in is closed for
 * `LOGIN_LOCK_MINUTES`, whoever asks and from wherever, so guessing a password is slow even across many addresses. A
 * right password ends the count; a new password set by an administrator (or at the console) lifts a lock. It works on
 * both sign-ins: the dashboard (`/api/auth/login`) and the controller (`/api/pilot/auth`).
 */
export function lockedUntil(user: UserRow): Date | null {
  if (!user.login_locked_until) return null
  const until = new Date(user.login_locked_until)
  return until.getTime() > Date.now() ? until : null
}

export function lockMessage(until: Date): string {
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000))
  return `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask an administrator to set a new password.`
}

/** Counts a wrong password against an existing, enabled account; returns the lock this began, if any. */
export async function countWrongPassword(store: Store, user: UserRow | null): Promise<Date | null> {
  if (!user || user.disabled) return null
  return store.recordLoginFailure(user.id, config.loginMaxFailures, config.loginLockSeconds)
}
