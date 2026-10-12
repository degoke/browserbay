import assert from 'node:assert/strict'
import test from 'node:test'
import { TOKEN_HEADER } from '../protocol.js'
import { BrowserBoxError, NoCapacityError, createBrowserBox, type BrowserBoxOptions } from './index.js'

const API_KEY = 'box-api-key-0123456789'
const BOX = 'https://browsers.example.com'
const NOW = Date.parse('2026-10-11T12:00:00.000Z')

interface BoxCall {
  method: string
  url: URL
  headers: Record<string, string>
  body?: Record<string, any>
}

interface BoxSlot {
  slotId: string
  runId: string
  nodeId: string
  createdAt: string
  token: string
}

/**
 * A stand-in for the relay's REST surface: a slot table behind the same auth rules (API key for create, list and
 * release; the slot's own token for looking it up). `slotLookups` scripts the next lookups before the table answers,
 * to simulate a box that is restarting or a network that drops a request.
 */
function fakeBox(
  options: {
    /** A path prefix the box is served under (a reverse proxy). */
    prefix?: string
    createStatus?: number
    createBody?: unknown
    deleteStatus?: (slotId: string) => number
    listStatus?: number
    slotLookups?: Array<'network' | number>
    now?: () => number
  } = {}
) {
  const calls: BoxCall[] = []
  const slots = new Map<string, BoxSlot>()
  const slotLookups = options.slotLookups ?? []
  const prefix = options.prefix ?? ''
  let counter = 0

  const reply = (status: number, body?: unknown) =>
    new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status })
  const summary = ({ slotId, runId, nodeId, createdAt }: BoxSlot) => ({ slotId, runId, nodeId, createdAt })

  /** A slot that already exists on the box, as the reaper sees it. */
  function seed(slotId: string, runId: string, ageMinutes: number) {
    slots.set(slotId, {
      slotId,
      runId,
      nodeId: 'node-1',
      createdAt: new Date(NOW - ageMinutes * 60_000).toISOString(),
      token: `token-of-${slotId}`
    })
  }

  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    calls.push({ method, url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined })

    if (!url.pathname.startsWith(prefix)) return reply(404, { error: 'not_found' })
    const path = url.pathname.slice(prefix.length)
    const asOwner = headers.Authorization === `Bearer ${API_KEY}`

    if (path === '/v1/slots' && method === 'POST') {
      if (!asOwner) return reply(401, { error: 'unauthorized' })
      if (options.createStatus && options.createStatus !== 201) return reply(options.createStatus)
      if (options.createBody !== undefined) return reply(201, options.createBody)
      const slotId = `slot-${++counter}`
      const slot: BoxSlot = {
        slotId,
        runId: String(JSON.parse(String(init?.body)).runId),
        nodeId: 'node-1',
        createdAt: new Date((options.now ?? Date.now)()).toISOString(),
        token: `slot-token-${counter}-PLAINTEXT`
      }
      slots.set(slotId, slot)
      return reply(201, { slotId, token: slot.token, nodeId: slot.nodeId })
    }

    if (path === '/v1/slots' && method === 'GET') {
      if (!asOwner) return reply(401, { error: 'unauthorized' })
      if (options.listStatus && options.listStatus !== 200) return reply(options.listStatus)
      return reply(200, { slots: [...slots.values()].map(summary) })
    }

    if (path === '/v1/nodes' && method === 'GET') {
      if (!asOwner) return reply(401, { error: 'unauthorized' })
      return reply(200, {
        nodes: [{ nodeId: 'node-1', maxContexts: 5, contexts: slots.size, draining: false, lastSeenAt: 'x' }]
      })
    }

    const match = path.match(/^\/v1\/slots\/([^/]+)$/)
    if (match) {
      const slotId = decodeURIComponent(match[1]!)
      if (method === 'DELETE') {
        if (!asOwner) return reply(401, { error: 'unauthorized' })
        const status = options.deleteStatus?.(slotId) ?? 204
        if (status === 204) slots.delete(slotId)
        return reply(status)
      }
      if (method === 'GET') {
        const scripted = slotLookups.shift()
        if (scripted === 'network') throw new TypeError('fetch failed')
        if (scripted !== undefined) return reply(scripted)
        const slot = slots.get(slotId)
        if (!slot) return reply(404, { error: 'not_found' })
        if (headers[TOKEN_HEADER] !== slot.token) return reply(401, { error: 'unauthorized' })
        return reply(200, summary(slot))
      }
    }
    return reply(404, { error: 'not_found' })
  }) as typeof fetch

  const lookups = () => calls.filter((call) => call.method === 'GET' && /^\/v1\/slots\/[^/]+$/.test(call.url.pathname))
  const deleted = () =>
    calls.filter((call) => call.method === 'DELETE').map((call) => call.url.pathname.split('/').pop() as string)

  return { impl, calls, slots, seed, lookups, deleted }
}

