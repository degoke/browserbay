import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { WebSocket } from 'ws'
import { hashToken } from './registry.js'
import { CLOSE, RELAY_PATHS, TOKEN_HEADER, type NodeContextReport, type RelayToNode } from '../protocol.js'
import { createRelayServer, type RelayOptions } from './server.js'
import { parseBoxConfig, parseEnrollmentSecrets, parseRelayConfig } from './config.js'

const API_KEY = 'relay-api-key-0123456789'
const SECRET = 'node-enrollment-secret-01'
const ENROLLMENTS = [{ id: 'test-nodes', sha256: hashToken(SECRET) }]

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000) {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${what}`)
    await wait(10)
  }
}

async function startRelay(overrides: Partial<RelayOptions> = {}) {
  const relay = createRelayServer({ apiKey: API_KEY, enrollmentSecrets: ENROLLMENTS, ...overrides })
  const port = await relay.listen(0, '127.0.0.1')
  return { relay, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` }
}

const rest = (base: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', ...init.headers }
  })

const createSlot = (base: string, body: object = { runId: 'run-1', maxLifetimeSeconds: 600 }, signal?: AbortSignal) =>
  rest(base, RELAY_PATHS.slots, { method: 'POST', body: JSON.stringify(body), signal })

/**
 * A node, as far as the relay can tell: it authenticates, confirms the contexts it is asked for, and answers every
 * stream the relay asks for by echoing each message's method back, so tests can see what crossed the relay.
 */
async function connectNode(
  wsBase: string,
  options: {
    secret?: string
    nodeId?: string
    maxContexts?: number
    contexts?: NodeContextReport[]
    serve?: boolean
    confirm?: boolean
    version?: number
  } = {}
) {
  const {
    secret = SECRET,
    nodeId = 'n1',
    maxContexts = 3,
    contexts = [],
    serve = true,
    confirm = true,
    version = 1
  } = options
  const control = new WebSocket(`${wsBase}${RELAY_PATHS.nodeConnect}`)
  const received: RelayToNode[] = []
  const streams: WebSocket[] = []
  const held = new Map<string, Extract<RelayToNode, { t: 'context.create' }>>()
  const closed = new Promise<number>((resolve) => control.once('close', (code) => resolve(code)))
  control.on('error', () => undefined)
  control.on('message', (data) => {
    const message = JSON.parse(data.toString()) as RelayToNode
    received.push(message)
    if (message.t === 'context.create') {
      held.set(message.slotId, message)
      if (confirm) control.send(JSON.stringify({ t: 'context.created', reqId: message.reqId }))
    }
    if (message.t === 'context.release') held.delete(message.slotId)
    if (message.t === 'stream.open' && serve) {
      const stream = new WebSocket(`${wsBase}${RELAY_PATHS.nodeStream(message.streamId)}`)
      streams.push(stream)
      stream.on('error', () => undefined)
      stream.on('message', (payload) => {
        const request = JSON.parse(payload.toString()) as { id: number; method: string }
        stream.send(JSON.stringify({ id: request.id, result: { echo: request.method } }))
      })
    }
  })
  await new Promise<void>((resolve, reject) => {
    control.once('open', () => resolve())
    control.once('error', reject)
  })
  control.send(JSON.stringify({ t: 'hello', secret, nodeId, maxContexts, version, contexts }))
  return {
    control,
    received,
    streams,
    held,
    closed,
    heartbeat: (contextsHeld: NodeContextReport[] = []) =>
      control.send(JSON.stringify({ t: 'heartbeat', draining: false, contexts: contextsHeld })),
    welcomed: () => until(() => received.some((message) => message.t === 'welcome'), 'the welcome'),
    close: () => control.close()
  }
}

