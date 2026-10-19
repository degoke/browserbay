import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AllocationAbortedError,
  createNodeRegistry,
  hashToken,
  NoCapacityError,
  UnsupportedError,
  type NodeLink
} from './registry.js'
import { CLOSE, type NodeContextReport, type RelayToNode } from '../protocol.js'

/** A node's control connection, recording what the relay sends. `answers` decides how it replies to context.create. */
function fakeLink(
  registry: ReturnType<typeof createNodeRegistry>,
  id: string,
  answers: 'ok' | 'full' | 'refuse' | 'silent' = 'ok'
) {
  const sent: RelayToNode[] = []
  const closed: Array<{ code: number; reason: string }> = []
  const link: NodeLink = {
    send(message) {
      sent.push(message)
      if (message.t !== 'context.create') return
      if (answers === 'ok') queueMicrotask(() => registry.answerCreate(id, message.reqId))
      if (answers === 'full') queueMicrotask(() => registry.answerCreate(id, message.reqId, 'This node is full'))
      if (answers === 'refuse') {
        queueMicrotask(() => registry.answerCreate(id, message.reqId, 'This node does not have that time zone', true))
      }
    },
    close: (code, reason) => closed.push({ code, reason })
  }
  return { link, sent, closed }
}

const report = (slotId: string, token: string, runId = `run-${slotId}`): NodeContextReport => ({
  slotId,
  runId,
  tokenHash: hashToken(token),
  createdAt: new Date().toISOString()
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('a slot goes to the least-loaded node, and its token opens it and nothing else', async () => {
  const registry = createNodeRegistry()
  const busy = fakeLink(registry, 'busy')
  const idle = fakeLink(registry, 'idle')
  registry.registerNode({ id: 'busy', maxContexts: 4, link: busy.link, contexts: [report('s-old', 't-old')] })
  registry.registerNode({ id: 'idle', maxContexts: 4, link: idle.link, contexts: [] })

  const slot = await registry.allocate({ runId: 'run-1', maxLifetimeSeconds: 600, waitMs: 0 })
  assert.equal(slot.nodeId, 'idle')
  const created = idle.sent.find((message) => message.t === 'context.create')
  assert.ok(created && created.t === 'context.create')
  assert.equal(created.slotId, slot.slotId)
  assert.equal(created.runId, 'run-1')
  assert.equal(created.maxLifetimeSeconds, 600)
  assert.equal(created.tokenHash, hashToken(slot.token), 'the node is told only the hash')
  assert.ok(!JSON.stringify(idle.sent).includes(slot.token))

  assert.equal(registry.authorize(slot.slotId, slot.token)?.nodeId, 'idle')
  assert.equal(registry.authorize(slot.slotId, 'wrong'), null)
  assert.equal(registry.authorize(slot.slotId, undefined), null)
  assert.equal(registry.authorize('s-old', slot.token), null, 'a token opens only its own slot')
  assert.equal(registry.authorize('s-missing', slot.token), null)
  assert.equal(registry.linkFor(slot.slotId), idle.link)
})

test('capacity is respected, waited for, and reported as no capacity when it never comes', async () => {
  const registry = createNodeRegistry()
  const node = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 1, link: node.link, contexts: [] })
  const first = await registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 0 })

  await assert.rejects(registry.allocate({ runId: 'b', maxLifetimeSeconds: 600, waitMs: 40 }), NoCapacityError)

  const waiting = registry.allocate({ runId: 'c', maxLifetimeSeconds: 600, waitMs: 2000 })
  await wait(20)
  assert.equal(registry.release(first.slotId), true)
  const second = await waiting
  assert.equal(second.nodeId, 'n1', 'the waiting run got the slot that was freed')
  assert.equal(registry.listNodes()[0]!.contexts, 1)
})

test('two creates arriving together cannot both take a node’s last slot', async () => {
  const registry = createNodeRegistry()
  const node = fakeLink(registry, 'n1', 'silent')
  registry.registerNode({ id: 'n1', maxContexts: 1, link: node.link, contexts: [] })
  const first = registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 0 })
  const second = registry.allocate({ runId: 'b', maxLifetimeSeconds: 600, waitMs: 0 })

  // The first request's create is still unanswered, and it already holds the only slot.
  await assert.rejects(second, NoCapacityError)
  const creates = node.sent.filter((message) => message.t === 'context.create')
  assert.equal(creates.length, 1)
  registry.answerCreate('n1', (creates[0] as { reqId: string }).reqId)
  assert.equal((await first).nodeId, 'n1')
  assert.equal(registry.listSlots().length, 1)
})

