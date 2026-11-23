// Vite inlines BASE_URL at build time and always ends it with a slash. A root deployment
// yields '/', so basePath is ''; a path deployment such as /drone-fleet/ yields
// '/drone-fleet', and every absolute app URL has to carry that prefix.
export const basePath = import.meta.env.BASE_URL.replace(/\/$/, '')

export function withBase(path: string): string {
  return `${basePath}${path}`
}