/** A client of a slot: resolves each reply by id so tests can ask and await. */
async function connectClient(wsBase: string, slotId: string, token: string | undefined) {
  const socket = new WebSocket(`${wsBase}${RELAY_PATHS.cdp(slotId)}`, {
    headers: token ? { [TOKEN_HEADER]: token } : {}
  })
  const replies = new Map<number, (value: { result: { echo: string } }) => void>()
  const frames: boolean[] = []
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)))
  socket.on('error', () => undefined)
  socket.on('message', (data, isBinary) => {
    frames.push(isBinary)
    const message = JSON.parse(data.toString())
    replies.get(message.id)?.(message)
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return {
    socket,
    frames,
    closed,
    ask: (id: number, method: string) =>
      new Promise<{ result: { echo: string } }>((resolve) => {
        replies.set(id, resolve)
        socket.send(JSON.stringify({ id, method }))
      })
  }
}

/** What a CDP or node socket upgrade is answered with: the HTTP status it was refused with, or 101 if it was accepted. */
function upgradeStatus(url: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve) => {
    const socket = new WebSocket(url, { headers })
    socket.once('open', () => {
      socket.close()
      resolve(101)
    })
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
    socket.once('error', () => undefined)
  })
}

test('the REST side needs the API key, and refuses what it cannot make sense of', async () => {
  const { relay, base } = await startRelay()
  try {
    assert.equal((await fetch(`${base}${RELAY_PATHS.health}`)).status, 200)
    for (const headers of [{}, { authorization: 'Bearer wrong-key-wrong-key-1' }, { authorization: API_KEY }] as Array<
      Record<string, string>
    >) {
      assert.equal((await fetch(`${base}${RELAY_PATHS.slots}`, { headers })).status, 401)
      assert.equal((await fetch(`${base}${RELAY_PATHS.nodes}`, { headers })).status, 401)
      assert.equal((await fetch(`${base}${RELAY_PATHS.slots}`, { method: 'POST', headers, body: '{}' })).status, 401)
    }
    for (const body of [
      '',
      'nope',
      '{}',
      '{"runId":"x"}',
      '{"runId":"","maxLifetimeSeconds":600}',
      '{"runId":"x","maxLifetimeSeconds":5}',
      '{"runId":"x","maxLifetimeSeconds":600,"waitMs":-1}',
      '{"runId":"x","maxLifetimeSeconds":600.5}'
    ]) {
      assert.equal((await rest(base, RELAY_PATHS.slots, { method: 'POST', body })).status, 400, body)
    }
    assert.equal((await rest(base, '/v1/unknown')).status, 404)
    assert.equal((await rest(base, RELAY_PATHS.slots, { method: 'POST', body: 'x'.repeat(20_000) })).status, 400)
  } finally {
    await relay.close()
  }
})

test('an authenticated node that sends things that are not messages ends nothing but those messages', async () => {
  const { relay, base, wsBase } = await startRelay()
  const uncaught: unknown[] = []
  const onUncaught = (error: unknown) => uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  try {
    const node = await connectNode(wsBase)
    await node.welcomed()
    // Valid JSON that is not an object used to throw inside the socket's listener, and take the whole relay with it.
    for (const frame of [
      'null',
      'true',
      '7',
      '"text"',
      '[]',
      '[null]',
      '{}',
      '{"t":null}',
      '{"t":"heartbeat","contexts":"nope"}',
      'not json'
    ]) {
      node.control.send(frame)
    }
    node.control.send(Buffer.from([1, 2, 3]))
    node.heartbeat()
    await wait(100)

    assert.deepEqual(uncaught, [], 'nothing was thrown')
    assert.equal((await rest(base, RELAY_PATHS.nodes)).status, 200, 'the relay is still serving')
    assert.equal(relay.registry.listNodes()[0]?.nodeId, 'n1', 'and the node is still a member')
    assert.equal((await createSlot(base)).status, 201, 'and still takes slots')
  } finally {
    process.off('uncaughtException', onUncaught)
    await relay.close()
  }
})