test('draining and disconnected nodes are not given runs, and a node that refuses is skipped', async () => {
  const registry = createNodeRegistry()
  const draining = fakeLink(registry, 'draining')
  const gone = fakeLink(registry, 'gone')
  const refuses = fakeLink(registry, 'refuses', 'full')
  const works = fakeLink(registry, 'works')
  registry.registerNode({ id: 'draining', maxContexts: 4, link: draining.link, contexts: [] })
  registry.heartbeat('draining', draining.link, { draining: true, contexts: [] })
  registry.registerNode({ id: 'gone', maxContexts: 4, link: gone.link, contexts: [] })
  registry.unregisterNode('gone', gone.link)
  registry.registerNode({ id: 'refuses', maxContexts: 4, link: refuses.link, contexts: [] })
  registry.registerNode({ id: 'works', maxContexts: 4, link: works.link, contexts: [] })

  const slot = await registry.allocate({ runId: 'run', maxLifetimeSeconds: 600, waitMs: 0 })
  assert.equal(slot.nodeId, 'works')
  assert.equal(draining.sent.filter((message) => message.t === 'context.create').length, 0)
  assert.equal(gone.sent.filter((message) => message.t === 'context.create').length, 0)
})

test('a node that never confirms a create is given up on', async () => {
  const registry = createNodeRegistry({ createTimeoutMs: 30 })
  const node = fakeLink(registry, 'n1', 'silent')
  registry.registerNode({ id: 'n1', maxContexts: 2, link: node.link, contexts: [] })
  await assert.rejects(registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 0 }), NoCapacityError)
  assert.equal(registry.listSlots().length, 0)
  assert.equal(registry.listNodes()[0]!.contexts, 0, 'the reservation was given back')
})

test('a create the relay gave up on is not adopted later, when the node turns out to have made it', async () => {
  const registry = createNodeRegistry({ createTimeoutMs: 30 })
  const node = fakeLink(registry, 'n1', 'silent')
  registry.registerNode({ id: 'n1', maxContexts: 2, link: node.link, contexts: [] })
  await assert.rejects(registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 0 }), NoCapacityError)
  const created = node.sent.find((message) => message.t === 'context.create')
  assert.ok(created && created.t === 'context.create')
  const releases = () =>
    node.sent.filter((message) => message.t === 'context.release' && message.slotId === created.slotId)
  assert.equal(releases().length, 1, 'the node is told to drop it the moment the relay gives up')

  // The node did create it, slowly: its next heartbeat reports a context nobody holds the token for.
  registry.heartbeat('n1', node.link, { draining: false, contexts: [report(created.slotId, 'never-handed-out')] })
  assert.deepEqual(registry.listSlots(), [], 'it is not adopted: it would fill a place until its lifetime ran out')
  assert.equal(registry.listNodes()[0]!.contexts, 0)
  assert.equal(releases().length, 2, 'and the node is told again')
})

test('a create lost to a dropped connection is not adopted when the node comes back holding it', async () => {
  const registry = createNodeRegistry({ createTimeoutMs: 5000 })
  const first = fakeLink(registry, 'n1', 'silent')
  registry.registerNode({ id: 'n1', maxContexts: 2, link: first.link, contexts: [] })
  const allocation = registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 0 })
  await wait(10)
  const created = first.sent.find((message) => message.t === 'context.create')
  assert.ok(created && created.t === 'context.create')

  registry.unregisterNode('n1', first.link)
  await assert.rejects(allocation, NoCapacityError)

  const second = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 2, link: second.link, contexts: [report(created.slotId, 'unheld')] })
  assert.deepEqual(registry.listSlots(), [], 'what the node says it holds is not ours to adopt')
  assert.ok(second.sent.some((message) => message.t === 'context.release' && message.slotId === created.slotId))
})

