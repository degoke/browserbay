import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { assertSecureRelayUrl, classifyRelayUrl, sendsSecretInTheClear, startAgent, type Agent } from './agent.js'
import { createFakeChromium, type FakeChromium } from './fake-chromium.js'
import { createCdpScope } from './scope.js'
import { hashToken } from '../relay/registry.js'
import { CLOSE, RELAY_PATHS, TOKEN_HEADER } from '../protocol.js'
import { createRelayServer } from '../relay/server.js'

const API_KEY = 'relay-api-key-0123456789'
const SECRET = 'node-enrollment-secret-01'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000) {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${what}`)
    await wait(10)
  }
}

/** A scope hub in front of a fake Chromium that has its own default-context page, as a real browser does. */
async function startBrowser() {
  const fake = createFakeChromium()
  fake.createTarget()
  const scope = createCdpScope({ upstream: { send: fake.receive } })
  fake.onMessage(scope.onUpstreamMessage)
  await scope.start()
  await fake.flush()
  return { fake, scope }
}

// ---- the agent against a relay that is just a script -------------------------------------------------------------

type Frame = Record<string, any>

async function startFakeRelay() {
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  const received: Frame[] = []
  const streams = new Map<string, WebSocket>()
  const streamFrames: Array<{ streamId: string; text: string }> = []
  const controls: WebSocket[] = []
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://relay').pathname
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (path === RELAY_PATHS.nodeConnect) {
        controls.push(ws)
        ws.on('message', (data) => received.push(JSON.parse(data.toString())))
        return
      }
      const streamId = path.split('/').pop()!
      streams.set(streamId, ws)
      ws.on('message', (data, isBinary) =>
        streamFrames.push({ streamId, text: `${isBinary ? 'binary:' : ''}${data.toString()}` })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const control = () => controls.at(-1)!
  return {
    url,
    received,
    streams,
    streamFrames,
    controls,
    control,
    send: (frame: Frame) => control().send(JSON.stringify(frame)),
    of: (t: string) => received.filter((frame) => frame.t === t),
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate()
        server.close(() => resolve())
      })
  }
}

async function agentOnFakeRelay(overrides: Partial<Parameters<typeof startAgent>[0]> = {}) {
  const browser = await startBrowser()
  const relay = await startFakeRelay()
  const warnings: string[] = []
  const agent = startAgent({
    relayUrl: relay.url,
    enrollmentSecret: SECRET,
    nodeId: 'node-1',
    scope: browser.scope,
    maxContexts: 2,
    reconnectMinMs: 20,
    reconnectMaxMs: 60,
    logger: { warn: (message) => warnings.push(message) },
    ...overrides
  })
  await until(() => relay.of('hello').length > 0, 'the agent’s hello')
  relay.send({ t: 'welcome', heartbeatMs: 40 })
  await agent.whenConnected()
  return { ...browser, relay, agent, warnings }
}

const create = (slotId: string, extra: Frame = {}) => ({
  t: 'context.create',
  reqId: `req-${slotId}`,
  slotId,
  runId: `run-${slotId}`,
  tokenHash: hashToken(`token-${slotId}`),
  maxLifetimeSeconds: 600,
  ...extra
})

test('the agent introduces itself, then heartbeats at the pace the relay sets', async () => {
  const { relay, agent } = await agentOnFakeRelay()
  try {
    const [hello] = relay.of('hello')
    assert.deepEqual(hello, { t: 'hello', secret: SECRET, nodeId: 'node-1', maxContexts: 2, version: 1, contexts: [] })
    await until(() => relay.of('heartbeat').length >= 3, 'repeated heartbeats')
    assert.deepEqual(relay.of('heartbeat')[0], { t: 'heartbeat', draining: false, contexts: [] })
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('a context is created for a run, kept apart from the browser’s own profile, and reported with its token hash', async () => {
  const { fake, relay, agent } = await agentOnFakeRelay()
  try {
    relay.send(create('s1'))
    await until(() => relay.of('context.created').length === 1, 'the confirmation')
    assert.deepEqual(relay.of('context.created')[0], { t: 'context.created', reqId: 'req-s1' })
    assert.equal(agent.contextCount(), 1)
    assert.equal(fake.commands('Target.createBrowserContext')[0]!.params!.disposeOnDetach, false)

    await until(() => relay.of('heartbeat').some((beat) => beat.contexts.length === 1), 'a heartbeat listing it')
    const [report] = relay.of('heartbeat').at(-1)!.contexts
    assert.deepEqual(
      { slotId: report.slotId, runId: report.runId, tokenHash: report.tokenHash },
      { slotId: 's1', runId: 'run-s1', tokenHash: hashToken('token-s1') }
    )
    assert.ok(!JSON.stringify(relay.received).includes('token-s1'), 'only the hash ever reaches the node')
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('a full or draining node refuses new contexts, and a release frees the room', async () => {
  const { relay, agent } = await agentOnFakeRelay({ maxContexts: 1 })
  try {
    relay.send(create('s1'))
    await until(() => relay.of('context.created').length === 1, 'the first context')
    relay.send(create('s2'))
    await until(() => relay.of('context.failed').length === 1, 'a refusal')
    assert.deepEqual(relay.of('context.failed')[0], {
      t: 'context.failed',
      reqId: 'req-s2',
      message: 'This node is full'
    })

    relay.send({ t: 'context.release', slotId: 's1' })
    await until(() => agent.contextCount() === 0, 'the release')
    relay.send(create('s3'))
    await until(() => relay.of('context.created').length === 2, 'room again')
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('a context closes itself at its maximum lifetime, with no word from the relay', async () => {
  const { fake, relay, agent } = await agentOnFakeRelay()
  try {
    relay.send(create('s1', { maxLifetimeSeconds: 0.15 }))
    await until(() => relay.of('context.created').length === 1, 'the context')
    const contextId = [...fake.contexts.keys()].find((id) => id !== fake.DEFAULT_CONTEXT)!
    await until(() => agent.contextCount() === 0, 'the lifetime to end')
    assert.equal(fake.contexts.has(contextId), false, 'the browser context itself was disposed')
    await until(() => relay.of('heartbeat').at(-1)?.contexts.length === 0, 'a heartbeat without it')
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('a stream serves one client of one run, and ends with it', async () => {
  const { fake, scope, relay, agent } = await agentOnFakeRelay()
  try {
    relay.send({ t: 'stream.open', streamId: 'st-unknown', slotId: 's-none' })
    await until(() => relay.of('stream.failed').length === 1, 'a refusal for an unknown context')
    assert.equal(relay.of('stream.failed')[0]!.streamId, 'st-unknown')

    relay.send(create('s1'))
    await until(() => agent.contextCount() === 1, 'the context')
    relay.send({ t: 'stream.open', streamId: 'st-1', slotId: 's1' })
    await until(() => relay.streams.has('st-1'), 'the agent to dial the stream')
    const stream = relay.streams.get('st-1')!
    const replies: Frame[] = []
    stream.on('message', (data, isBinary) => {
      assert.equal(isBinary, false, 'DevTools messages stay text frames')
      replies.push(JSON.parse(data.toString()))
    })
    stream.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }))
    stream.send(JSON.stringify({ id: 2, method: 'Target.getBrowserContexts' }))
    await until(() => replies.length === 2, 'both replies')
    // Replies are matched by id: the hub answers some commands itself, ahead of ones that go to Chromium.
    const byId = (id: number) => replies.find((reply) => reply.id === id)!
    assert.equal(byId(1).result.product, 'FakeChrome/1')
    assert.deepEqual(byId(2).result.browserContextIds, [
      [...fake.contexts.keys()].find((id) => id !== fake.DEFAULT_CONTEXT)
    ])

    // Ending the stream releases what the client held, and the run's context stays.
    const closed = new Promise((resolve) => stream.once('close', resolve))
    stream.close(1000)
    await closed
    assert.equal(agent.contextCount(), 1)
    assert.ok(scope.hasRun('s1'))
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('losing the browser ends every stream with a code a WebSocket client can send and receive', async () => {
  const { scope, relay, agent } = await agentOnFakeRelay()
  try {
    relay.send(create('s1'))
    await until(() => agent.contextCount() === 1, 'the context')
    relay.send({ t: 'stream.open', streamId: 'st-1', slotId: 's1' })
    await until(() => relay.streams.has('st-1'), 'the stream')
    const closed = new Promise<number>((resolve) => relay.streams.get('st-1')!.once('close', (code) => resolve(code)))
    scope.onUpstreamClosed()
    // The scope says 1011; the built-in WebSocket client may only send 1000 or 3000-4999.
    assert.equal(await closed, 4500)
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('a node that loses the relay reconnects, and says which contexts it still holds', async () => {
  const { relay, agent, warnings } = await agentOnFakeRelay()
  try {
    relay.send(create('s1'))
    await until(() => agent.contextCount() === 1, 'the context')
    relay.control().close(1012, 'restart')
    await until(() => relay.of('hello').length === 2, 'a second hello')
    const hello = relay.of('hello')[1]!
    assert.deepEqual(
      hello.contexts.map((context: Frame) => context.slotId),
      ['s1']
    )
    assert.equal(agent.contextCount(), 1, 'nothing was closed because the relay went away')

    // A rejected enrollment is reported, and the node keeps trying rather than giving up for good.
    relay.control().close(4401, 'Unauthorized')
    await until(() => warnings.includes('The relay rejected this node’s enrollment secret'), 'the warning')
    await until(() => relay.of('hello').length === 3, 'a third hello')
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('draining stops new runs and resolves once the current ones are gone', async () => {
  const { relay, agent } = await agentOnFakeRelay()
  try {
    relay.send(create('s1'))
    await until(() => agent.contextCount() === 1, 'the context')
    const draining = agent.drain(5000)
    await until(() => relay.of('heartbeat').some((beat) => beat.draining === true), 'the draining flag')
    relay.send(create('s2'))
    await until(() => relay.of('context.failed').length === 1, 'a refusal')
    assert.equal(relay.of('context.failed')[0]!.message, 'This node is draining')

    let done = false
    void draining.then(() => (done = true))
    await wait(60)
    assert.equal(done, false, 'still waiting for the run that is left')
    relay.send({ t: 'context.release', slotId: 's1' })
    await draining
    assert.equal(agent.contextCount(), 0)
  } finally {
    await agent.close()
    await relay.close()
  }
})

// ---- the real agent against the real relay: the contract between them, with a fake Chromium underneath ---------------

async function startPool(port = 0) {
  const relay = createRelayServer({
    apiKey: API_KEY,
    enrollmentSecrets: [{ id: 'test', sha256: hashToken(SECRET) }]
  })
  const bound = await relay.listen(port, '127.0.0.1')
  return { relay, port: bound, base: `http://127.0.0.1:${bound}`, wsBase: `ws://127.0.0.1:${bound}` }
}