test('a node must authenticate in its first frame', async () => {
  const { relay, wsBase } = await startRelay({ helloTimeoutMs: 150 })
  try {
    const wrong = await connectNode(wsBase, { secret: 'not-the-enrollment-secret' })
    assert.equal(await wrong.closed, CLOSE.unauthorized)

    const silent = new WebSocket(`${wsBase}${RELAY_PATHS.nodeConnect}`)
    silent.on('error', () => undefined)
    assert.equal(await new Promise((resolve) => silent.once('close', resolve)), CLOSE.helloTimeout)

    const notHello = new WebSocket(`${wsBase}${RELAY_PATHS.nodeConnect}`)
    notHello.on('error', () => undefined)
    notHello.once('open', () => notHello.send(JSON.stringify({ t: 'heartbeat', draining: false, contexts: [] })))
    assert.equal(await new Promise((resolve) => notHello.once('close', resolve)), CLOSE.unauthorized)

    const badId = await connectNode(wsBase, { nodeId: 'has spaces/and slashes' })
    assert.equal(await badId.closed, CLOSE.unauthorized)
    assert.equal(relay.registry.listNodes().length, 0)

    const good = await connectNode(wsBase)
    await good.welcomed()
    assert.deepEqual(good.received[0], { t: 'welcome', heartbeatMs: 5000, version: 1 })
    assert.equal(relay.registry.listNodes()[0]!.nodeId, 'n1')
    good.close()
  } finally {
    await relay.close()
  }
})

test('a slot is created on a node, found by its token, listed without it, and released', async () => {
  const { relay, base, wsBase } = await startRelay()
  const node = await connectNode(wsBase)
  try {
    await node.welcomed()
    const created = await createSlot(base)
    assert.equal(created.status, 201)
    const slot = (await created.json()) as { slotId: string; token: string; nodeId: string }
    assert.equal(slot.nodeId, 'n1')
    const create = node.received.find((message) => message.t === 'context.create')
    assert.ok(create && create.t === 'context.create')
    assert.equal(create.tokenHash, hashToken(slot.token), 'the node got the hash, never the token')
    assert.ok(!JSON.stringify(node.received).includes(slot.token))

    const byToken = (token?: string) =>
      fetch(`${base}${RELAY_PATHS.slot(slot.slotId)}`, { headers: token ? { [TOKEN_HEADER]: token } : {} })
    assert.equal((await byToken(slot.token)).status, 200)
    assert.equal((await byToken()).status, 404)
    assert.equal((await byToken('wrong')).status, 404)
    assert.equal(
      (await fetch(`${base}${RELAY_PATHS.slot(slot.slotId)}`, { headers: { authorization: `Bearer ${API_KEY}` } }))
        .status,
      404,
      'the API key is not a run token'
    )

    const listed = (await (await rest(base, RELAY_PATHS.slots)).json()) as {
      slots: Array<{ slotId: string; runId: string }>
    }
    assert.deepEqual(
      listed.slots.map((item) => [item.slotId, item.runId]),
      [[slot.slotId, 'run-1']]
    )
    assert.ok(!JSON.stringify(listed).includes(slot.token))
    const nodes = (await (await rest(base, RELAY_PATHS.nodes)).json()) as {
      nodes: Array<{ nodeId: string; contexts: number }>
    }
    assert.deepEqual(
      nodes.nodes.map((item) => [item.nodeId, item.contexts]),
      [['n1', 1]]
    )

    assert.equal((await rest(base, RELAY_PATHS.slot(slot.slotId), { method: 'DELETE' })).status, 204)
    await until(() => node.received.some((message) => message.t === 'context.release'), 'the node to be told')
    assert.equal((await byToken(slot.token)).status, 404)
    assert.equal(
      (await rest(base, RELAY_PATHS.slot(slot.slotId), { method: 'DELETE' })).status,
      204,
      'releasing twice is fine'
    )
    assert.equal((await fetch(`${base}${RELAY_PATHS.slot(slot.slotId)}`, { method: 'DELETE' })).status, 401)
  } finally {
    node.close()
    await relay.close()
  }
})

test('with no room the answer is 503 no_capacity, after waiting no longer than the relay allows', async () => {
  const { relay, base, wsBase } = await startRelay({ maxAcquireWaitMs: 100 })
  try {
    const none = await createSlot(base, { runId: 'a', maxLifetimeSeconds: 600 })
    assert.equal(none.status, 503)
    assert.deepEqual(await none.json(), { error: 'no_capacity' })

    const node = await connectNode(wsBase, { maxContexts: 1 })
    await node.welcomed()
    assert.equal((await createSlot(base, { runId: 'b', maxLifetimeSeconds: 600 })).status, 201)
    const started = Date.now()
    const full = await createSlot(base, { runId: 'c', maxLifetimeSeconds: 600, waitMs: 60_000 })
    assert.equal(full.status, 503)
    assert.ok(Date.now() - started < 2000, 'the caller’s wait was capped by the relay')
    node.close()
  } finally {
    await relay.close()
  }
})