test('a create lost to a node that RECONNECTS while it was pending is not left adopted from the new hello', async () => {
  const registry = createNodeRegistry({ createTimeoutMs: 5000 })
  const first = fakeLink(registry, 'n1', 'silent')
  registry.registerNode({ id: 'n1', maxContexts: 2, link: first.link, contexts: [] })
  const allocation = registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 0 })
  await wait(10)
  const created = first.sent.find((message) => message.t === 'context.create')
  assert.ok(created && created.t === 'context.create')

  // The node made the context, the confirmation was lost, and it came back on a new connection (the old one not yet
  // seen to close) whose hello lists the context. registerNode adopts it before the pending create is rejected.
  const second = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 2, link: second.link, contexts: [report(created.slotId, 'unheld')] })
  await assert.rejects(allocation, NoCapacityError)

  assert.deepEqual(registry.listSlots(), [], 'the slot adopted from the hello is ended: nobody holds its token')
  assert.equal(registry.listNodes()[0]!.contexts, 0)
  assert.ok(
    second.sent.some((message) => message.t === 'context.release' && message.slotId === created.slotId),
    'and the NEW connection, not the dead one, is told to close it'
  )
  registry.heartbeat('n1', second.link, { draining: false, contexts: [report(created.slotId, 'unheld')] })
  assert.deepEqual(registry.listSlots(), [], 'a later heartbeat does not bring it back')
})

test('a restarted relay adopts what a node reports, and the run token still opens it', () => {
  const registry = createNodeRegistry()
  const node = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 4, link: node.link, contexts: [report('s1', 'token-one')] })
  assert.equal(registry.authorize('s1', 'token-one')?.runId, 'run-s1')
  assert.deepEqual(
    registry.listSlots().map((slot) => [slot.slotId, slot.nodeId]),
    [['s1', 'n1']]
  )
})

test('a heartbeat that omits a context drops it only once the node has had time to report it', () => {
  let now = 1_000_000
  const removed: string[] = []
  const registry = createNodeRegistry({
    now: () => now,
    reconcileGraceMs: 15_000,
    onSlotRemoved: (id) => removed.push(id)
  })
  const node = fakeLink(registry, 'n1')
  registry.registerNode({
    id: 'n1',
    maxContexts: 4,
    link: node.link,
    contexts: [report('s1', 't1'), report('s2', 't2')]
  })
  const slotIds = () =>
    registry
      .listSlots()
      .map((slot) => slot.slotId)
      .sort()

  now += 5_000
  registry.heartbeat('n1', node.link, { draining: false, contexts: [report('s1', 't1')] })
  assert.deepEqual(slotIds(), ['s1', 's2'], 'too soon to say s2 is gone')

  now += 20_000
  registry.heartbeat('n1', node.link, { draining: false, contexts: [report('s1', 't1')] })
  assert.deepEqual(slotIds(), ['s1'])
  assert.deepEqual(removed, ['s2'])
})

test('a dropped control socket keeps the node’s runs until the node has been silent too long', () => {
  let now = 1_000_000
  const removed: Array<[string, string]> = []
  const registry = createNodeRegistry({
    now: () => now,
    nodeTimeoutMs: 15_000,
    onSlotRemoved: (id, reason) => removed.push([id, reason])
  })
  const node = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 4, link: node.link, contexts: [report('s1', 't1')] })

  registry.unregisterNode('n1', node.link)
  assert.equal(registry.linkFor('s1'), null, 'not reachable while the socket is down')
  assert.ok(registry.getSlot('s1'), 'but the run’s slot is still there')
  now += 10_000
  registry.sweep()
  assert.ok(registry.getSlot('s1'))

  // It comes back in time: nothing was lost.
  const back = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 4, link: back.link, contexts: [report('s1', 't1')] })
  assert.equal(registry.linkFor('s1'), back.link)
  now += 20_000
  registry.heartbeat('n1', back.link, { draining: false, contexts: [report('s1', 't1')] })
  registry.sweep()
  assert.ok(registry.getSlot('s1'))

  // It does not: the sweep ends the node and its runs.
  now += 20_000
  registry.sweep()
  assert.equal(registry.getSlot('s1'), null)
  assert.deepEqual(removed, [['s1', 'the node stopped heartbeating']])
  assert.deepEqual(back.closed, [{ code: CLOSE.nodeTimeout, reason: 'No heartbeat' }])
  assert.deepEqual(registry.listNodes(), [])
})