function client(fetchImpl: typeof fetch, options: Partial<BrowserBoxOptions> = {}) {
  return createBrowserBox({ url: BOX, apiKey: API_KEY, fetch: fetchImpl, now: () => NOW, retryDelayMs: 0, ...options })
}

const acquireOptions = (runId: string, extra: { waitMs?: number } = {}) => ({
  runId,
  maxLifetimeSeconds: 3000,
  ...extra
})

function recorder() {
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
  return {
    warnings,
    logger: { warn: (message: string, fields?: Record<string, unknown>) => warnings.push({ message, fields }) }
  }
}

test('client: refuses an address or key it cannot use, up front', () => {
  assert.throws(() => createBrowserBox({ url: 'not a url', apiKey: API_KEY }), /not a URL/)
  assert.throws(() => createBrowserBox({ url: 'ftp://browsers.example.com', apiKey: API_KEY }), /http\(s\)/)
  assert.throws(() => createBrowserBox({ url: BOX, apiKey: '' }), /apiKey/)
})

test('client: refuses a namespace that could be mistaken for another, a bad run id, and a lifetime the box would refuse', async () => {
  for (const namespace of ['app:staging', 'has space', 'a/b', 'é']) {
    assert.throws(() => createBrowserBox({ url: BOX, apiKey: API_KEY, namespace }), /namespace/, namespace)
  }
  for (const namespace of ['production', 'eu-west_1.app']) createBrowserBox({ url: BOX, apiKey: API_KEY, namespace })
  // An empty namespace is no namespace (as `namespace: process.env.NS ?? ''` would mean), not an error.
  const unnamespaced = fakeBox()
  await client(unnamespaced.impl, { namespace: '' }).acquire(acquireOptions('plain'))
  assert.equal(unnamespaced.calls[0]!.body!.runId, 'plain', 'no prefix')

  const box = fakeBox()
  const service = client(box.impl, { namespace: 'production' })
  for (const runId of ['', 'x'.repeat(200)]) {
    await assert.rejects(() => service.acquire({ runId, maxLifetimeSeconds: 600 }), /runId must be/, runId.slice(0, 5))
  }
  for (const maxLifetimeSeconds of [0, 59, 86_401, 1.5, Number.NaN, '600' as unknown as number]) {
    await assert.rejects(
      () => service.acquire({ runId: 'ok', maxLifetimeSeconds }),
      /maxLifetimeSeconds must be a whole number from 60 to 86400/,
      String(maxLifetimeSeconds)
    )
  }
  for (const waitMs of [2.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number]) {
    await assert.rejects(
      () => service.acquire({ runId: 'ok', maxLifetimeSeconds: 600, waitMs }),
      /waitMs must be a whole number of milliseconds/,
      String(waitMs)
    )
  }
  assert.equal(box.calls.length, 0, 'nothing was asked of the box to find that out')
  await service.acquire({ runId: 'ok', maxLifetimeSeconds: 600, waitMs: 0 })
  await service.acquire({ runId: 'x'.repeat(200 - 'production:'.length), maxLifetimeSeconds: 60 })
  await service.acquire({ runId: 'ok', maxLifetimeSeconds: 86_400 })
})