test('a client’s DevTools messages cross the relay to its node and back, in order, even those sent before the stream is up', async () => {
  const { relay, base, wsBase } = await startRelay()
  const node = await connectNode(wsBase)
  try {
    await node.welcomed()
    const slot = (await (await createSlot(base)).json()) as { slotId: string; token: string }
    const client = await connectClient(wsBase, slot.slotId, slot.token)

    // Sent the instant the socket opened, before the node has dialled back.
    const replies = await Promise.all(
      ['Browser.getVersion', 'Target.getTargets', 'Page.enable', 'Runtime.evaluate'].map((method, index) =>
        client.ask(index + 1, method)
      )
    )
    assert.deepEqual(
      replies.map((reply) => reply.result.echo),
      ['Browser.getVersion', 'Target.getTargets', 'Page.enable', 'Runtime.evaluate']
    )
    assert.ok(
      client.frames.every((binary) => binary === false),
      'text frames stay text frames'
    )

    const big = 'x'.repeat(5_000_000)
    assert.equal((await client.ask(99, big)).result.echo.length, 5_000_000, 'a multi-megabyte message passes')

    // A second client of the same slot gets its own stream.
    const another = await connectClient(wsBase, slot.slotId, slot.token)
    assert.equal((await another.ask(1, 'Browser.getVersion')).result.echo, 'Browser.getVersion')
    assert.equal(node.streams.length, 2)
    client.socket.close()
    another.socket.close()
  } finally {
    node.close()
    await relay.close()
  }
})

test('a CDP socket needs its own slot’s token', async () => {
  const { relay, base, wsBase } = await startRelay()
  const node = await connectNode(wsBase)
  try {
    await node.welcomed()
    const slot = (await (await createSlot(base)).json()) as { slotId: string; token: string }
    const other = (await (await createSlot(base, { runId: 'run-2', maxLifetimeSeconds: 600 })).json()) as {
      slotId: string
      token: string
    }
    const url = `${wsBase}${RELAY_PATHS.cdp(slot.slotId)}`

    assert.equal(await upgradeStatus(url), 401)
    assert.equal(await upgradeStatus(url, { [TOKEN_HEADER]: 'wrong' }), 401)
    assert.equal(await upgradeStatus(url, { [TOKEN_HEADER]: other.token }), 401, 'another run’s token')
    assert.equal(
      await upgradeStatus(url, { authorization: `Bearer ${API_KEY}` }),
      401,
      'the API key is not a run token'
    )
    assert.equal(
      await upgradeStatus(`${wsBase}${RELAY_PATHS.cdp('s-nonexistent')}`, { [TOKEN_HEADER]: slot.token }),
      401
    )
    assert.equal(
      await upgradeStatus(`${wsBase}/json/version`, { [TOKEN_HEADER]: slot.token }),
      404,
      'DevTools’ own paths are not served'
    )
    assert.equal(await upgradeStatus(url, { [TOKEN_HEADER]: slot.token }), 101)

    // A stream id is a single-use capability the relay gave to one node.
    assert.equal(await upgradeStatus(`${wsBase}${RELAY_PATHS.nodeStream('not-a-stream')}`), 404)
  } finally {
    node.close()
    await relay.close()
  }
})

test('a slot whose node is unreachable is refused, and a node that cannot serve a stream closes its client', async () => {
  const { relay, base, wsBase } = await startRelay({ streamTimeoutMs: 150 })
  const node = await connectNode(wsBase, { serve: false })
  try {
    await node.welcomed()
    const slot = (await (await createSlot(base)).json()) as { slotId: string; token: string }

    // The node never dials back: the client is closed rather than left hanging.
    const silent = await connectClient(wsBase, slot.slotId, slot.token)
    assert.equal(await silent.closed, CLOSE.nodeUnavailable)

    // The node says it cannot.
    node.control.send(JSON.stringify({ t: 'stream.failed', streamId: 'x', message: 'no' }))
    const refused = await connectClient(wsBase, slot.slotId, slot.token)
    const open = node.received.filter((message) => message.t === 'stream.open').at(-1) as { streamId: string }
    node.control.send(
      JSON.stringify({ t: 'stream.failed', streamId: open.streamId, message: 'No such context on this node' })
    )
    assert.equal(await refused.closed, CLOSE.nodeUnavailable)

    // The node's socket goes away: the slot is kept for a while, but it cannot be reached.
    node.close()
    await node.closed
    await until(
      async () =>
        (await fetch(`${base}${RELAY_PATHS.slot(slot.slotId)}`, { headers: { [TOKEN_HEADER]: slot.token } })).status ===
        503,
      'the slot to report its node unavailable'
    )
    assert.equal(await upgradeStatus(`${wsBase}${RELAY_PATHS.cdp(slot.slotId)}`, { [TOKEN_HEADER]: slot.token }), 503)
    assert.equal(relay.registry.listSlots().length, 1)
  } finally {
    await relay.close()
  }
})