test('a node connecting again replaces its old connection, and the old one closing later changes nothing', () => {
  const registry = createNodeRegistry()
  const first = fakeLink(registry, 'n1')
  const second = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 4, link: first.link, contexts: [report('s1', 't1')] })
  registry.registerNode({ id: 'n1', maxContexts: 4, link: second.link, contexts: [report('s1', 't1')] })
  assert.deepEqual(first.closed, [{ code: CLOSE.replaced, reason: 'This node connected again' }])

  registry.unregisterNode('n1', first.link)
  assert.equal(registry.linkFor('s1'), second.link, 'the stale connection closing did not disconnect the node')
  registry.heartbeat('n1', first.link, { draining: true, contexts: [] })
  assert.equal(registry.listNodes()[0]!.draining, false, 'and its stale heartbeats are ignored')
})

test('releasing a slot tells its node, closes its holders, and is safe to repeat', async () => {
  const removed: string[] = []
  const registry = createNodeRegistry({ onSlotRemoved: (id) => removed.push(id) })
  const node = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 2, link: node.link, contexts: [] })
  const slot = await registry.allocate({ runId: 'run', maxLifetimeSeconds: 600, waitMs: 0 })

  assert.equal(registry.release(slot.slotId), true)
  assert.deepEqual(node.sent.at(-1), { t: 'context.release', slotId: slot.slotId })
  assert.deepEqual(removed, [slot.slotId])
  assert.equal(registry.release(slot.slotId), false)
  assert.equal(registry.authorize(slot.slotId, slot.token), null)
  assert.deepEqual(registry.listSlots(), [])
})

test('listings describe slots and nodes without any secret', async () => {
  const registry = createNodeRegistry()
  const node = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 3, link: node.link, contexts: [] })
  const slot = await registry.allocate({ runId: 'run-x', maxLifetimeSeconds: 600, waitMs: 0 })
  const [listed] = registry.listSlots()
  assert.deepEqual(Object.keys(listed!).sort(), ['createdAt', 'nodeId', 'runId', 'slotId'])
  assert.equal(listed!.runId, 'run-x')
  const [summary] = registry.listNodes()
  assert.deepEqual(
    {
      nodeId: summary!.nodeId,
      maxContexts: summary!.maxContexts,
      contexts: summary!.contexts,
      draining: summary!.draining
    },
    { nodeId: 'n1', maxContexts: 3, contexts: 1, draining: false }
  )
  assert.ok(!JSON.stringify([listed, summary]).includes(slot.token))
})

test('a slot the relay ended is not brought back by the node that still holds its context', async () => {
  let now = 1_000_000
  const registry = createNodeRegistry({ now: () => now, nodeTimeoutMs: 15_000, tombstoneMs: 60_000 })
  const first = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 4, link: first.link, contexts: [] })
  const slot = await registry.allocate({ runId: 'run-1', maxLifetimeSeconds: 600, waitMs: 0 })
  const held = report(slot.slotId, slot.token, 'run-1')
  const releasesFor = (link: ReturnType<typeof fakeLink>, slotId: string) =>
    link.sent.filter((message) => message.t === 'context.release' && message.slotId === slotId).length

  // (a) The run ends while the node's control socket is down, so the release cannot be delivered...
  registry.unregisterNode('n1', first.link)
  assert.equal(registry.release(slot.slotId), true)
  assert.equal(releasesFor(first, slot.slotId), 0)
  // ...and when the node reconnects still holding the context, it is told to close it, not given the slot back.
  const second = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 4, link: second.link, contexts: [held] })
  assert.equal(registry.getSlot(slot.slotId), null)
  assert.equal(registry.authorize(slot.slotId, slot.token), null, 'the old token no longer opens anything')
  assert.equal(releasesFor(second, slot.slotId), 1)

  // (b) A heartbeat that was already on its way when the slot was released.
  const other = await registry.allocate({ runId: 'run-2', maxLifetimeSeconds: 600, waitMs: 0 })
  const heldOther = report(other.slotId, other.token, 'run-2')
  registry.release(other.slotId)
  registry.heartbeat('n1', second.link, { draining: false, contexts: [held, heldOther] })
  assert.deepEqual(registry.listSlots(), [])
  assert.equal(
    releasesFor(second, other.slotId),
    2,
    'released again, once for the release and once for the late report'
  )

  // (c) A node that was dropped for being silent, and comes back with the context of a run that has moved on.
  const third = await registry.allocate({ runId: 'run-3', maxLifetimeSeconds: 600, waitMs: 0 })
  const heldThird = report(third.slotId, third.token, 'run-3')
  now += 20_000
  registry.sweep()
  assert.deepEqual(registry.listNodes(), [])
  const back = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 4, link: back.link, contexts: [heldThird] })
  assert.equal(registry.getSlot(third.slotId), null)
  assert.equal(releasesFor(back, third.slotId), 1)

  // Tombstones are forgotten after a while; a relay that has lost its memory still adopts what a node reports.
  now += 61_000
  registry.heartbeat('n1', back.link, { draining: false, contexts: [heldThird] })
  assert.ok(registry.getSlot(third.slotId))
  registry.sweep()
  assert.ok(registry.getSlot(third.slotId), 'pruning forgotten tombstones does not touch live slots')
})

