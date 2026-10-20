/** Browser-local routing for explicitly configured bookmark alternatives.
 * Constructing, peeking, clearing and disposing never start network requests.
 * Call resolve only from an intentional navigation click, never from rendering,
 * prefetch, hover, focus or a periodic task. A readable response is reachability
 * evidence, not a health check or a latency measurement. Cross-origin probe
 * paths must authorize this Home origin through CORS; opaque results are unknown.
 */

export type RoutingEndpoint = Readonly<{
  label?: string
  url: string
  route?: 'internal' | 'external'
  probePath?: string
}>

export type EndpointRoutingInput = Readonly<{
  mainURL: string
  endpoints: readonly RoutingEndpoint[]
  enabled?: boolean
  /** Include the current space and authentication identity/epoch. */
  contextKey?: string
}>

export type EndpointRouteDecision = Readonly<{
  url: string
  endpointIndex: number | null
  route: 'internal' | 'external' | 'primary'
  reason: 'response' | 'fallback' | 'disabled' | 'no-candidates' | 'cancelled'
  cached: boolean
  evidence?: 'http-response'
  status?: number
}>

export type EndpointRouterOptions = Readonly<{
  fetch?: typeof globalThis.fetch
  now?: () => number
  budgetMs?: number
  positiveTTLms?: number
  negativeTTLms?: number
  maxCacheEntries?: number
}>

export type EndpointRouter = Readonly<{
  peek(input: EndpointRoutingInput): EndpointRouteDecision
  resolve(input: EndpointRoutingInput, options?: { signal?: AbortSignal }): Promise<EndpointRouteDecision>
  clear(): void
  dispose(): void
}>

export function shouldInterceptEndpointClick(event: {
  button: number
  defaultPrevented?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}): boolean {
  return event.button === 0 && !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
}

const MAX_ENDPOINTS = 12
const MAX_ACTIVE_PROBES = 2
const MAX_PENDING_RESOLUTIONS = 32
const DEFAULT_PROBE_PATH = '/favicon.ico'

type Candidate = {
  endpointIndex: number
  route: 'internal' | 'external'
  url: string
  probeURL: string | null
  key: string
  addressSpace?: 'local'
}
type Plan = { mainURL: string; enabled: boolean; candidates: Candidate[] }
type Observation = { responded: boolean; evidence?: 'http-response'; status?: number }
type CacheEntry = { observation: Observation; expiresAt: number }
type Probe = {
  promise: Promise<Observation>
  users: number
  stop(cacheUnknown: boolean): void
}
type CandidateState = {
  candidate: Candidate
  observation?: Observation
  cached: boolean
  probe?: Probe
}

const unknown = (): Observation => ({ responded: false })

function boundedOption(value: number | undefined, fallback: number, maximum: number, minimum = 1): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback
}

function navigationURL(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096 || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(raw)) return null
  if (/^https?:\/\/[^/?#]*@/i.test(raw)) return null
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password || url.port === '0') return null
    return url
  } catch {
    return null
  }
}

function probePath(raw: unknown): string | null {
  if (raw === undefined || raw === '') return DEFAULT_PROBE_PATH
  if (typeof raw !== 'string' || raw.length > 256 || !/^\/(?!\/)[A-Za-z0-9/_.~-]*$/.test(raw)) return null
  if (raw.split('/').some(segment => segment === '.' || segment === '..')) return null
  return raw
}

function internalAddressSpace(url: URL): 'local' | undefined {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  // Let the browser classify known loopback targets itself. An incompatible
  // local hint can reject an otherwise permitted loopback fetch in Chromium.
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(host) || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)) return undefined
  return 'local'
}

function makePlan(input: EndpointRoutingInput): Plan {
  const plan: Plan = { mainURL: navigationURL(input.mainURL)?.href || '', enabled: input.enabled !== false, candidates: [] }
  if (!Array.isArray(input.endpoints)) return plan
  const context = input.contextKey ?? ''
  // Refuse an invalid namespace instead of collapsing distinct identities into
  // the same cache key. Normal application identities fit comfortably here.
  if (typeof context !== 'string' || context.length > 512) return plan
  input.endpoints.slice(0, MAX_ENDPOINTS).forEach((endpoint, endpointIndex) => {
    if (!endpoint || (endpoint.route !== 'internal' && endpoint.route !== 'external')) return
    const url = navigationURL(endpoint.url)
    if (!url) return
    const path = probePath(endpoint.probePath)
    const probe = path === null ? null : new URL(path, url.origin)
    const probeURL = probe && probe.origin === url.origin && probe.pathname === path ? probe.href : null
    const addressSpace = endpoint.route === 'internal' ? internalAddressSpace(url) : undefined
    plan.candidates.push({ endpointIndex, route: endpoint.route, url: url.href, probeURL, addressSpace,
      key: JSON.stringify([context, endpoint.route, probeURL]) })
  })
  // Stable configuration order is retained within each role. Internal probes
  // get the two available slots first; whichever responds first can be used.
  plan.candidates.sort((a, b) => Number(a.route === 'external') - Number(b.route === 'external'))
  return plan
}