test('client: asks the box for a slot with the API key, the wait and the maximum lifetime', async () => {
  const box = fakeBox()
  await client(box.impl, { url: `${BOX}/` }).acquire(acquireOptions('run-1'))

  const create = box.calls[0]!
  assert.equal(create.method, 'POST')
  assert.equal(create.url.href, `${BOX}/v1/slots`)
  assert.equal(create.headers.Authorization, `Bearer ${API_KEY}`)
  assert.equal(create.headers['Content-Type'], 'application/json')
  assert.deepEqual(create.body, { runId: 'run-1', maxLifetimeSeconds: 3000, waitMs: 30_000 })

  const impatient = fakeBox()
  await client(impatient.impl).acquire(acquireOptions('run-2', { waitMs: 5000 }))
  assert.equal(impatient.calls[0]!.body!.waitMs, 5000)
  const noWait = fakeBox()
  await client(noWait.impl).acquire(acquireOptions('run-3', { waitMs: 0 }))
  assert.equal(noWait.calls[0]!.body!.waitMs, 0, 'zero means do not wait, not "use the default"')
})

test('client: with a namespace the slot is created under a prefixed run id', async () => {
  const box = fakeBox()
  await client(box.impl, { namespace: 'production' }).acquire(acquireOptions('run-1'))
  assert.equal(box.calls[0]!.body!.runId, 'production:run-1')

  const plain = fakeBox()
  await client(plain.impl).acquire(acquireOptions('run-1'))
  assert.equal(plain.calls[0]!.body!.runId, 'run-1', 'no namespace leaves the run id alone')
})

test('client: a slot carries what it takes to drive and release its browser, and nothing of the API key', async () => {
  const box = fakeBox()
  const slot = await client(box.impl, { url: `${BOX}/` }).acquire(acquireOptions('run-1'))
  const token = box.slots.get('slot-1')!.token

  assert.equal(slot.url, BOX, 'the trailing slash is dropped')
  assert.equal(slot.slotId, 'slot-1')
  assert.equal(slot.nodeId, 'node-1')
  assert.equal(slot.token, token)
  assert.equal(slot.cdpUrl, 'wss://browsers.example.com/v1/cdp/slot-1')
  assert.deepEqual(slot.headers, { [TOKEN_HEADER]: token })
  assert.notEqual(
    slot.headers,
    slot.headers,
    'a fresh object each time, so a caller cannot change what the next one sees'
  )
  assert.ok(!JSON.stringify(slot).includes(API_KEY), 'the API key is never part of a slot')

  const second = await client(box.impl).acquire(acquireOptions('run-2'))
  assert.notEqual(second.token, token, 'each slot has its own token')
})