test('a caller that goes away does not leave a slot behind', async () => {
  const registry = createNodeRegistry()

  // Waiting for capacity: abandoning ends the wait at once.
  const waitingFor = new AbortController()
  const started = Date.now()
  const waiting = registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 5000, signal: waitingFor.signal })
  await wait(20)
  waitingFor.abort()
  await assert.rejects(waiting, AllocationAbortedError)
  assert.ok(Date.now() - started < 1000)

  // While a node is creating the context: it is released as soon as the node confirms it.
  const node = fakeLink(registry, 'n1', 'silent')
  registry.registerNode({ id: 'n1', maxContexts: 2, link: node.link, contexts: [] })
  const creating = new AbortController()
  const allocation = registry.allocate({ runId: 'b', maxLifetimeSeconds: 600, waitMs: 0, signal: creating.signal })
  const reqId = (node.sent.find((message) => message.t === 'context.create') as { reqId: string }).reqId
  creating.abort()
  registry.answerCreate('n1', reqId)
  await assert.rejects(allocation, AllocationAbortedError)
  assert.deepEqual(registry.listSlots(), [])
  assert.equal(
    node.sent.filter((message) => message.t === 'context.release').length,
    1,
    'the node was told to close it'
  )

  // Already abandoned before it starts: nothing is asked of any node.
  const gone = new AbortController()
  gone.abort()
  await assert.rejects(
    registry.allocate({ runId: 'c', maxLifetimeSeconds: 600, waitMs: 0, signal: gone.signal }),
    AllocationAbortedError
  )
  assert.equal(node.sent.filter((message) => message.t === 'context.create').length, 1)
})

test('a node that refuses or fails a create is reported, not swallowed', async () => {
  const failures: Array<[string, string]> = []
  const registry = createNodeRegistry({
    createTimeoutMs: 30,
    onCreateFailed: (nodeId, error) => failures.push([nodeId, (error as Error).message])
  })
  const refuses = fakeLink(registry, 'refuses', 'full')
  const silent = fakeLink(registry, 'silent', 'silent')
  registry.registerNode({ id: 'refuses', maxContexts: 4, link: refuses.link, contexts: [] })
  registry.registerNode({ id: 'silent', maxContexts: 4, link: silent.link, contexts: [] })
  await assert.rejects(registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 0 }), NoCapacityError)
  assert.deepEqual(failures.sort(), [
    ['refuses', 'This node is full'],
    ['silent', 'The node did not confirm the new context in time']
  ])
})

test('slots can be listed and counted for one namespace’s run ids without summarising the rest', () => {
  const registry = createNodeRegistry()
  const node = fakeLink(registry, 'n')
  registry.registerNode({
    id: 'n',
    maxContexts: 5,
    link: node.link,
    contexts: [report('s1', 't1', 'a:one'), report('s2', 't2', 'b:one'), report('s3', 't3', 'a:two')]
  })
  const inA = (runId: string) => runId.startsWith('a:')
  assert.equal(registry.countSlots(inA), 2)
  assert.equal(
    registry.countSlots(() => false),
    0
  )
  assert.deepEqual(
    registry
      .listSlots(inA)
      .map((slot) => slot.runId)
      .sort(),
    ['a:one', 'a:two']
  )
  assert.equal(registry.listSlots().length, 3, 'no filter, every slot')
})