function fallback(plan: Plan, reason: EndpointRouteDecision['reason'] = 'fallback'): EndpointRouteDecision {
  const external = plan.enabled && reason !== 'disabled' ? plan.candidates.find(candidate => candidate.route === 'external') : undefined
  return { url: external?.url || plan.mainURL, endpointIndex: external?.endpointIndex ?? null,
    route: external ? 'external' : 'primary', reason, cached: false }
}

function selected(state: CandidateState): EndpointRouteDecision {
  return { url: state.candidate.url, endpointIndex: state.candidate.endpointIndex, route: state.candidate.route,
    reason: 'response', cached: state.cached, evidence: state.observation?.evidence,
    ...(state.observation?.status === undefined ? {} : { status: state.observation.status }) }
}

function responseObservation(response: Response): Observation {
  if (response.redirected || (response.type !== 'basic' && response.type !== 'cors')) return unknown()
  // Readable 4xx/5xx responses still establish an HTTP response. They do not
  // prove that the intended application is healthy or that navigation succeeds.
  if (Number.isInteger(response.status) && response.status >= 200 && response.status <= 599 && ![301, 302, 303, 307, 308].includes(response.status)) {
    return { responded: true, evidence: 'http-response', status: response.status }
  }
  return unknown()
}

export function createEndpointRouter(options: EndpointRouterOptions = {}): EndpointRouter {
  const now = options.now ?? (() => globalThis.performance?.now() ?? Date.now())
  const fetcher: typeof globalThis.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const budgetMs = boundedOption(options.budgetMs, 800, 800)
  const positiveTTL = boundedOption(options.positiveTTLms, 30_000, 30_000, 0)
  const negativeTTL = boundedOption(options.negativeTTLms, 5_000, 5_000, 0)
  const maxCache = boundedOption(options.maxCacheEntries, 128, 128)
  const cache = new Map<string, CacheEntry>()
  const active = new Map<string, Probe>()
  const pumps = new Set<() => void>()
  const cancellations = new Set<() => void>()
  let generation = 0
  let disposed = false

  function cached(candidate: Candidate): Observation | undefined {
    if (!candidate.probeURL) return undefined
    const entry = cache.get(candidate.key)
    if (!entry) return undefined
    if (entry.expiresAt <= now()) { cache.delete(candidate.key); return undefined }
    cache.delete(candidate.key)
    cache.set(candidate.key, entry)
    return entry.observation
  }

  function remember(key: string, observation: Observation): void {
    const ttl = observation.responded ? positiveTTL : negativeTTL
    if (ttl <= 0) return
    cache.delete(key)
    cache.set(key, { observation, expiresAt: now() + ttl })
    while (cache.size > maxCache) cache.delete(cache.keys().next().value!)
  }

  function wake(): void {
    // Notification is driven solely by an active request finishing or releasing
    // its slot. There is no polling loop or timer for an idle queue/cache.
    queueMicrotask(() => { for (const pump of [...pumps]) pump() })
  }

  function acquire(candidate: Candidate): Probe | undefined {
    if (!candidate.probeURL) return undefined
    const prior = active.get(candidate.key)
    if (prior) { prior.users++; return prior }
    if (active.size >= MAX_ACTIVE_PROBES) return undefined
    const controller = new AbortController()
    const epoch = generation
    let finished = false
    let complete!: (observation: Observation) => void
    const promise = new Promise<Observation>(resolve => { complete = resolve })
    let timer: ReturnType<typeof setTimeout> | undefined
    const probe: Probe = { promise, users: 1, stop: cacheUnknown => finish(unknown(), cacheUnknown) }
    function finish(observation: Observation, cacheResult: boolean): void {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
      if (active.get(candidate.key) === probe) active.delete(candidate.key)
      if (cacheResult && !disposed && generation === epoch) remember(candidate.key, observation)
      complete(observation)
      wake()
    }
    active.set(candidate.key, probe)
    timer = setTimeout(() => finish(unknown(), true), budgetMs)
    const request: RequestInit & { targetAddressSpace?: 'local' } = {
      // Fetch rejects no-cors with any redirect mode other than follow. CORS
      // allows us to enforce the no-redirect boundary; missing permission is
      // an unknown result and retains the external/primary navigation fallback.
      method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
      referrer: '', referrerPolicy: 'no-referrer', keepalive: false, signal: controller.signal,
      ...(candidate.addressSpace ? { targetAddressSpace: candidate.addressSpace } : {}) }
    // Deferral lets the task enter the deduplication map before even a
    // synchronously throwing injected transport runs. A clear before this
    // microtask also prevents the request from starting.
    Promise.resolve().then(() => {
      if (finished || controller.signal.aborted || disposed || generation !== epoch) return
      return fetcher(candidate.probeURL!, request)
    }).then(response => {
      if (response) finish(responseObservation(response), true)
    }).catch(() => finish(unknown(), true))
    return probe
  }

  function release(probe: Probe, timedOut: boolean): void {
    probe.users--
    if (probe.users === 0) probe.stop(timedOut)
  }

  function initialStates(plan: Plan): CandidateState[] {
    return plan.candidates.map(candidate => {
      const observation = cached(candidate)
      return { candidate, observation: candidate.probeURL ? observation : unknown(), cached: observation !== undefined }
    })
  }

  function best(plan: Plan, states: CandidateState[]): EndpointRouteDecision {
    const winner = states.find(state => state.candidate.route === 'internal' && state.observation?.responded)
      ?? states.find(state => state.candidate.route === 'external' && state.observation?.responded)
    return winner ? selected(winner) : fallback(plan)
  }

  function peek(input: EndpointRoutingInput): EndpointRouteDecision {
    const plan = makePlan(input)
    if (disposed) return fallback(plan, 'cancelled')
    if (!plan.enabled) return fallback(plan, 'disabled')
    if (!plan.candidates.length) return fallback(plan, 'no-candidates')
    return best(plan, initialStates(plan))
  }

  function resolve(input: EndpointRoutingInput, request: { signal?: AbortSignal } = {}): Promise<EndpointRouteDecision> {
    const plan = makePlan(input)
    if (disposed || request.signal?.aborted) return Promise.resolve(fallback(plan, 'cancelled'))
    if (!plan.enabled) return Promise.resolve(fallback(plan, 'disabled'))
    if (!plan.candidates.length) return Promise.resolve(fallback(plan, 'no-candidates'))
    const states = initialStates(plan)
    if (states.some(state => state.candidate.route === 'internal' && state.observation?.responded)
      || states.every(state => state.observation !== undefined)) return Promise.resolve(best(plan, states))
    if (cancellations.size >= MAX_PENDING_RESOLUTIONS) return Promise.resolve(best(plan, states))
    const epoch = generation
    return new Promise<EndpointRouteDecision>(complete => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      function finish(decision: EndpointRouteDecision, timedOut = false): void {
        if (finished) return
        finished = true
        if (timer !== undefined) clearTimeout(timer)
        request.signal?.removeEventListener('abort', cancel)
        cancellations.delete(cancel)
        pumps.delete(pump)
        for (const state of states) if (state.probe) release(state.probe, timedOut && state.observation === undefined)
        complete(decision)
      }
      function cancel(): void { finish(fallback(plan, 'cancelled')) }
      function pump(): void {
        if (finished) return
        if (disposed || generation !== epoch || request.signal?.aborted) { cancel(); return }
        const internal = states.find(state => state.candidate.route === 'internal' && state.observation?.responded)
        if (internal) { finish(selected(internal)); return }
        const pendingInternal = states.some(state => state.candidate.route === 'internal' && state.observation === undefined)
        const external = states.find(state => state.candidate.route === 'external' && state.observation?.responded)
        if (!pendingInternal && external) { finish(selected(external)); return }
        for (const state of states) {
          if (state.observation !== undefined || state.probe) continue
          const observation = cached(state.candidate)
          if (observation) {
            state.observation = observation
            state.cached = true
            if (observation.responded && (state.candidate.route === 'internal'
              || !states.some(candidate => candidate.candidate.route === 'internal' && candidate.observation === undefined))) {
              finish(selected(state)); return
            }
            continue
          }
          const probe = acquire(state.candidate)
          if (!probe) continue
          state.probe = probe
          probe.promise.then(observation => {
            if (finished) return
            state.observation = observation
            pump()
          })
        }
        if (states.every(state => state.observation !== undefined)) finish(best(plan, states))
      }
      cancellations.add(cancel)
      pumps.add(pump)
      request.signal?.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(() => finish(best(plan, states), true), budgetMs)
      pump()
    })
  }

  function clear(): void {
    generation++
    cache.clear()
    for (const cancel of [...cancellations]) cancel()
    for (const probe of [...active.values()]) probe.stop(false)
  }

  return { peek, resolve, clear, dispose() { disposed = true; clear() } }
}
