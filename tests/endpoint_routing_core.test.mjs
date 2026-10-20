import test from 'node:test'
import assert from 'node:assert/strict'
import { createEndpointRouter, shouldInterceptEndpointClick } from '../web/src/core/endpoint-routing.ts'

// Node 24 executes the dependency-free core through native TypeScript stripping.
// All transports below are in-memory; these tests never contact a bookmark.
const turn = () => new Promise(resolve => setImmediate(resolve))
const opaque = () => ({ type: 'opaque', status: 0, redirected: false })
const http = (status = 200) => ({ type: 'cors', status, redirected: false })
const internal = (url = 'http://192.168.1.10/app', extra = {}) => ({ url, route: 'internal', ...extra })
const external = (url = 'https://public.example/app', extra = {}) => ({ url, route: 'external', ...extra })
const input = (endpoints = [internal(), external()], extra = {}) => ({ mainURL: 'https://main.example/home', endpoints, ...extra })

function controlledTransport() {
  const calls = []
  let active = 0
  let peak = 0
  function fetch(url, init) {
    const deferred = Promise.withResolvers()
    let settled = false
    active++
    peak = Math.max(peak, active)
    const finish = (kind, value) => {
      if (settled) return
      settled = true
      active--
      init.signal.removeEventListener('abort', abort)
      deferred[kind](value)
    }
    const abort = () => finish('reject', new DOMException('Aborted', 'AbortError'))
    calls.push({ url, init, respond: (response = http()) => finish('resolve', response), reject: (error = new TypeError('CORS, browser policy or network failure')) => finish('reject', error) })
    init.signal.addEventListener('abort', abort, { once: true })
    if (init.signal.aborted) abort()
    return deferred.promise
  }
  return { calls, fetch, get active() { return active }, get peak() { return peak } }
}

function setup(t, options = {}) {
  const transport = controlledTransport()
  const router = createEndpointRouter({ fetch: transport.fetch, ...options })
  t.after(() => router.dispose())
  return { router, transport }
}

test('construction, peek, unmarked endpoints, disabled mode and pre-abort cause no requests', async t => {
  const { router, transport } = setup(t)
  const marked = input()
  assert.equal(router.peek(marked).url, 'https://public.example/app')
  assert.equal(router.peek(marked).reason, 'fallback')
  const plain = input([{ label: 'Internal admin', url: 'http://10.0.0.1/admin?delete=all' }])
  assert.equal((await router.resolve(plain)).reason, 'no-candidates')
  assert.equal((await router.resolve(input([], { mainURL: 'http://10.0.0.2/main' }))).url, 'http://10.0.0.2/main')
  assert.deepEqual(await router.resolve({ ...marked, enabled: false }), {
    url: 'https://main.example/home', endpointIndex: null, route: 'primary', reason: 'disabled', cached: false,
  })
  assert.equal((await router.resolve(marked, { signal: AbortSignal.abort() })).reason, 'cancelled')
  router.clear()
  await turn()
  assert.equal(transport.calls.length, 0)
})

test('only configured origin and independent safe path are probed with restrictive Fetch options', async t => {
  const { router, transport } = setup(t)
  const target = 'http://192.168.1.20:8080/admin/remove?id=42&token=private#confirm'
  const result = router.resolve(input([
    { label: 'Documentation', url: 'https://docs.example/path' },
    internal(target),
    external('https://outside.example/session?secret=not-forwarded', { probePath: '/api/health' }),
  ]))
  await turn()
  assert.deepEqual(transport.calls.map(call => call.url), ['http://192.168.1.20:8080/favicon.ico', 'https://outside.example/api/health'])
  for (const call of transport.calls) {
    assert.equal(call.init.method, 'GET')
    assert.equal(call.init.mode, 'cors')
    assert.equal(call.init.credentials, 'omit')
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.cache, 'no-store')
    assert.equal(call.init.referrer, '')
    assert.equal(call.init.referrerPolicy, 'no-referrer')
    assert.equal(call.init.keepalive, false)
    assert.equal(call.init.headers, undefined)
    assert.equal(call.init.body, undefined)
  }
  assert.equal(transport.calls[0].init.targetAddressSpace, 'local')
  assert.equal(transport.calls[1].init.targetAddressSpace, undefined)
  transport.calls[0].respond()
  const decision = await result
  assert.equal(decision.url, target)
  assert.equal(decision.endpointIndex, 1)
  assert.equal(decision.evidence, 'http-response')
  assert.equal(decision.status, 200)
  assert.equal('latency' in decision, false)
  assert.equal('healthy' in decision, false)
  assert.equal(transport.calls[0].init.signal.aborted, true, 'stop unread response body')
  assert.equal(transport.calls[1].init.signal.aborted, true, 'stop losing probe')
})