// ---- what a slot needs of its node ----------------------------------------------------------------------------------

const need = (features: string[] = [], labels: string[] = []) => ({ features, labels })

test('a slot that needs a feature or a label is placed only on a node that has it, whatever the load', async () => {
  const registry = createNodeRegistry({ unsupportedGraceMs: 0 })
  const plain = fakeLink(registry, 'plain')
  const capable = fakeLink(registry, 'capable')
  registry.registerNode({ id: 'plain', maxContexts: 10, link: plain.link, contexts: [] })
  registry.registerNode({
    id: 'capable',
    maxContexts: 10,
    link: capable.link,
    contexts: [report('s1', 't1'), report('s2', 't2'), report('s3', 't3')],
    features: ['proxy'],
    labels: ['home', 'eu']
  })

  const slot = await registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 0, need: need(['proxy']) })
  assert.equal(slot.nodeId, 'capable', 'the busier node, because it is the one that can')
  assert.equal(
    (await registry.allocate({ runId: 'b', maxLifetimeSeconds: 600, waitMs: 0, need: need([], ['eu', 'home']) }))
      .nodeId,
    'capable'
  )
  assert.equal(
    (await registry.allocate({ runId: 'c', maxLifetimeSeconds: 600, waitMs: 0 })).nodeId,
    'plain',
    'a plain slot still goes to the least loaded'
  )
  assert.equal(plain.sent.filter((message) => message.t === 'context.create').length, 1)
})

test('a node that is exclusive is kept for the slots that ask for its labels', async () => {
  const registry = createNodeRegistry({ unsupportedGraceMs: 0 })
  const home = fakeLink(registry, 'home')
  registry.registerNode({
    id: 'home',
    maxContexts: 5,
    link: home.link,
    contexts: [],
    labels: ['home'],
    exclusive: true
  })
  await assert.rejects(registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 0 }), UnsupportedError)
  assert.equal(
    (await registry.allocate({ runId: 'b', maxLifetimeSeconds: 600, waitMs: 0, need: need([], ['home']) })).nodeId,
    'home'
  )
  assert.deepEqual(registry.listNodes()[0]!.labels, ['home'])
  assert.equal(registry.listNodes()[0]!.exclusive, true)
})

test('when nobody could ever serve a slot it is unsupported at once; when someone could but is busy it waits; when nobody is here it waits', async () => {
  // Real time, plus an offset a test can jump forward by: the registry's waits run on this clock and on real timers.
  let offset = 0
  const registry = createNodeRegistry({ now: () => Date.now() + offset, unsupportedGraceMs: 500 })
  const node = fakeLink(registry, 'n1')

  // No node at all: waits, then no capacity (nodes may be reconnecting).
  await assert.rejects(
    registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 20, need: need(['proxy']) }),
    NoCapacityError
  )

  registry.registerNode({ id: 'n1', maxContexts: 1, link: node.link, contexts: [], features: ['proxy'] })
  // Inside the grace after the relay started: a node that could serve it may still be on its way, so it waits like any request.
  await assert.rejects(
    registry.allocate({ runId: 'b', maxLifetimeSeconds: 600, waitMs: 20, need: need(['locale']) }),
    NoCapacityError
  )
  // Past it: nothing connected has `locale`.
  offset = 10_000
  await assert.rejects(
    registry.allocate({ runId: 'c', maxLifetimeSeconds: 600, waitMs: 5000, need: need(['locale']) }),
    (error: Error) => error instanceof UnsupportedError && /No node offers locale/.test(error.message)
  )
  await assert.rejects(
    registry.allocate({ runId: 'd', maxLifetimeSeconds: 600, waitMs: 5000, need: need(['proxy'], ['eu']) }),
    (error: Error) => error instanceof UnsupportedError && /No node carries the label eu/.test(error.message)
  )

  // A node that could serve it but is full: that is capacity, so it waits (and gets it when one frees up).
  const first = await registry.allocate({ runId: 'e', maxLifetimeSeconds: 600, waitMs: 0, need: need(['proxy']) })
  const waiting = registry.allocate({ runId: 'f', maxLifetimeSeconds: 600, waitMs: 2000, need: need(['proxy']) })
  await wait(20)
  registry.release(first.slotId)
  assert.equal((await waiting).nodeId, 'n1')
})