test('closing either end of a connection closes the other', async () => {
  const { relay, base, wsBase } = await startRelay()
  const node = await connectNode(wsBase)
  try {
    await node.welcomed()
    const slot = (await (await createSlot(base)).json()) as { slotId: string; token: string }

    const first = await connectClient(wsBase, slot.slotId, slot.token)
    await first.ask(1, 'Browser.getVersion')
    const firstStream = node.streams[0]!
    const streamClosed = new Promise<number>((resolve) => firstStream.once('close', (code) => resolve(code)))
    first.socket.close()
    assert.equal(await streamClosed, 1000)

    const second = await connectClient(wsBase, slot.slotId, slot.token)
    await second.ask(1, 'Browser.getVersion')
    node.streams[1]!.close(4500, 'The browser closed')
    assert.equal(await second.closed, 4500, 'the node’s close code reaches the client')

    const third = await connectClient(wsBase, slot.slotId, slot.token)
    await third.ask(1, 'Browser.getVersion')
    node.streams[2]!.terminate()
    assert.equal(await third.closed, 1011, 'an abnormal end of the stream is passed on as a generic error, not 1006')
  } finally {
    node.close()
    await relay.close()
  }
})

test('releasing a slot ends the connections still open on it', async () => {
  const { relay, base, wsBase } = await startRelay()
  const node = await connectNode(wsBase)
  try {
    await node.welcomed()
    const slot = (await (await createSlot(base)).json()) as { slotId: string; token: string }
    const client = await connectClient(wsBase, slot.slotId, slot.token)
    await client.ask(1, 'Browser.getVersion')
    await rest(base, RELAY_PATHS.slot(slot.slotId), { method: 'DELETE' })
    assert.equal(await client.closed, 4001)
  } finally {
    node.close()
    await relay.close()
  }
})

test('a node that stops heartbeating is dropped, and its runs with it', async () => {
  const { relay, base, wsBase } = await startRelay({ nodeTimeoutMs: 200, sweepMs: 30 })
  const node = await connectNode(wsBase)
  try {
    await node.welcomed()
    const slot = (await (await createSlot(base)).json()) as { slotId: string; token: string }
    const client = await connectClient(wsBase, slot.slotId, slot.token)
    await client.ask(1, 'Browser.getVersion')

    assert.equal(await node.closed, CLOSE.nodeTimeout)
    await until(() => relay.registry.listSlots().length === 0, 'the slot to be dropped')
    assert.equal(
      (await fetch(`${base}${RELAY_PATHS.slot(slot.slotId)}`, { headers: { [TOKEN_HEADER]: slot.token } })).status,
      404
    )
    assert.equal(await client.closed, 4001)
    assert.deepEqual(relay.registry.listNodes(), [])
  } finally {
    await relay.close()
  }
})