test('known canonical loopback targets omit address hints; other internal entries retain local hints', async t => {
  const hints = [
    ['http://localhost/app', undefined], ['http://service.localhost/app', undefined],
    ['http://localhost./app', undefined], ['http://service.localhost./app', undefined],
    ['http://127.9.8.7/app', undefined], ['http://127.1/app', undefined], ['http://[::1]/app', undefined],
    ['http://[::ffff:127.0.0.1]/app', undefined],
    ['http://nas.local/app', 'local'], ['http://intranet.example/app', 'local'],
    ['http://localhost.example/app', 'local'], ['http://127.evil.example/app', 'local'],
    ['http://127.0.0.1.example/app', 'local'], ['http://126.255.255.255/app', 'local'],
    ['http://[::ffff:126.0.0.1]/app', 'local'], ['http://[fd00::1]/app', 'local'],
  ]
  for (const [url, hint] of hints) {
    const { router, transport } = setup(t)
    const result = router.resolve(input([internal(url)]))
    await turn()
    assert.equal(transport.calls[0].init.targetAddressSpace, hint, url)
    if (hint === undefined) assert.equal(Object.hasOwn(transport.calls[0].init, 'targetAddressSpace'), false, 'Loopback classification is left to ordinary browser Fetch')
    transport.calls[0].respond()
    await result
  }
  const { router, transport } = setup(t)
  const result = router.resolve(input([external('http://127.0.0.1/app')]))
  await turn()
  assert.equal(transport.calls[0].init.targetAddressSpace, undefined)
  transport.calls[0].respond()
  await result
})

test('unsafe paths and credential URLs never become probe requests', async t => {
  const badPaths = ['//other.example/x', '/a/../delete', '/./x', '/a/.', '/a/..', '/%2fdelete', '/health?token=x', '/health#x', '/a\\b', '/health\n', '/a b', '/你好', `/${'a'.repeat(256)}`, 'https://evil.example/health']
  for (const path of badPaths) {
    const { router, transport } = setup(t)
    assert.equal((await router.resolve(input([internal(undefined, { probePath: path })]))).reason, 'fallback', path)
    assert.equal(transport.calls.length, 0, path)
  }
  const { router, transport } = setup(t)
  const badURLs = ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '/relative', 'https://user:secret@example.com/app', 'https://@example.com/app', 'https://example.com:0/', 'https://exa mple.com/', 'https://example.com/\tsecret', 'https://example.com\\@private/']
  for (const url of badURLs) assert.equal((await router.resolve(input([internal(url)]))).reason, 'no-candidates', url)
  assert.equal(transport.calls.length, 0)
})

test('safe path subset preserves path exactly and empty path uses favicon', async t => {
  for (const [path, expected] of [['', '/favicon.ico'], ['/', '/'], ['/api/v1/health_ready-~.json', '/api/v1/health_ready-~.json'], [`/${'a'.repeat(255)}`, `/${'a'.repeat(255)}`]]) {
    const { router, transport } = setup(t)
    const result = router.resolve(input([internal('https://nas.example/unrelated?operation=delete', { probePath: path })]))
    await turn()
    assert.equal(transport.calls[0].url, `https://nas.example${expected}`)
    transport.calls[0].respond()
    await result
  }
})