test('client: a full box is a NoCapacityError; other failures carry the status and no secret', async () => {
  await assert.rejects(
    () => client(fakeBox({ createStatus: 503 }).impl).acquire(acquireOptions('r')),
    (error: unknown) => {
      assert.ok(error instanceof NoCapacityError)
      assert.ok(error instanceof BrowserBoxError)
      assert.equal(error.status, 503)
      assert.equal(error.message, 'No browser capacity is available right now')
      return true
    }
  )
  await assert.rejects(
    () => client(fakeBox({ createStatus: 401 }).impl).acquire(acquireOptions('r')),
    (error: unknown) => {
      assert.ok(error instanceof BrowserBoxError && !(error instanceof NoCapacityError))
      assert.equal(error.status, 401)
      assert.match(error.message, /could not start a browser \(401\)/)
      assert.ok(!error.message.includes(API_KEY))
      return true
    }
  )
  await assert.rejects(
    () => client(fakeBox({ createBody: { slotId: 'slot-1' } }).impl).acquire(acquireOptions('r')),
    /incomplete slot/
  )
  const down = client((async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch)
  await assert.rejects(() => down.acquire(acquireOptions('r')), /fetch failed/)
})

test('client: the CDP socket scheme and path prefix follow the box address', async () => {
  const cases = [
    ['http://box.internal:8080', 'ws://box.internal:8080/v1/cdp/slot-1'],
    ['https://box.example.com', 'wss://box.example.com/v1/cdp/slot-1'],
    ['https://box.example.com:8443', 'wss://box.example.com:8443/v1/cdp/slot-1'],
    ['https://example.com/browsers', 'wss://example.com/browsers/v1/cdp/slot-1'],
    ['https://example.com/browsers/', 'wss://example.com/browsers/v1/cdp/slot-1']
  ] as const
  for (const [url, expected] of cases) {
    const box = fakeBox({ prefix: new URL(url).pathname.replace(/\/+$/, '') })
    const slot = await client(box.impl, { url }).acquire(acquireOptions('run-1'))
    assert.equal(slot.cdpUrl, expected, url)
    assert.equal(await slot.isAlive(), true, `${url} is also where lookups go`)
  }
})

test('client: isAlive asks the box with the slot’s own token, never the API key', async () => {
  const box = fakeBox()
  const slot = await client(box.impl).acquire(acquireOptions('run-1'))
  assert.equal(await slot.isAlive(), true)

  const lookup = box.lookups()[0]!
  assert.equal(lookup.url.href, `${BOX}/v1/slots/slot-1`)
  assert.equal(lookup.headers[TOKEN_HEADER], box.slots.get('slot-1')!.token)
  assert.equal(lookup.headers.Authorization, undefined, 'a slot asks about itself without the API key')
})

test('client: isAlive is false when the slot is gone or its token is refused, and that is final', async () => {
  const box = fakeBox()
  const slot = await client(box.impl).acquire(acquireOptions('run-1'))

  box.slots.get('slot-1')!.token = 'a-completely-different-token'
  assert.equal(await slot.isAlive(), false, '401: the slot now belongs to another run')
  assert.equal(box.lookups().length, 1, 'a refusal is not retried')

  box.slots.clear()
  assert.equal(await slot.isAlive(), false, '404: the slot is gone')
  assert.equal(box.lookups().length, 2)
})

test('client: isAlive retries once on a network error or a server error, and never throws', async () => {
  const lookupsAfter = async (slotLookups: Array<'network' | number>) => {
    const box = fakeBox({ slotLookups })
    const slot = await client(box.impl).acquire(acquireOptions('run-1'))
    return { alive: await slot.isAlive(), lookups: box.lookups().length }
  }

  assert.deepEqual(await lookupsAfter(['network']), { alive: true, lookups: 2 })
  assert.deepEqual(await lookupsAfter([500]), { alive: true, lookups: 2 })
  assert.deepEqual(await lookupsAfter([503]), { alive: true, lookups: 2 })
  assert.deepEqual(await lookupsAfter(['network', 'network']), { alive: false, lookups: 2 })
  assert.deepEqual(await lookupsAfter([502, 'network']), { alive: false, lookups: 2 })
  assert.deepEqual(await lookupsAfter([404]), { alive: false, lookups: 1 })
  assert.deepEqual(await lookupsAfter([401]), { alive: false, lookups: 1 })
  assert.deepEqual(await lookupsAfter([]), { alive: true, lookups: 1 })
})

test('client: a stored slot comes back to life without a request, and says where it lives', async () => {
  const box = fakeBox()
  const original = await client(box.impl).acquire(acquireOptions('run-1'))
  const stored = JSON.parse(JSON.stringify(original))
  assert.deepEqual(Object.keys(stored).sort(), ['nodeId', 'slotId', 'token', 'url'])
  assert.ok(!JSON.stringify(stored).includes(API_KEY))

  const before = box.calls.length
  const revived = client(box.impl).slot(stored)
  assert.equal(box.calls.length, before, 'nothing is asked of the box just to rebuild a slot')
  assert.equal(revived.cdpUrl, original.cdpUrl)
  assert.deepEqual(revived.headers, original.headers)
  assert.equal(await revived.isAlive(), true)

  assert.throws(() => client(box.impl).slot({ slotId: 'slot-1' } as never), /slotId and a token/)
  assert.throws(() => client(box.impl).slot({ token: 'x' } as never), /slotId and a token/)
  assert.throws(() => client(box.impl).slot({ ...stored, url: 'ftp://browsers.example.com' }), /http\(s\)/)
  assert.throws(() => client(box.impl).slot({ ...stored, url: 'not a url' }), /not a URL/)
})

test('client: a stored slot that names another box is not trusted with the API key or the slot token, unless allowed', async () => {
  const box = fakeBox()
  const service = client(box.impl)
  const stored = { slotId: 'slot-1', token: 'a-slot-token', url: 'https://attacker.example.net' }

  assert.throws(() => service.slot(stored), /not on this client's box/)
  await assert.rejects(() => service.release('slot-1', { url: stored.url }), /Its credentials are only sent to the box/)
  assert.equal(box.calls.length, 0, 'nothing was sent anywhere')

  // The same box under another spelling is the same box; another path on the host is another box.
  assert.equal(service.slot({ ...stored, url: `${BOX}/` }).url, BOX)
  assert.throws(() => service.slot({ ...stored, url: `${BOX}/other-prefix` }), /not on this client's box/)
  assert.equal(service.slot({ slotId: 'slot-1', token: 't' }).url, BOX, 'no address means this client’s box')

  const trusting = client(box.impl, { allowOtherBoxes: true })
  assert.equal(trusting.slot(stored).url, stored.url)
})

test('client: a stored slot is released at the box it names, with the API key', async () => {
  const box = fakeBox()
  const slot = await client(box.impl).acquire(acquireOptions('run-1'))
  const stored = JSON.parse(JSON.stringify(slot))
  await slot.release()

  const call = box.calls.find((candidate) => candidate.method === 'DELETE')!
  assert.equal(call.url.href, `${BOX}/v1/slots/slot-1`)
  assert.equal(call.headers.Authorization, `Bearer ${API_KEY}`)
  assert.equal(box.slots.size, 0)
  assert.equal(await slot.isAlive(), false, 'a released slot is gone')

  // The box moved since the slot was stored: the slot still decides where it lives.
  const elsewhere = fakeBox()
  await client(elsewhere.impl, { url: 'https://new-box.example.com', allowOtherBoxes: true }).slot(stored).release()
  assert.equal(elsewhere.calls[0]!.url.href, `${BOX}/v1/slots/slot-1`)
  assert.equal(elsewhere.calls[0]!.headers.Authorization, `Bearer ${API_KEY}`)
})

test('client: releasing is idempotent, a slot that is already gone is fine, and a failure is thrown with its status', async () => {
  const box = fakeBox()
  const slot = await client(box.impl).acquire(acquireOptions('run-1'))
  await slot.release()
  await slot.release()
  assert.equal(box.deleted().length, 2)

  await client(fakeBox({ deleteStatus: () => 404 }).impl)
    .slot(slot.toJSON())
    .release()

  for (const status of [500, 401]) {
    await assert.rejects(
      () =>
        client(fakeBox({ deleteStatus: () => status }).impl)
          .slot(slot.toJSON())
          .release(),
      (error: unknown) => {
        assert.ok(error instanceof BrowserBoxError)
        assert.equal(error.status, status)
        assert.ok(!error.message.includes(API_KEY) && !error.message.includes(slot.token), 'no secret in the message')
        return true
      }
    )
  }
})

test('client: list shows this service’s slots, and with a namespace only that namespace with the prefix removed', async () => {
  const box = fakeBox()
  box.seed('mine', 'production:run-a', 30)
  box.seed('theirs', 'staging:run-a', 30)
  box.seed('bare', 'run-a', 30)

  assert.deepEqual(
    (await client(box.impl).list()).map((slot) => slot.slotId).sort(),
    ['bare', 'mine', 'theirs'],
    'no namespace sees everything'
  )
  const listed = await client(box.impl, { namespace: 'production' }).list()
  assert.deepEqual(
    listed.map(({ slotId, runId }) => ({ slotId, runId })),
    [{ slotId: 'mine', runId: 'run-a' }]
  )
  assert.equal(JSON.stringify(listed).includes('token'), false, 'a listing carries no secret')

  await assert.rejects(() => client(fakeBox({ listStatus: 500 }).impl).list(), /could not list browsers \(500\)/)
  await assert.rejects(
    () => client(fakeBox({ listStatus: 401 }).impl).list(),
    (error: unknown) => (error as BrowserBoxError).status === 401
  )
})

test('client: nodes lists the machines that run the box’s browsers', async () => {
  const box = fakeBox()
  assert.deepEqual(
    (await client(box.impl).nodes()).map((node) => node.nodeId),
    ['node-1']
  )
  assert.equal(box.calls[0]!.headers.Authorization, `Bearer ${API_KEY}`)
})

test('client: the reaper releases slots no live run needs, and spares young ones, live runs and the skipped', async () => {
  const { warnings, logger } = recorder()
  const box = fakeBox()
  box.seed('live', 'run-live', 30)
  box.seed('finished', 'run-finished', 30)
  box.seed('lost', 'run-missing', 30)
  box.seed('young', 'run-finished', 1)
  box.seed('capture', 'capture-1b4e28ba-2fa1-11d2-883f-0016d3cca427', 30)
  box.seed('broken', 'run-broken', 30)
  box.seed('anonymous', '', 30)
  const service = client(box.impl, { logger })

  const asked: string[] = []
  const released = await service.reap({
    isLive: async (runId) => {
      asked.push(runId)
      if (runId === 'run-broken') throw new Error('invalid input syntax for type uuid')
      return runId === 'run-live'
    },
    skip: (runId) => runId.startsWith('capture-')
  })

  const list = box.calls[0]!
  assert.equal(list.method, 'GET')
  assert.equal(list.url.href, `${BOX}/v1/slots`)
  assert.equal(list.headers.Authorization, `Bearer ${API_KEY}`)
  assert.deepEqual(box.deleted().sort(), ['anonymous', 'finished', 'lost'])
  assert.equal(released, 3)
  assert.deepEqual(
    asked,
    ['run-live', 'run-finished', 'run-missing', 'run-broken'],
    'young slots, skipped ones and slots without a run are not looked up'
  )
  assert.deepEqual(
    [...box.slots.keys()].sort(),
    ['broken', 'capture', 'live', 'young'],
    'not knowing is not a reason to release a browser'
  )
  assert.equal(warnings.length, 1, 'the failed lookup is logged')
  for (const call of box.calls.filter((candidate) => candidate.method === 'DELETE')) {
    assert.equal(call.headers.Authorization, `Bearer ${API_KEY}`)
  }
})

test('client: with a namespace the reaper only touches that namespace, and asks about the bare run id', async () => {
  const box = fakeBox()
  box.seed('mine-orphan', 'production:run-orphan', 30)
  box.seed('mine-live', 'production:run-live', 30)
  box.seed('mine-capture', 'production:capture-1b4e28ba-2fa1-11d2-883f-0016d3cca427', 30)
  box.seed('mine-young', 'production:run-orphan', 1)
  box.seed('staging', 'staging:run-orphan', 30)
  box.seed('unprefixed', 'run-orphan', 30)
  box.seed('lookalike', 'production-eu:run-orphan', 30)
  const service = client(box.impl, { namespace: 'production' })

  const asked: string[] = []
  const released = await service.reap({
    isLive: async (runId) => {
      asked.push(runId)
      return runId === 'run-live'
    },
    skip: (runId) => runId.startsWith('capture-')
  })

  assert.deepEqual(box.deleted(), ['mine-orphan'])
  assert.equal(released, 1)
  assert.deepEqual(asked, ['run-orphan', 'run-live'], 'the namespace prefix is stripped before the run is looked up')
  assert.deepEqual(
    [...box.slots.keys()].sort(),
    ['lookalike', 'mine-capture', 'mine-live', 'mine-young', 'staging', 'unprefixed'],
    'another service’s slots on a shared box are untouched'
  )
})

test('client: a slot is spared during the grace period and reaped after it', async () => {
  let clock = NOW
  const box = fakeBox({ now: () => clock })
  const service = client(box.impl, { namespace: 'production', now: () => clock })
  await service.acquire(acquireOptions('run-1'))

  clock = NOW + 60_000
  assert.equal(
    await service.reap({ isLive: async () => false }),
    0,
    'one minute old: it may not be saved on its run yet'
  )
  assert.equal(box.slots.size, 1)

  clock = NOW + 10 * 60_000
  const asked: string[] = []
  assert.equal(
    await service.reap({
      isLive: async (runId) => {
        asked.push(runId)
        return false
      }
    }),
    1
  )
  assert.deepEqual(asked, ['run-1'])
  assert.equal(box.slots.size, 0)

  const patient = fakeBox({ now: () => clock })
  const strict = client(patient.impl, { now: () => clock })
  await strict.acquire(acquireOptions('run-2'))
  clock += 10 * 60_000
  assert.equal(
    await strict.reap({ isLive: async () => false, graceMs: 30 * 60_000 }),
    0,
    'the grace period is configurable'
  )
})

test('client: a failed listing stops the reaper, and a release that fails is not counted and logs no secret', async () => {
  const { warnings, logger } = recorder()
  const unavailable = fakeBox({ listStatus: 500 })
  unavailable.seed('orphan', 'run-orphan', 30)
  await assert.rejects(
    () => client(unavailable.impl).reap({ isLive: async () => false }),
    /could not list browsers \(500\)/
  )
  assert.deepEqual(unavailable.deleted(), [], 'nothing is released on a listing that failed')

  const box = fakeBox({ deleteStatus: (slotId) => (slotId === 'stuck' ? 500 : 204) })
  box.seed('stuck', 'run-a', 30)
  box.seed('fine', 'run-b', 30)
  const released = await client(box.impl, { logger }).reap({ isLive: async () => false })
  assert.equal(released, 1, 'only the release that worked is counted')
  assert.deepEqual(box.deleted(), ['stuck', 'fine'], 'one failure does not stop the others')
  assert.equal(warnings.length, 1)
  const logged = JSON.stringify(warnings)
  assert.ok(logged.includes('stuck'), 'the slot id says which browser')
  assert.ok(!logged.includes(API_KEY) && !logged.includes('token-of-'), 'no secret is logged')
})

test('client: a slot can be released by its id alone, at the box named, and failures carry their status', async () => {
  const box = fakeBox()
  box.seed('orphan', 'run-a', 30)
  await client(box.impl).release('orphan')
  assert.deepEqual(box.deleted(), ['orphan'])
  assert.equal(box.calls[0]!.url.href, `${BOX}/v1/slots/orphan`)
  assert.equal(box.calls[0]!.headers.Authorization, `Bearer ${API_KEY}`)

  const elsewhere = fakeBox()
  await client(elsewhere.impl, { allowOtherBoxes: true }).release('x', { url: 'https://other.example.com/' })
  assert.equal(elsewhere.calls[0]!.url.href, 'https://other.example.com/v1/slots/x')

  await client(fakeBox({ deleteStatus: () => 404 }).impl).release('already-gone')
  await assert.rejects(
    () => client(fakeBox({ deleteStatus: () => 500 }).impl).release('stuck'),
    (error: unknown) => error instanceof BrowserBoxError && error.status === 500
  )
  await assert.rejects(() => client(box.impl).release(''), /needs a slotId/)
  await assert.rejects(() => client(box.impl).release('x', { url: 'ftp://nope' }), /http\(s\)/)
})