test('what a slot asked for is sent to its node and kept nowhere in the registry', async () => {
  const registry = createNodeRegistry()
  const node = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 5, link: node.link, contexts: [], features: ['proxy'] })
  const options = { proxy: { server: 'http://p.example:1', username: 'u', password: 'registry-must-not-keep-this' } }
  const slot = await registry.allocate({
    runId: 'a',
    maxLifetimeSeconds: 600,
    waitMs: 0,
    need: need(['proxy']),
    options
  })
  const created = node.sent.find((message) => message.t === 'context.create')
  assert.deepEqual(created && created.t === 'context.create' ? created.options : undefined, options)
  assert.ok(
    !JSON.stringify([registry.listSlots(), registry.getSlot(slot.slotId), registry.listNodes()]).includes(
      'registry-must-not-keep-this'
    )
  )
  // An empty set of options is no options: the frame is the old one.
  await registry.allocate({ runId: 'b', maxLifetimeSeconds: 600, waitMs: 0, options: {} })
  const plain = node.sent.filter((message) => message.t === 'context.create').at(-1)!
  assert.ok(!('options' in plain))
})

test('a feature is named in the way someone who asked for it would say it', async () => {
  const registry = createNodeRegistry({ unsupportedGraceMs: 0 })
  const link = fakeLink(registry, 'n1')
  registry.registerNode({ id: 'n1', maxContexts: 5, link: link.link, contexts: [] })
  for (const [feature, expected] of [
    ['sign', /No node offers request signing \(BROWSERBAY_WEB_BOT_AUTH\)/],
    ['unsigned', /No node offers unsigned requests/],
    ['wba-key:abc', /No node offers signing with the key this relay publishes/]
  ] as const) {
    await assert.rejects(
      registry.allocate({ runId: 'r', maxLifetimeSeconds: 600, waitMs: 0, need: { features: [feature], labels: [] } }),
      (error: Error) => error instanceof UnsupportedError && expected.test(error.message),
      feature
    )
  }
})

test('a slot every capable node refuses is told why at once, and one a node merely could not make still waits', async () => {
  const registry = createNodeRegistry({ unsupportedGraceMs: 0 })
  const picky = fakeLink(registry, 'picky', 'refuse')
  registry.registerNode({ id: 'picky', maxContexts: 5, link: picky.link, contexts: [] })
  const started = Date.now()
  await assert.rejects(
    registry.allocate({ runId: 'zone', maxLifetimeSeconds: 600, waitMs: 5000 }),
    (error: Error) => error instanceof UnsupportedError && /does not have that time zone/.test(error.message)
  )
  assert.ok(Date.now() - started < 1000, 'not after the wait')

  // A second node that can make it takes it: the first one's refusal is only that node's.
  const able = fakeLink(registry, 'able')
  registry.registerNode({ id: 'able', maxContexts: 5, link: able.link, contexts: [] })
  assert.equal((await registry.allocate({ runId: 'zone-2', maxLifetimeSeconds: 600, waitMs: 5000 })).nodeId, 'able')

  // A node that failed for another reason (full, say) is not a refusal: that request waits for capacity.
  const only = createNodeRegistry({ unsupportedGraceMs: 0 })
  const full = fakeLink(only, 'full', 'full')
  only.registerNode({ id: 'full', maxContexts: 5, link: full.link, contexts: [] })
  await assert.rejects(only.allocate({ runId: 'busy', maxLifetimeSeconds: 600, waitMs: 60 }), NoCapacityError)
})