test('only first twelve endpoint records participate; invalid namespace fails closed', async t => {
  const { router, transport } = setup(t)
  const endpoints = Array.from({ length: 12 }, (_, n) => ({ url: `https://docs${n}.example/`, label: 'extra' }))
  endpoints.push(internal())
  assert.equal((await router.resolve(input(endpoints))).reason, 'no-candidates')
  assert.equal((await router.resolve(input([internal()], { contextKey: 'x'.repeat(513) }))).reason, 'no-candidates')
  assert.equal(transport.calls.length, 0)
})

test('only readable HTTP responses establish evidence; opaque results, redirects and CORS failures stay unknown', async t => {
  for (const type of ['basic', 'cors']) for (const status of [200, 204, 304, 404, 500]) {
    const { router, transport } = setup(t)
    const result = router.resolve(input([internal()]))
    await turn()
    transport.calls[0].respond({ ...http(status), type })
    const decision = await result
    assert.equal(decision.reason, 'response')
    assert.equal(decision.evidence, 'http-response')
    assert.equal(decision.status, status)
  }
  for (const response of [opaque(), { type: 'opaque', status: 200 }, { type: 'error', status: 0 }, { type: 'opaqueredirect', status: 0 }, { type: 'opaqueredirect', status: 200 }, { type: 'default', status: 200 }, { type: 'basic', status: 0 }, { type: 'cors', status: 200, redirected: true }, http(103), ...[301, 302, 303, 307, 308].map(http)]) {
    const { router, transport } = setup(t)
    const result = router.resolve(input([internal()]))
    await turn()
    transport.calls[0].respond(response)
    const decision = await result
    assert.equal(decision.reason, 'fallback')
    assert.equal(decision.route, 'primary')
    assert.equal(decision.status, undefined)
    assert.equal(decision.evidence, undefined)
  }
  const router = createEndpointRouter({ fetch() { throw new TypeError('CORS, permission, mixed content, DNS or certificate failure') } })
  t.after(() => router.dispose())
  assert.equal((await router.resolve(input([internal()]))).reason, 'fallback')
})

test('first responding internal wins; unstarted candidates are not probed unnecessarily', async t => {
  const { router, transport } = setup(t)
  const result = router.resolve(input([external(), internal('http://10.0.0.1/app'), internal('http://10.0.0.2/app'), internal('http://10.0.0.3/app')]))
  await turn()
  assert.deepEqual(transport.calls.map(call => call.url), ['http://10.0.0.1/favicon.ico', 'http://10.0.0.2/favicon.ico'])
  transport.calls[1].respond()
  assert.equal((await result).url, 'http://10.0.0.2/app')
  await turn()
  assert.equal(transport.calls.length, 2)
  assert.equal(transport.active, 0)
})

test('external response waits for internal evidence within the same budget', async t => {
  const { router, transport } = setup(t)
  let done = false
  const result = router.resolve(input()).then(value => { done = true; return value })
  await turn()
  transport.calls[1].respond()
  await turn()
  assert.equal(done, false)
  transport.calls[0].respond()
  assert.equal((await result).route, 'internal')
})

test('all unknown observations preserve first configured external path or main fallback', async t => {
  const { router, transport } = setup(t)
  const result = router.resolve(input([internal(), external('https://first.example/path?keep=1'), external('https://second.example/path')]))
  await turn()
  transport.calls[0].reject()
  transport.calls[1].reject()
  await turn()
  assert.equal(transport.calls.length, 3)
  transport.calls[2].reject()
  assert.deepEqual(await result, {
    url: 'https://first.example/path?keep=1', endpointIndex: 1, route: 'external', reason: 'fallback', cached: false,
  })
})