test('a restarted relay recovers its runs from what the node reports', async () => {
  const first = await startRelay()
  const node = await connectNode(first.wsBase)
  await node.welcomed()
  const slot = (await (await createSlot(first.base)).json()) as { slotId: string; token: string }
  const create = node.received.find((message) => message.t === 'context.create') as Extract<
    RelayToNode,
    { t: 'context.create' }
  >
  node.close()
  await first.relay.close()

  // The relay comes back with an empty table; the node reconnects and lists the context it still holds.
  const second = await startRelay()
  const again = await connectNode(second.wsBase, {
    contexts: [
      { slotId: create.slotId, runId: create.runId, tokenHash: create.tokenHash, createdAt: new Date().toISOString() }
    ]
  })
  try {
    await again.welcomed()
    const found = await fetch(`${second.base}${RELAY_PATHS.slot(slot.slotId)}`, {
      headers: { [TOKEN_HEADER]: slot.token }
    })
    assert.equal(found.status, 200, 'the old token still opens the adopted slot')
    const client = await connectClient(second.wsBase, slot.slotId, slot.token)
    assert.equal((await client.ask(1, 'Browser.getVersion')).result.echo, 'Browser.getVersion')
    client.socket.close()
  } finally {
    again.close()
    await second.relay.close()
  }
})

test('a node connecting again replaces its old connection and keeps its runs', async () => {
  const { relay, base, wsBase } = await startRelay()
  const old = await connectNode(wsBase)
  try {
    await old.welcomed()
    const slot = (await (await createSlot(base)).json()) as { slotId: string; token: string }
    const create = old.received.find((message) => message.t === 'context.create') as Extract<
      RelayToNode,
      { t: 'context.create' }
    >

    const fresh = await connectNode(wsBase, {
      contexts: [
        { slotId: create.slotId, runId: create.runId, tokenHash: create.tokenHash, createdAt: new Date().toISOString() }
      ]
    })
    assert.equal(await old.closed, CLOSE.replaced)
    await fresh.welcomed()
    assert.equal(
      (await fetch(`${base}${RELAY_PATHS.slot(slot.slotId)}`, { headers: { [TOKEN_HEADER]: slot.token } })).status,
      200
    )
    assert.equal(relay.registry.listNodes().length, 1)
    fresh.close()
  } finally {
    await relay.close()
  }
})

test('relay settings: enrollment secrets are name:sha256 pairs, and the API key is mandatory', () => {
  const hash = hashToken('s')
  assert.deepEqual(parseEnrollmentSecrets(`railway:${hash}, laptop:${hash.toUpperCase()}`), [
    { id: 'railway', sha256: hash },
    { id: 'laptop', sha256: hash }
  ])
  for (const bad of ['', 'nohash', 'name:short', `:${hash}`, `bad name:${hash}`]) {
    assert.throws(() => parseEnrollmentSecrets(bad), bad)
  }
  const config = parseRelayConfig({ BROWSERBOX_API_KEY: API_KEY, BROWSERBOX_ENROLLMENT_SECRETS: `a:${hash}` })
  assert.equal(config.port, 8788)
  assert.equal(config.maxAcquireWaitMs, 60_000)
  assert.throws(() => parseRelayConfig({ BROWSERBOX_ENROLLMENT_SECRETS: `a:${hash}` }), /Invalid relay configuration/)
  assert.throws(() => parseRelayConfig({ BROWSERBOX_API_KEY: 'short', BROWSERBOX_ENROLLMENT_SECRETS: `a:${hash}` }))
})

/** Sends raw bytes to the relay and returns whatever comes back: for requests no HTTP client would ever produce. */
function rawRequest(base: string, text: string) {
  const port = Number(new URL(base).port)
  return new Promise<string>((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text))
    let received = ''
    socket.on('data', (chunk) => (received += chunk))
    socket.on('close', () => resolve(received))
    socket.on('error', () => resolve(received))
    setTimeout(() => {
      socket.destroy()
      resolve(received)
    }, 1000)
  })
}

test('a request target that is not a URL is refused, and the relay carries on', async () => {
  const { relay, base } = await startRelay()
  try {
    // `//[` is not a valid URL; parsing it used to throw out of the request handler and end the process.
    const http = await rawRequest(base, 'GET //[ HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n')
    assert.match(http, /^HTTP\/1\.1 400 /)
    const upgrade = await rawRequest(
      base,
      'GET //[ HTTP/1.1\r\nHost: relay\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
    )
    assert.match(upgrade, /^HTTP\/1\.1 400 /)
    assert.equal((await fetch(`${base}${RELAY_PATHS.health}`)).status, 200, 'still serving')
  } finally {
    await relay.close()
  }
})

