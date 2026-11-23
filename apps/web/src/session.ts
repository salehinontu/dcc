const SESSION_HINT = 'dji_session_hint'

/**
 * The API sets this non-HttpOnly marker next to the real, HttpOnly session cookie. The app
 * uses it to decide whether a session might exist, so a fresh visitor never calls /api/me
 * just to receive a 401.
 */
export function hasSessionHint(): boolean {
  return document.cookie.split('; ').includes(`${SESSION_HINT}=1`)
}

export function clearSessionHint(): void {
  document.cookie = `${SESSION_HINT}=; Max-Age=0; Path=/; SameSite=Lax`
}