test('observable external is preferred to an earlier unknown external', async t => {
  const { router, transport } = setup(t)
  const result = router.resolve(input([internal(), external('https://first.example/path'), external('https://second.example/path')]))
  await turn()
  transport.calls[0].reject()
  transport.calls[1].reject()
  await turn()
  transport.calls[2].respond(http(503))
  const decision = await result
  assert.equal(decision.url, 'https://second.example/path')
  assert.equal(decision.status, 503)
})

test('click deadline aborts stalled probes and returns observable external without waiting indefinitely', async t => {
  const { router, transport } = setup(t, { budgetMs: 20 })
  const result = router.resolve(input())
  await turn()
  transport.calls[1].respond()
  const decision = await result
  assert.equal(decision.route, 'external')
  assert.equal(decision.reason, 'response')
  assert.equal(transport.calls[0].init.signal.aborted, true)
  assert.equal(transport.active, 0)
  assert.equal(transport.calls.length, 2)
})

test('positive and unknown TTLs expire only on a subsequent click, with no idle refresh', async t => {
  let now = 1000
  const { router, transport } = setup(t, { now: () => now, positiveTTLms: 100, negativeTTLms: 10 })
  const data = input()
  const first = router.resolve(data)
  await turn()
  transport.calls[0].reject()
  transport.calls[1].respond()
  assert.equal((await first).route, 'external')
  assert.equal((await router.resolve(data)).cached, true)
  assert.equal(transport.calls.length, 2)
  now += 11
  assert.equal(router.peek(data).cached, true)
  await turn()
  assert.equal(transport.calls.length, 2, 'peek and clock advance do not probe')
  const second = router.resolve(data)
  await turn()
  assert.equal(transport.calls.length, 3, 'expired unknown internal is retried despite cached external')
  transport.calls[2].respond()
  assert.equal((await second).route, 'internal')
  assert.equal(router.peek(data).cached, true)
  now += 101
  assert.equal(router.peek(data).reason, 'fallback')
  await turn()
  assert.equal(transport.calls.length, 3)
})

test('same origin/path/context deduplicates in flight and cache while navigation destinations remain distinct', async t => {
  const { router, transport } = setup(t)
  const firstData = input([internal('http://10.0.0.7/app?a=1')], { contextKey: 'space-a:user-1:epoch-1' })
  const secondData = input([internal('http://10.0.0.7/admin#settings')], { contextKey: 'space-a:user-1:epoch-1' })
  const first = router.resolve(firstData)
  const second = router.resolve(secondData)
  await turn()
  assert.equal(transport.calls.length, 1)
  transport.calls[0].respond()
  assert.equal((await first).url, 'http://10.0.0.7/app?a=1')
  assert.equal((await second).url, 'http://10.0.0.7/admin#settings')
  assert.equal((await router.resolve(secondData)).cached, true)
  assert.equal(transport.calls.length, 1)
})

test('spaces, identities, roles and probe paths do not share cached routing evidence', async t => {
  const { router, transport } = setup(t)
  const variations = [
    input([internal()], { contextKey: 'space-a:user-1:epoch-1' }),
    input([internal()], { contextKey: 'space-b:user-1:epoch-1' }),
    input([internal()], { contextKey: 'space-a:user-2:epoch-1' }),
    input([internal()], { contextKey: 'space-a:user-1:epoch-2' }),
    input([external('http://192.168.1.10/app')], { contextKey: 'space-a:user-1:epoch-1' }),
    input([internal(undefined, { probePath: '/healthz' })], { contextKey: 'space-a:user-1:epoch-1' }),
  ]
  for (const data of variations) {
    const previous = transport.calls.length
    const result = router.resolve(data)
    await turn()
    assert.equal(transport.calls.length, previous + 1)
    transport.calls.at(-1).respond()
    assert.equal((await result).cached, false)
  }
})