test('a node that speaks another protocol version is refused with a code that says so', async () => {
  const { relay, wsBase } = await startRelay()
  try {
    const stale = await connectNode(wsBase, { version: 999 })
    assert.equal(await stale.closed, CLOSE.unsupportedVersion)
    const missing = new WebSocket(`${wsBase}${RELAY_PATHS.nodeConnect}`)
    missing.on('error', () => undefined)
    missing.once('open', () =>
      missing.send(JSON.stringify({ t: 'hello', secret: SECRET, nodeId: 'n2', maxContexts: 2, contexts: [] }))
    )
    assert.equal(await new Promise((resolve) => missing.once('close', resolve)), CLOSE.unsupportedVersion)
    assert.equal(relay.registry.listNodes().length, 0)
  } finally {
    await relay.close()
  }
})

test('one very large message does not make the relay think a healthy connection is too slow', async () => {
  const { relay, base, wsBase } = await startRelay()
  const node = await connectNode(wsBase)
  try {
    await node.welcomed()
    const slot = (await (await createSlot(base)).json()) as { slotId: string; token: string }
    const client = await connectClient(wsBase, slot.slotId, slot.token)
    assert.equal((await client.ask(1, 'Browser.getVersion')).result.echo, 'Browser.getVersion')

    // 40 MB in each direction (the node echoes the method back), above the relay's 32 MiB buffer cap, with ordinary
    // messages right behind it. The backlog drains in moments, so nothing may be closed.
    const big = client.ask(2, 'x'.repeat(40_000_000))
    const small = client.ask(3, 'Page.enable')
    const another = client.ask(4, 'Runtime.evaluate')
    assert.equal((await big).result.echo.length, 40_000_000)
    assert.equal((await small).result.echo, 'Page.enable')
    assert.equal((await another).result.echo, 'Runtime.evaluate')
    assert.equal(client.socket.readyState, WebSocket.OPEN)
    client.socket.close()
  } finally {
    node.close()
    await relay.close()
  }
})

test('a caller that hangs up while waiting for capacity is not given a slot afterwards', async () => {
  const { relay, base, wsBase } = await startRelay()
  try {
    const hangUp = new AbortController()
    const request = createSlot(base, { runId: 'a', maxLifetimeSeconds: 600, waitMs: 5000 }, hangUp.signal)
    await wait(100)
    hangUp.abort()
    await assert.rejects(request)
    await wait(50)

    // Capacity arrives after the caller has gone: nothing is created for it.
    const node = await connectNode(wsBase)
    await node.welcomed()
    await wait(200)
    assert.deepEqual(relay.registry.listSlots(), [])
    assert.equal(node.received.filter((message) => message.t === 'context.create').length, 0)
    node.close()
  } finally {
    await relay.close()
  }
})

test('box settings: remote nodes are optional, the API key is not, and the relay’s other settings carry over', () => {
  const hash = hashToken('some-secret')
  const alone = parseBoxConfig({ BROWSERBOX_API_KEY: API_KEY })
  assert.deepEqual(alone.remoteEnrollmentSecrets, [], 'a box has its own node')
  assert.equal(alone.port, 8788)
  assert.equal(alone.maxAcquireWaitMs, 60_000)

  const withRemote = parseBoxConfig({
    BROWSERBOX_API_KEY: API_KEY,
    BROWSERBOX_ENROLLMENT_SECRETS: `edge:${hash}`,
    PORT: '9000',
    BROWSERBOX_MAX_ACQUIRE_WAIT_MS: '5000'
  })
  assert.deepEqual(withRemote.remoteEnrollmentSecrets, [{ id: 'edge', sha256: hash }])
  assert.equal(withRemote.port, 9000)
  assert.equal(withRemote.maxAcquireWaitMs, 5000)

  assert.throws(() => parseBoxConfig({}), /Invalid configuration/)
  assert.throws(() => parseBoxConfig({ BROWSERBOX_API_KEY: 'short' }), /Invalid configuration/)
  assert.throws(
    () => parseBoxConfig({ BROWSERBOX_API_KEY: API_KEY, BROWSERBOX_ENROLLMENT_SECRETS: 'not-a-pair' }),
    /name:sha256hex/
  )
  // A stand-alone relay, unlike a box, still needs at least one node allowed to join.
  assert.throws(() => parseEnrollmentSecrets(''), /at least one/)
})