async function newClient(wsBase: string, slotId: string, token: string) {
  const socket = new WebSocket(`${wsBase}${RELAY_PATHS.cdp(slotId)}`, { headers: { [TOKEN_HEADER]: token } })
  const inbox: Frame[] = []
  let nextId = 1
  socket.on('error', () => undefined)
  socket.on('message', (data) => inbox.push(JSON.parse(data.toString())))
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return {
    socket,
    inbox,
    closed: new Promise<number>((resolve) => socket.once('close', (code) => resolve(code))),
    async call(method: string, params: object = {}, sessionId?: string) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params, sessionId }))
      await until(() => inbox.some((frame) => frame.id === id), `the answer to ${method}`)
      return inbox.find((frame) => frame.id === id)!
    }
  }
}

const slotOver = async (base: string, runId = 'run-1') => {
  const response = await fetch(`${base}${RELAY_PATHS.slots}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ runId, maxLifetimeSeconds: 600 })
  })
  assert.equal(response.status, 201)
  return (await response.json()) as { slotId: string; token: string; nodeId: string }
}

async function nodeOn(
  base: string,
  fake: FakeChromium,
  scope: ReturnType<typeof createCdpScope>,
  id = 'n1'
): Promise<Agent> {
  const agent = startAgent({
    relayUrl: base,
    enrollmentSecret: SECRET,
    nodeId: id,
    scope,
    maxContexts: 2,
    reconnectMinMs: 20,
    reconnectMaxMs: 60
  })
  await agent.whenConnected()
  assert.ok(fake)
  return agent
}

test('end to end: a slot on a node, reached through the relay, with its browser kept apart from every other run’s', async () => {
  const { fake, scope } = await startBrowser()
  const { relay, base, wsBase } = await startPool()
  const agent = await nodeOn(base, fake, scope)
  try {
    const a = await slotOver(base, 'run-a')
    const b = await slotOver(base, 'run-b')
    assert.equal(agent.contextCount(), 2)

    const clientA = await newClient(wsBase, a.slotId, a.token)
    const clientB = await newClient(wsBase, b.slotId, b.token)
    assert.equal((await clientA.call('Browser.getVersion')).result.product, 'FakeChrome/1')

    // Each run's client is attached to its own context's tabs only.
    await clientA.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    await clientB.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    const pageA = (await clientA.call('Target.createTarget', { url: 'https://a.example/' })).result.targetId as string
    const pageB = (await clientB.call('Target.createTarget', { url: 'https://b.example/' })).result.targetId as string
    assert.notEqual(fake.targets.get(pageA)!.browserContextId, fake.targets.get(pageB)!.browserContextId)
    const listedA = (await clientA.call('Target.getTargets')).result.targetInfos as Array<{ targetId: string }>
    assert.deepEqual(
      listedA.map((info) => info.targetId),
      [pageA]
    )
    const refused = await clientA.call('Target.closeTarget', { targetId: pageB })
    assert.equal(refused.error.code, -32602)
    assert.ok(fake.targets.has(pageB), 'run B’s tab was not touched')

    // Releasing one run ends its connections and disposes its context, and leaves the other alone.
    await fetch(`${base}${RELAY_PATHS.slot(a.slotId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${API_KEY}` }
    })
    assert.equal(await clientA.closed, 4001)
    await until(() => agent.contextCount() === 1, 'the node to close the context')
    assert.equal(fake.targets.has(pageA), false)
    assert.equal((await clientB.call('Browser.getVersion')).result.product, 'FakeChrome/1')
    clientB.socket.close()
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('end to end: a relay that restarts finds its runs again, and the run tokens still work', async () => {
  const { fake, scope } = await startBrowser()
  const first = await startPool()
  const agent = await nodeOn(first.base, fake, scope)
  try {
    const slot = await slotOver(first.base)
    const before = await newClient(first.wsBase, slot.slotId, slot.token)
    await before.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    const page = (await before.call('Target.createTarget', { url: 'https://a.example/' })).result.targetId as string
    before.socket.close()
    await first.relay.close()
    assert.equal(agent.contextCount(), 1, 'the node kept the run’s context while the relay was down')

    // Same address, empty table: the agent reconnects and reports what it holds.
    const second = await startPool(first.port)
    try {
      await until(async () => {
        const status = await fetch(`${second.base}${RELAY_PATHS.slot(slot.slotId)}`, {
          headers: { [TOKEN_HEADER]: slot.token }
        })
        return status.status === 200
      }, 'the new relay to adopt the slot')
      const after = await newClient(second.wsBase, slot.slotId, slot.token)
      await after.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
      const targets = (await after.call('Target.getTargets')).result.targetInfos as Array<{ targetId: string }>
      assert.deepEqual(
        targets.map((info) => info.targetId),
        [page],
        'the same tab is there for the next client'
      )
      after.socket.close()
    } finally {
      await second.relay.close()
    }
  } finally {
    await agent.close()
  }
})

test('agent: says why the relay will not have it, instead of retrying in silence', async () => {
  const relay = await startFakeRelay()
  const { scope } = await startBrowser()
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const agent = startAgent({
    relayUrl: relay.url,
    enrollmentSecret: SECRET,
    nodeId: 'n1',
    scope,
    reconnectMinMs: 5,
    reconnectMaxMs: 10,
    logger: { warn: (message: string, fields?: Record<string, unknown>) => warnings.push({ message, fields }) }
  })
  const heard = (pattern: RegExp) => warnings.some((entry) => pattern.test(entry.message))
  // Refuses the node's connections in the order they arrive, one close per attempt.
  let refused = 0
  const refuse = async (code: number, reason: string) => {
    await until(() => relay.controls.length > refused, 'the node to connect')
    relay.controls[refused++]!.close(code, reason)
  }
  try {
    // A wrong secret and an invalid hello have their own close codes, whatever reason text comes with them.
    await refuse(4401, 'Unauthorized')
    await until(() => heard(/enrollment secret/), 'the enrollment secret to be blamed')
    await refuse(4400, '')
    await until(() => heard(/id or slot count is not valid/), 'the invalid hello to be named')
    assert.deepEqual(warnings.find((entry) => /not valid/.test(entry.message))?.fields, {
      nodeId: 'n1',
      maxContexts: 5
    })
    await refuse(4409, 'This node connected again')
    await until(() => heard(/Another node with this id/), 'the duplicate id to be named')
    await refuse(4426, 'Unsupported protocol version')
    await until(() => heard(/different protocol version/), 'the version mismatch to be named')
    assert.ok(
      !warnings.some((entry) => /Could not connect/.test(entry.message)),
      'a relay that answers is not "unreachable"'
    )
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('agent: a relay it cannot reach is reported with the address and the error, not retried in silence', async () => {
  const { scope } = await startBrowser()
  const warnings: Array<{ message: string; fields?: Record<string, any> }> = []
  const agent = startAgent({
    relayUrl: 'http://127.0.0.1:1',
    enrollmentSecret: SECRET,
    nodeId: 'n1',
    scope,
    reconnectMinMs: 5,
    reconnectMaxMs: 10,
    logger: { warn: (message: string, fields?: Record<string, any>) => warnings.push({ message, fields }) }
  })
  try {
    await until(() => warnings.length >= 3, 'three reports')
    assert.ok(warnings.every((entry) => /Could not connect to the relay/.test(entry.message)))
    assert.equal(warnings[0]!.fields?.relay, 'http://127.0.0.1:1')
    assert.deepEqual(
      warnings.slice(0, 3).map((entry) => entry.fields?.attempt),
      [1, 2, 3]
    )
    await wait(300)
    assert.ok(warnings.length < 8, 'the next report waits: it is said at the start and now and then, not every try')
    assert.equal(agent.isConnected(), false)
  } finally {
    await agent.close()
  }
})

test('agent: an error from one connection attempt is not blamed for a later attempt that had none', async () => {
  const { scope } = await startBrowser()
  let attempts = 0
  /** Attempt 1 fails with an error event then closes; attempt 2 closes (1006) with no error event at all. */
  class ScriptedSocket {
    readyState = 0
    readonly url: string
    private listeners: Record<string, Array<(event: unknown) => void>> = {}
    constructor(url: string) {
      this.url = url
      const attempt = ++attempts
      setTimeout(() => {
        if (attempt === 1) this.emit('error', { message: 'ECONNREFUSED' })
        this.readyState = 3
        this.emit('close', { code: 1006, reason: '' })
      }, 1)
    }
    addEventListener(type: string, listener: (event: unknown) => void) {
      ;(this.listeners[type] ??= []).push(listener)
    }
    private emit(type: string, event: unknown) {
      for (const listener of this.listeners[type] ?? []) listener(event)
    }
    send() {}
    close() {}
  }
  const warnings: Array<{ message: string; fields?: Record<string, any> }> = []
  const agent = startAgent({
    relayUrl: 'http://127.0.0.1:1',
    enrollmentSecret: SECRET,
    nodeId: 'n1',
    scope,
    reconnectMinMs: 5,
    reconnectMaxMs: 10,
    WebSocketImpl: ScriptedSocket as unknown as typeof globalThis.WebSocket,
    logger: { warn: (message: string, fields?: Record<string, any>) => warnings.push({ message, fields }) }
  })
  try {
    await until(() => warnings.length >= 2, 'two reports')
    assert.equal(warnings[0]!.fields?.error, 'ECONNREFUSED')
    assert.equal(warnings[1]!.fields?.error, undefined, 'the second attempt reported no error, so none is shown')
  } finally {
    await agent.close()
  }
})

test('agent: whenConnected ends when the agent is closed, instead of waiting out its timeout', async () => {
  const relay = await startFakeRelay()
  const { scope } = await startBrowser()
  const agent = startAgent({ relayUrl: relay.url, enrollmentSecret: SECRET, nodeId: 'n1', scope })
  try {
    await until(() => relay.of('hello').length === 1, 'the hello')
    const waiting = agent.whenConnected(30_000)
    const started = Date.now()
    await agent.close()
    await assert.rejects(waiting, /closed/)
    assert.ok(Date.now() - started < 2000, 'it did not wait for its 30 s timeout')

    // And once the relay answers, it resolves from the welcome itself.
    const again = startAgent({ relayUrl: relay.url, enrollmentSecret: SECRET, nodeId: 'n2', scope })
    try {
      const connected = again.whenConnected(10_000)
      await until(() => relay.of('hello').length >= 2, 'the second hello')
      relay.send({ t: 'welcome', heartbeatMs: 1000, version: 1 })
      await connected
    } finally {
      await again.close()
    }
  } finally {
    await relay.close()
  }
})

test('agent: closing an agent that keeps reconnecting leaves no connection behind, so the relay can shut down', async () => {
  const { scope } = await startBrowser()
  for (let i = 0; i < 10; i++) {
    const relay = await startFakeRelay()
    const agent = startAgent({
      relayUrl: relay.url,
      enrollmentSecret: SECRET,
      nodeId: 'n1',
      scope,
      reconnectMinMs: 5,
      reconnectMaxMs: 10
    })
    // Refuse every connection straight away, so the agent is always somewhere between "connecting" and "reconnecting".
    const refuser = setInterval(() => {
      for (const control of relay.controls) if (control.readyState === 1) control.close(4401, 'Unauthorized')
    }, 2)
    await wait(60)
    clearInterval(refuser)
    await agent.close()
    // A connection that was still being made when the agent closed used to complete afterwards and stay open for ever:
    // the relay's server.close() then never finished, and neither did the process.
    const result = await Promise.race([relay.close().then(() => 'closed'), wait(3000).then(() => 'HUNG')])
    assert.equal(result, 'closed', `round ${i}: the relay could not close because a connection was left behind`)
  }
})

test('agent: a relay that sends things that are not messages does not take the node down', async () => {
  const relay = await startFakeRelay()
  const { scope } = await startBrowser()
  const uncaught: unknown[] = []
  const onUncaught = (error: unknown) => uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  const agent = startAgent({ relayUrl: relay.url, enrollmentSecret: SECRET, nodeId: 'n1', scope })
  try {
    await until(() => relay.of('hello').length === 1, 'the hello')
    for (const frame of ['null', 'true', '7', '"text"', '[]', '[null]', 'not json']) relay.control().send(frame)
    relay.send({ t: 'welcome', heartbeatMs: 30, version: 1 })
    await until(() => relay.of('heartbeat').length >= 1, 'a heartbeat after the junk')
    assert.deepEqual(uncaught, [], 'nothing was thrown')
    assert.equal(agent.isConnected(), true)
  } finally {
    process.off('uncaughtException', onUncaught)
    await agent.close()
    await relay.close()
  }
})

test('end to end: a full pool refuses another run without ever reaching the browser', async () => {
  const { fake, scope } = await startBrowser()
  const { relay, base } = await startPool()
  const agent = await nodeOn(base, fake, scope)
  try {
    await slotOver(base, 'run-1')
    await slotOver(base, 'run-2')
    const full = await fetch(`${base}${RELAY_PATHS.slots}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'run-3', maxLifetimeSeconds: 600, waitMs: 0 })
    })
    assert.equal(full.status, 503)
    assert.equal(fake.commands('Target.createBrowserContext').length, 2, 'the third run never reached the browser')
  } finally {
    await agent.close()
    await relay.close()
  }
})