test('concurrent clicks share a two-request cap and release slots for waiting candidates', async t => {
  const { router, transport } = setup(t)
  const first = router.resolve(input([internal('http://10.0.0.1/')]))
  const second = router.resolve(input([internal('http://10.0.0.2/')]))
  const third = router.resolve(input([internal('http://10.0.0.3/')]))
  await turn()
  assert.equal(transport.calls.length, 2)
  assert.equal(transport.active, 2)
  transport.calls[0].reject()
  await first
  await turn()
  assert.equal(transport.calls.length, 3)
  assert.equal(transport.active, 2)
  transport.calls[1].respond()
  transport.calls[2].respond()
  assert.equal((await second).route, 'internal')
  assert.equal((await third).route, 'internal')
  assert.equal(transport.peak, 2)
})

test('in-memory evidence has bounded LRU storage', async t => {
  const { router, transport } = setup(t, { maxCacheEntries: 2 })
  const data = [1, 2, 3].map(id => input([internal(`http://10.0.0.${id}/`)]))
  for (const entry of data.slice(0, 2)) {
    const result = router.resolve(entry)
    await turn()
    transport.calls.at(-1).respond()
    await result
  }
  assert.equal(router.peek(data[0]).cached, true, 'touch the oldest entry')
  const third = router.resolve(data[2])
  await turn()
  transport.calls.at(-1).respond()
  await third
  assert.equal(router.peek(data[0]).cached, true)
  assert.equal(router.peek(data[1]).reason, 'fallback')
  assert.equal(router.peek(data[2]).cached, true)
  assert.equal(transport.calls.length, 3)
})

test('cancelling one click does not abort a shared probe still needed by another click', async t => {
  const { router, transport } = setup(t)
  const controller = new AbortController()
  const first = router.resolve(input([internal()]), { signal: controller.signal })
  const second = router.resolve(input([internal()]))
  await turn()
  controller.abort()
  assert.equal((await first).reason, 'cancelled')
  assert.equal(transport.calls.length, 1)
  assert.equal(transport.calls[0].init.signal.aborted, false)
  transport.calls[0].respond()
  assert.equal((await second).reason, 'response')
})

test('clear cancels waiting decisions, prevents late cache writes and allows later clicks', async t => {
  const late = Promise.withResolvers()
  let calls = 0
  const router = createEndpointRouter({ fetch() { calls++; return late.promise } })
  t.after(() => router.dispose())
  const result = router.resolve(input([internal()]))
  await turn()
  router.clear()
  assert.equal((await result).reason, 'cancelled')
  late.resolve(http())
  await turn()
  assert.equal(router.peek(input([internal()])).reason, 'fallback')
  assert.equal((await router.resolve(input([internal()]))).cached, false)
  assert.equal(calls, 2)
})

test('clear before fetch microtask prevents network; dispose permanently stops routing', async t => {
  const { router, transport } = setup(t)
  const result = router.resolve(input())
  router.clear()
  assert.equal((await result).reason, 'cancelled')
  await turn()
  assert.equal(transport.calls.length, 0)
  router.dispose()
  assert.equal((await router.resolve(input())).reason, 'cancelled')
  assert.equal(router.peek(input()).reason, 'cancelled')
  await turn()
  assert.equal(transport.calls.length, 0)
})

test('cancelled losing probe does not poison the next click with an unknown TTL', async t => {
  const { router, transport } = setup(t)
  const first = router.resolve(input([internal('http://10.0.0.1/'), internal('http://10.0.0.2/')]))
  await turn()
  transport.calls[0].respond()
  await first
  const second = router.resolve(input([internal('http://10.0.0.2/')]))
  await turn()
  assert.equal(transport.calls.length, 3)
  transport.calls[2].respond()
  assert.equal((await second).reason, 'response')
})

test('click interception preserves modified clicks, middle click and prior handlers', () => {
  assert.equal(shouldInterceptEndpointClick({ button: 0 }), true)
  for (const event of [{ button: 1 }, { button: 2 }, { button: 0, defaultPrevented: true }, { button: 0, ctrlKey: true }, { button: 0, metaKey: true }, { button: 0, shiftKey: true }, { button: 0, altKey: true }]) {
    assert.equal(shouldInterceptEndpointClick(event), false)
  }
})