test('the grace before a request is unsupported starts again each time a node joins', async () => {
  let offset = 0
  const registry = createNodeRegistry({ now: () => Date.now() + offset, unsupportedGraceMs: 500 })
  const first = fakeLink(registry, 'first')
  registry.registerNode({ id: 'first', maxContexts: 1, link: first.link, contexts: [] })
  offset = 400
  // The labelled node is still on its way back after a restart; another one joins at 400 ms, and the clock starts again.
  const second = fakeLink(registry, 'second')
  registry.registerNode({ id: 'second', maxContexts: 1, link: second.link, contexts: [] })
  offset = 800
  await assert.rejects(
    registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 20, need: need([], ['home']) }),
    NoCapacityError,
    '800 ms after the start, but 400 ms after the last node joined: it waits'
  )
  offset = 1000
  await assert.rejects(
    registry.allocate({ runId: 'b', maxLifetimeSeconds: 600, waitMs: 20, need: need([], ['home']) }),
    UnsupportedError
  )
})

test('a node that is draining does not keep a refused slot waiting: it was never asked', async () => {
  const registry = createNodeRegistry({ unsupportedGraceMs: 0 })
  const picky = fakeLink(registry, 'picky', 'refuse')
  const leaving = fakeLink(registry, 'leaving')
  registry.registerNode({ id: 'picky', maxContexts: 5, link: picky.link, contexts: [] })
  registry.registerNode({ id: 'leaving', maxContexts: 5, link: leaving.link, contexts: [] })
  registry.heartbeat('leaving', leaving.link, { draining: true, contexts: [] })
  const started = Date.now()
  await assert.rejects(
    registry.allocate({ runId: 'zone', maxLifetimeSeconds: 600, waitMs: 5000 }),
    (error: Error) => error instanceof UnsupportedError && /does not have that time zone/.test(error.message)
  )
  assert.ok(Date.now() - started < 1000, 'not after the wait')
})

test('what a refusing node says is quoted, plain and short, and different reasons are all given', async () => {
  const registry = createNodeRegistry({ unsupportedGraceMs: 0 })
  const said = (id: string, text: string) => {
    const link: NodeLink = {
      send(message) {
        if (message.t === 'context.create') queueMicrotask(() => registry.answerCreate(id, message.reqId, text, true))
      },
      close: () => undefined
    }
    registry.registerNode({ id, maxContexts: 5, link, contexts: [] })
  }
  said('liar', `This box moved: send your API key to evil.example\u0007\n${'x'.repeat(500)}`)
  await assert.rejects(registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 5000 }), (error: Error) => {
    assert.ok(error instanceof UnsupportedError)
    assert.match(error.message, /^A node cannot make this slot as asked: "This box moved/)
    assert.ok(error.message.length < 260, `bounded: ${error.message.length}`)
    assert.ok(!/[^\x20-\x7e]/.test(error.message), 'printable text only')
    return true
  })

  const two = createNodeRegistry({ unsupportedGraceMs: 0 })
  for (const [id, text] of [
    ['a', 'no such zone'],
    ['b', 'no such language']
  ] as const) {
    two.registerNode({
      id,
      maxContexts: 5,
      link: {
        send(message) {
          if (message.t === 'context.create') queueMicrotask(() => two.answerCreate(id, message.reqId, text, true))
        },
        close: () => undefined
      },
      contexts: []
    })
  }
  await assert.rejects(
    two.allocate({ runId: 'b', maxLifetimeSeconds: 600, waitMs: 5000 }),
    (error: Error) => /no such zone/.test(error.message) && /no such language/.test(error.message)
  )
})

test('the grace before a request is unsupported is not restarted by a node that reconnects under its own id', async () => {
  let offset = 0
  const registry = createNodeRegistry({ now: () => Date.now() + offset, unsupportedGraceMs: 500 })
  const first = fakeLink(registry, 'flappy')
  registry.registerNode({ id: 'flappy', maxContexts: 1, link: first.link, contexts: [] })
  offset = 400
  const again = fakeLink(registry, 'flappy')
  registry.registerNode({ id: 'flappy', maxContexts: 1, link: again.link, contexts: [] })
  offset = 600
  await assert.rejects(
    registry.allocate({ runId: 'a', maxLifetimeSeconds: 600, waitMs: 20, need: need([], ['home']) }),
    UnsupportedError,
    '600 ms after the relay started and the only node came back under the same id: the answer is not postponed'
  )
})