// ---- hardening: large replies, a stalled browser, plain-http relays, protocol versions -----------------------------

test('one very large reply does not make the node think a healthy stream is too slow', async () => {
  const { fake, relay, agent } = await agentOnFakeRelay()
  try {
    relay.send(create('s1'))
    await until(() => agent.contextCount() === 1, 'the context')
    const contextId = [...fake.contexts.keys()].find((id) => id !== fake.DEFAULT_CONTEXT)!
    // A tab with a 20 MB address makes Target.getTargets answer with about 20 MB, above the node's 16 MiB buffer cap.
    fake.createTarget({ browserContextId: contextId, url: `https://example.com/${'x'.repeat(20_000_000)}` })
    await fake.flush()
    relay.send({ t: 'stream.open', streamId: 'st-1', slotId: 's1' })
    await until(() => relay.streams.has('st-1'), 'the stream')

    const stream = relay.streams.get('st-1')!
    const sizes = new Map<number, number>()
    stream.on('message', (data) => sizes.set(JSON.parse(data.toString()).id, data.toString().length))
    stream.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }))
    stream.send(JSON.stringify({ id: 2, method: 'Browser.getVersion' }))
    stream.send(JSON.stringify({ id: 3, method: 'Target.getBrowserContexts' }))
    await until(() => sizes.size === 3, 'all three replies', 10_000)
    assert.ok(sizes.get(1)! > 20_000_000)
    assert.equal(stream.readyState, WebSocket.OPEN, 'the stream was not closed for being slow')
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('a stream whose backlog stays over the cap is closed as a slow consumer', async () => {
  // Stream sockets report a backlog that never drains; the control socket is left alone.
  class StuckSocket extends globalThis.WebSocket {
    override get bufferedAmount() {
      return this.url.includes('/nodes/stream/') ? 1_000_000 : super.bufferedAmount
    }
  }
  const { relay, agent } = await agentOnFakeRelay({
    WebSocketImpl: StuckSocket,
    maxBufferedBytes: 1000,
    slowConsumerGraceMs: 50
  })
  try {
    relay.send(create('s1'))
    await until(() => agent.contextCount() === 1, 'the context')
    relay.send({ t: 'stream.open', streamId: 'st-1', slotId: 's1' })
    await until(() => relay.streams.has('st-1'), 'the stream')
    const stream = relay.streams.get('st-1')!
    const closed = new Promise<number>((resolve) => stream.once('close', (code) => resolve(code)))
    let replies = 0
    stream.on('message', () => replies++)

    // Over the cap for the first time: still within the grace period, so it is answered.
    stream.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }))
    await until(() => replies === 1, 'the first reply')
    await wait(250)
    // Still over the cap after the grace period: the next reply closes the stream instead of queueing.
    stream.send(JSON.stringify({ id: 2, method: 'Browser.getVersion' }))
    let giveUp: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      closed,
      new Promise((resolve) => (giveUp = setTimeout(() => resolve('still open'), 2000)))
    ])
    clearTimeout(giveUp)
    assert.equal(outcome, CLOSE.slowConsumer, 'the stream was closed as a slow consumer')
    assert.equal(replies, 1, 'the second reply was not sent')
    assert.equal(agent.contextCount(), 1, 'the run’s context stays')
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('a browser that stops answering fails a create instead of holding its slot for ever', async () => {
  const relay = await startFakeRelay()
  const scope = createCdpScope({ upstream: { send() {} }, requestTimeoutMs: 30 })
  const agent = startAgent({
    relayUrl: relay.url,
    enrollmentSecret: SECRET,
    nodeId: 'node-1',
    scope,
    maxContexts: 1,
    reconnectMinMs: 20,
    reconnectMaxMs: 60
  })
  try {
    await until(() => relay.of('hello').length > 0, 'the agent’s hello')
    relay.send({ t: 'welcome', heartbeatMs: 40, version: 1 })
    await agent.whenConnected()

    relay.send(create('s1'))
    await until(() => relay.of('context.failed').length === 1, 'the first failure')
    relay.send(create('s2'))
    await until(() => relay.of('context.failed').length === 2, 'the second failure')
    assert.deepEqual(
      relay.of('context.failed').map((frame) => frame.message),
      ['The browser could not create a context', 'The browser could not create a context'],
      'the second create reached the browser too: the first one did not keep the node’s only slot'
    )
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('a node will not send its enrollment secret over plain http to another machine', () => {
  for (const fine of [
    'https://relay.example.com',
    'wss://relay.example.com/prefix',
    'http://localhost:8788',
    'http://127.0.0.1:8788',
    'ws://[::1]:8788',
    'http://relay.localhost'
  ]) {
    assert.doesNotThrow(() => assertSecureRelayUrl(fine), fine)
  }
  for (const refused of [
    'http://relay.example.com',
    'ws://relay.example.com',
    'http://10.0.0.5:8788',
    'ftp://relay.example.com'
  ]) {
    assert.throws(() => assertSecureRelayUrl(refused), /https/, refused)
  }
  assert.throws(
    () =>
      startAgent({ relayUrl: 'http://relay.example.com', enrollmentSecret: SECRET, nodeId: 'n', scope: {} as never }),
    /https/,
    'and starting an agent for one is refused before anything connects'
  )
})

test('the opt-in allows plain http or ws to a private network, and nothing else', () => {
  const privateAddresses = [
    'http://my-relay.ns.svc:8788',
    'http://my-relay.ns.svc.cluster.local',
    'http://relay:8788',
    'http://relay.internal',
    'http://nas.local:8788',
    'ws://10.0.0.5:8788/prefix',
    'http://172.16.0.1',
    'http://172.31.255.254',
    'http://192.168.1.20',
    'http://169.254.20.10',
    'http://100.64.0.7',
    'http://[fd00::1]:8788',
    'http://[fe80::1]:8788'
  ]
  for (const plain of privateAddresses) {
    assert.throws(() => assertSecureRelayUrl(plain), /https/, `${plain} is refused by default`)
    assert.doesNotThrow(() => assertSecureRelayUrl(plain, { allowInsecure: true }), plain)
    assert.equal(classifyRelayUrl(plain), 'private', plain)
    assert.equal(sendsSecretInTheClear(plain), true, `${plain} sends the secret in the clear`)
  }
  // A public address stays refused even with the opt-in: a wrong address must not send the secret across the internet.
  for (const publicAddress of [
    'http://relay.example.com',
    'ws://relay.example.com:8788',
    'http://8.8.8.8',
    'http://172.32.0.1', // just outside 172.16/12
    'http://172.15.255.255',
    'http://100.128.0.1', // just outside 100.64/10
    'http://relay.svc.evil.com', // only a name that ENDS in .svc is a Service name
    'http://[2001:db8::1]:8788'
  ]) {
    assert.equal(classifyRelayUrl(publicAddress), 'public', publicAddress)
    assert.throws(() => assertSecureRelayUrl(publicAddress), /https/, `${publicAddress} is refused by default`)
    assert.throws(
      () => assertSecureRelayUrl(publicAddress, { allowInsecure: true }),
      /only covers a relay on a private network/,
      `${publicAddress} is refused even with the opt-in`
    )
    assert.equal(sendsSecretInTheClear(publicAddress), true)
  }
  // Other protocols are refused too, and TLS and loopback need no opt-in.
  for (const refused of ['ftp://relay.example.com', 'file:///relay', 'gopher://relay.internal']) {
    assert.equal(classifyRelayUrl(refused), 'unsupported', refused)
    assert.throws(() => assertSecureRelayUrl(refused, { allowInsecure: true }), /https/, refused)
  }
  for (const fine of [
    'https://relay.example.com',
    'wss://relay.example.com',
    'http://127.0.0.1:8788',
    'http://localhost'
  ]) {
    assert.doesNotThrow(() => assertSecureRelayUrl(fine, { allowInsecure: true }), fine)
    assert.equal(sendsSecretInTheClear(fine), false, `${fine} does not send the secret in the clear`)
  }
  assert.throws(
    () => assertSecureRelayUrl('http://relay.example.com'),
    /BROWSERBAY_ALLOW_INSECURE_RELAY/,
    'and the error says how'
  )
})

test('with the opt-in a node dials a plain relay on another machine, and says it is doing so', async () => {
  const urls: string[] = []
  class Recorder {
    readyState = 0
    constructor(url: string) {
      urls.push(url)
    }
    addEventListener() {}
    send() {}
    close() {}
  }
  const warnings: string[] = []
  const options = {
    relayUrl: 'http://relay.internal:8788',
    enrollmentSecret: SECRET,
    nodeId: 'n',
    scope: {} as never,
    logger: { warn: (message: string) => void warnings.push(message) },
    WebSocketImpl: Recorder as unknown as typeof globalThis.WebSocket
  }
  assert.throws(() => startAgent(options), /https/, 'refused without the opt-in')
  assert.throws(
    () => startAgent({ ...options, relayUrl: 'http://relay.example.com', allowInsecureRelay: true }),
    /only covers a relay on a private network/,
    'and a public address is refused even with it'
  )
  assert.deepEqual(urls, [], 'and nothing was dialled')

  const agent = startAgent({ ...options, allowInsecureRelay: true })
  try {
    assert.match(urls[0] ?? '', /^ws:\/\/relay\.internal:8788\//, 'the node dials the plain address')
    assert.equal(warnings.filter((message) => /without TLS/.test(message)).length, 1, 'and warns once')
    assert.ok(warnings[0]?.includes('http://relay.internal:8788'), 'naming the relay')
    assert.ok(!warnings[0]?.includes(SECRET), 'but never the secret')
  } finally {
    await agent.close()
  }
})

test('a relay that speaks another protocol version is warned about, and so is being refused for it', async () => {
  const { relay, agent, warnings } = await agentOnFakeRelay()
  try {
    const mismatch = () => warnings.filter((message) => message.includes('different protocol version')).length
    relay.send({ t: 'welcome', heartbeatMs: 40, version: 99 })
    await until(() => mismatch() === 1, 'a warning for the relay’s version')
    relay.control().close(4426, 'Unsupported protocol version')
    await until(() => mismatch() === 2, 'a warning for being refused')
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('agent: a slot whose own browser ends is dropped from what the node reports, and its connections are not left open', async () => {
  const { fake, scope } = await startBrowser()
  const listeners: Array<(runKey: string, reason: string) => void> = []
  const disposed: string[] = []
  const host = {
    createRun: (runKey: string) => scope.createRun(runKey),
    disposeRun: async (runKey: string) => {
      disposed.push(runKey)
      await scope.disposeRun(runKey)
    },
    connect: scope.connect,
    onRunEnded: (listener: (runKey: string, reason: string) => void) => void listeners.push(listener)
  }
  const relay = await startFakeRelay()
  const agent = startAgent({
    relayUrl: relay.url,
    enrollmentSecret: SECRET,
    nodeId: 'node-1',
    scope: host,
    maxContexts: 2
  })
  try {
    await until(() => relay.of('hello').length > 0, 'the agent’s hello')
    relay.send({ t: 'welcome', heartbeatMs: 40 })
    await agent.whenConnected()
    relay.send(create('s1'))
    relay.send(create('s2'))
    await until(() => agent.contextCount() === 2, 'both contexts')

    listeners[0]!('s1', 'its browser ended (SIGSEGV)')
    await until(() => agent.contextCount() === 1, 's1 to be dropped')
    assert.deepEqual(agent.contextIds(), ['s2'])
    assert.deepEqual(disposed, ['s1'])
    await until(() => relay.of('context.ended').length > 0, 'the relay to be told')
    assert.deepEqual(
      relay.of('context.ended').map((frame) => [frame.slotId, frame.reason]),
      [['s1', 'its browser ended (SIGSEGV)']],
      'the relay is told at once, not left to notice'
    )
    await until(
      () => relay.of('heartbeat').some((beat) => beat.contexts.length === 1 && beat.contexts[0].slotId === 's2'),
      'a heartbeat without it'
    )
    assert.ok(fake)
  } finally {
    await agent.close()
    await relay.close()
  }
})

test('agent: a context still being closed holds its place, so a replacement cannot start a second browser beside it', async () => {
  const { scope } = await startBrowser()
  let finishDispose: () => void = () => undefined
  const slowDispose = new Promise<void>((resolve) => (finishDispose = resolve))
  const host = {
    createRun: (runKey: string) => scope.createRun(runKey),
    disposeRun: async (runKey: string) => {
      await slowDispose
      await scope.disposeRun(runKey)
    },
    connect: scope.connect
  }
  const relay = await startFakeRelay()
  const agent = startAgent({
    relayUrl: relay.url,
    enrollmentSecret: SECRET,
    nodeId: 'node-1',
    scope: host,
    maxContexts: 1
  })
  try {
    await until(() => relay.of('hello').length > 0, 'the agent’s hello')
    relay.send({ t: 'welcome', heartbeatMs: 40 })
    await agent.whenConnected()
    relay.send(create('s1'))
    await until(() => agent.contextCount() === 1, 'the first context')

    relay.send({ t: 'context.release', slotId: 's1' })
    await until(() => agent.contextCount() === 0, 's1 to leave the table')
    relay.send(create('s2'))
    await until(() => relay.of('context.failed').length === 1, 'the create to be refused while s1 is still closing')
    assert.match(relay.of('context.failed')[0].message, /full/)

    finishDispose()
    await until(() => relay.of('heartbeat').some((beat) => beat.contexts.length === 0), 'the close to finish')
    relay.send(create('s3'))
    await until(() => relay.of('context.created').length === 1, 'a create once the old browser is gone')
  } finally {
    finishDispose()
    await agent.close()
    await relay.close()
  }
})
