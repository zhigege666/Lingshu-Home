/**
 * Keep renewal response cookies ahead of login/logout/password responses.
 * JSON identity checks cannot prevent a late response header replacing a new
 * browser cookie. Only cookie-changing requests share this queue; normal data
 * reads and writes remain independent.
 */
export const sessionVerifiedEvent = 'lingshu:session-verified'

export function changesSessionCookie(path: string, method: string) {
  const route = path.split('?')[0]
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) &&
    (route === '/setup' || route.startsWith('/auth/') || route === '/account/password' ||
     route.startsWith('/account/sessions/') || route === '/settings' || route === '/settings/session-policy')
}

/** A bootstrap response may update CSRF state only in the session that requested it. */
export function createSessionReadGuard() {
  let generation = 0, latest = 0
  return {
    invalidate() { generation++ },
    capture() {
      const expected = generation, sequence = ++latest
      return () => generation === expected && latest === sequence
    },
  }
}

export function createSessionRequestQueue() {
  let tail: Promise<void> = Promise.resolve()
  return function run<T>(path: string, method: string, request: () => Promise<T>): Promise<T> {
    if (!changesSessionCookie(path, method)) return request()
    const result = tail.then(request)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
}
