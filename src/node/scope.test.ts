import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeChromium, type FakeChromium } from './fake-chromium.js'
import { createCdpScope, type CdpScope } from './scope.js'

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }

/** A message from the hub to a client: an answer or an event, whose shape each test looks into. */
type Message = Record<string, any>
type World = Awaited<ReturnType<typeof setup>>

/** A hub in front of a fake Chromium that already has its own default-context page, as a real one does. */
async function setup({ dedicated = false } = {}) {
  const fake = createFakeChromium()
  const defaultPage = fake.createTarget({ url: 'about:blank' })
  const warnings: string[] = []
  const scope = createCdpScope({
    upstream: { send: fake.receive },
    logger: { warn: (message) => warnings.push(message) },
    dedicated
  })
  fake.onMessage(scope.onUpstreamMessage)
  await scope.start()
  await fake.flush()
  return { fake, scope, warnings, defaultPage }
}

/** A client of one run. `call` sends a command and returns its answer once everything it set off has settled. */
function connect(scope: CdpScope, fake: FakeChromium, runKey: string) {
  const inbox: Message[] = []
  const closes: { code?: number; reason?: string }[] = []
  const client = scope.connect(runKey, {
    send: (text) => inbox.push(JSON.parse(text)),
    close: (code, reason) => closes.push({ code, reason })
  })
  let nextId = 1
  return {
    client,
    inbox,
    closes,
    async call(method: string, params: Record<string, any> = {}, sessionId?: string) {
      const id = nextId++
      client.handleMessage(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      await fake.flush()
      const answer = inbox.find((message) => message.id === id)
      assert.ok(answer, `${method} was answered`)
      return answer
    },
    events: (method: string) => inbox.filter((message) => message.method === method),
    attachedSessions: () => inbox.filter((m) => m.method === 'Target.attachedToTarget').map((m) => m.params.sessionId)
  }
}

/** A run with a connected client that has asked to be attached to everything in its context. */
async function controller(world: World, runKey: string) {
  const { contextId } = await world.scope.createRun(runKey)
  const client = connect(world.scope, world.fake, runKey)
  return { contextId, client, attach: () => client.call('Target.setAutoAttach', AUTO_ATTACH) }
}

test('start takes over auto-attach and lets go of the browser’s own default-context page', async () => {
  const { fake } = await setup()
  assert.deepEqual(fake.commands('Target.setAutoAttach')[0].params, AUTO_ATTACH)
  assert.equal(fake.sessions.size, 0, 'the sweep session on the default page is detached, not kept')
})

test('a run’s context is created so it outlives the client that connected to it', async () => {
  const { fake, scope } = await setup()
  await scope.createRun('a')
  assert.equal(fake.commands('Target.createBrowserContext')[0]?.params?.disposeOnDetach, false)
  await assert.rejects(scope.createRun('a'))
})

test('auto-attach announces the context’s existing tabs, unpaused, before it answers, and never twice', async () => {
  const world = await setup()
  const { fake } = world
  const a = await controller(world, 'a')
  const other = await controller(world, 'b')
  const mine = [
    fake.createTarget({ browserContextId: a.contextId, url: 'https://a/1' }),
    fake.createTarget({ browserContextId: a.contextId, url: 'https://a/2' })
  ]
  fake.createTarget({ browserContextId: other.contextId, url: 'https://b/1' })
  await fake.flush()

  await a.attach()
  const events = a.client.events('Target.attachedToTarget')
  assert.deepEqual(events.map((event) => event.params.targetInfo.targetId).sort(), [...mine].sort())
  assert.ok(events.every((event) => event.params.waitingForDebugger === false))
  assert.ok(events.every((event) => event.params.targetInfo.browserContextId === a.contextId))
  const answerAt = a.client.inbox.findIndex((message) => message.id === 1)
  assert.ok(a.client.inbox.slice(0, answerAt).filter((m) => m.method === 'Target.attachedToTarget').length === 2)

  await a.attach()
  assert.equal(a.client.events('Target.attachedToTarget').length, 2, 'a second request does not duplicate a tab')
})

test('a new tab is created in the run’s context, announced paused before the answer, and held until resumed', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  await a.attach()

  const created = await a.client.call('Target.createTarget', { url: 'about:blank' })
  const { targetId } = created.result
  assert.equal(world.fake.targets.get(targetId)?.browserContextId, a.contextId, 'the context was filled in')
  const announced = a.client
    .events('Target.attachedToTarget')
    .find((event) => event.params.targetInfo.targetId === targetId)
  assert.ok(announced, 'the new tab was announced')
  assert.equal(announced.params.waitingForDebugger, true)
  assert.ok(a.client.inbox.indexOf(announced) < a.client.inbox.indexOf(created), 'announced before the answer')
  assert.equal(world.fake.isPaused(targetId), true, 'still paused: the client is not done setting it up')

  await a.client.call('Runtime.runIfWaitingForDebugger', {}, announced.params.sessionId)
  assert.equal(world.fake.isPaused(targetId), false)
})

test('a tab nobody asked for is resumed and released, never left frozen', async () => {
  const world = await setup()
  const { contextId } = await world.scope.createRun('idle')
  const inDefaultContext = world.fake.createTarget()
  const inRunContext = world.fake.createTarget({ browserContextId: contextId })
  await world.fake.flush()
  for (const targetId of [inDefaultContext, inRunContext]) {
    assert.equal(world.fake.isPaused(targetId), false)
    assert.deepEqual(world.fake.sessionsOf(targetId), [])
  }
})

test('one run never receives another’s tabs, targets or session events', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  const b = await controller(world, 'b')
  world.fake.createTarget({ browserContextId: a.contextId })
  world.fake.createTarget({ browserContextId: b.contextId })
  await world.fake.flush()
  await a.attach()
  await b.attach()

  assert.equal(a.client.attachedSessions().length, 1)
  assert.equal(b.client.attachedSessions().length, 1)
  const listed = (await a.client.call('Target.getTargets')).result.targetInfos
  assert.ok(listed.length === 1 && listed.every((info: Message) => info.browserContextId === a.contextId))
  assert.deepEqual((await a.client.call('Target.getBrowserContexts')).result, { browserContextIds: [a.contextId] })

  world.fake.emitSessionEvent(a.client.attachedSessions()[0], 'Page.screencastFrame', { data: 'frame' })
  await world.fake.flush()
  assert.equal(a.client.events('Page.screencastFrame').length, 1)
  assert.equal(b.client.events('Page.screencastFrame').length, 0)
})

test('commands with no context act on the run’s own, not the browser’s default profile', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  const b = await controller(world, 'b')
  await a.client.call('Storage.setCookies', { cookies: [{ name: 'k', value: 'a' }] })
  assert.deepEqual(world.fake.cookies(a.contextId), [{ name: 'k', value: 'a' }])
  assert.deepEqual(world.fake.cookies(), [], 'the default profile is untouched')
  assert.deepEqual((await b.client.call('Storage.getCookies')).result.cookies, [])
  assert.equal((await a.client.call('Storage.getCookies')).result.cookies.length, 1)
  await a.client.call('Browser.grantPermissions', { permissions: ['geolocation'] })
  assert.equal(world.fake.commands('Browser.grantPermissions')[0]?.params?.browserContextId, a.contextId)
})

test('downloads are denied for the run’s context, and a client cannot choose where files would go', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  await a.client.call('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: '/tmp/x',
    eventsEnabled: true
  })
  // The run's own context was already denied downloads when it was made; this is the client's call being rewritten.
  const denied = { behavior: 'deny', eventsEnabled: false, browserContextId: a.contextId }
  assert.deepEqual(
    world.fake.commands('Browser.setDownloadBehavior').map((command) => command.params),
    [denied, denied]
  )
})

test('two creates for the same slot at once make one context, not two with one of them lost', async () => {
  const { fake, scope } = await setup()
  const results = await Promise.allSettled([scope.createRun('same'), scope.createRun('same')])
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected'])
  assert.match(
    String((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason),
    /already has a browser context/
  )
  assert.equal(fake.commands('Target.createBrowserContext').length, 1, 'only one context was made, so none leaks')

  // The slot can still be released and made again afterwards.
  await scope.disposeRun('same')
  await scope.createRun('same')
  assert.equal(fake.commands('Target.createBrowserContext').length, 2)
})

test('a run’s context is denied downloads from the start, without its client having to ask', async () => {
  const { fake, scope } = await setup()
  const { contextId } = await scope.createRun('a')
  assert.deepEqual(
    fake.commands('Browser.setDownloadBehavior').map((command) => command.params),
    [{ behavior: 'deny', eventsEnabled: false, browserContextId: contextId }]
  )
})

/** A run with a page of its own and a session on it, as a client that attached to the tab has. */
async function pageSession(world: World, runKey: string) {
  const run = await controller(world, runKey)
  const targetId = world.fake.createTarget({ browserContextId: run.contextId, url: 'https://a/' })
  await world.fake.flush()
  const { sessionId } = (await run.client.call('Target.attachToTarget', { targetId, flatten: true })).result
  return { ...run, sessionId, targetId }
}

test('a page can be pointed at the web, but not at the node: file:, chrome:, view-source: and friends are refused', async () => {
  const world = await setup()
  const a = await pageSession(world, 'a')

  for (const url of [
    'https://example.com/',
    'http://example.com/path?q=1#x',
    'about:blank',
    'about:srcdoc',
    'data:text/html,<p>hi</p>',
    'blob:https://example.com/0f4e'
  ]) {
    const answer = await a.client.call('Page.navigate', { url }, a.sessionId)
    assert.equal(answer.error, undefined, `${url} is allowed`)
  }
  assert.equal(world.fake.commands('Page.navigate').length, 6, 'and reached the browser')

  for (const url of [
    'file:///etc/passwd',
    'FILE:///proc/1/environ',
    'view-source:file:///etc/hosts',
    'view-source:https://example.com/',
    'chrome://inspect/#pages',
    'chrome://version',
    'devtools://devtools/bundled/inspector.html',
    'about:version',
    'javascript:alert(1)',
    'ftp://example.com/',
    'filesystem:https://example.com/temporary/x',
    'not a url',
    ''
  ]) {
    const answer = await a.client.call('Page.navigate', { url }, a.sessionId)
    assert.equal(answer.error?.code, -32602, `${url || '(empty)'} is refused`)
    assert.match(answer.error.message, /cannot be opened on a shared browser/)
  }
  assert.equal((await a.client.call('Page.navigate', {}, a.sessionId)).error?.code, -32602, 'a missing url is refused')
  assert.equal(world.fake.commands('Page.navigate').length, 6, 'none of the refused ones reached the browser')
  assert.ok(world.warnings.includes('A navigation to a refused URL was blocked'), 'and each is logged')
})

test('a new tab cannot be opened on a refused URL either, and the default tab is still fine', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  await a.attach()

  for (const url of ['file:///etc/passwd', 'chrome://inspect', 'view-source:file:///x', 'about:version']) {
    const answer = await a.client.call('Target.createTarget', { url })
    assert.equal(answer.error?.code, -32602, url)
  }
  assert.equal(world.fake.commands('Target.createTarget').length, 0, 'no tab was made')
  assert.equal((await a.client.call('Target.createTarget', { url: 'about:blank' })).error, undefined)
  assert.equal((await a.client.call('Target.createTarget', {})).error, undefined, 'no url at all is a blank tab')
  assert.equal((await a.client.call('Target.createTarget', { url: 'https://example.com/' })).error, undefined)
  assert.equal(world.fake.commands('Target.createTarget').length, 3)
})

test('a paused request can be rewritten to another web address, not to a file', async () => {
  const world = await setup()
  const a = await pageSession(world, 'a')
  const pass = (params: Record<string, any>) =>
    a.client.call('Fetch.continueRequest', { requestId: 'r', ...params }, a.sessionId)

  assert.equal((await pass({})).error, undefined, 'continuing as it is')
  assert.equal((await pass({ url: 'https://example.com/other' })).error, undefined)
  assert.equal((await pass({ url: 'file:///etc/passwd' })).error?.code, -32602)
  assert.equal((await pass({ url: 'chrome://version' })).error?.code, -32602)
  assert.equal(world.fake.commands('Fetch.continueRequest').length, 2)
})

test('a client cannot have the browser read a file path for it, or choose where a download goes', async () => {
  const world = await setup()
  const a = await pageSession(world, 'a')
  const refused = async (method: string, params: Record<string, any>) => {
    const answer = await a.client.call(method, params, a.sessionId)
    assert.equal(answer.error?.code, -32601, method)
    assert.match(answer.error.message, /not available on a shared browser/)
  }

  // A path in the browser's file system read into the page (Playwright uploads from a remote client as buffers).
  await refused('DOM.setFileInputFiles', { files: ['/proc/1/environ'], objectId: 'x' })
  await refused('DOM.setFileInputFiles', { files: [], objectId: 'x' })
  await refused('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' })
  // A drag of a file from the machine into the page.
  await refused('Input.dispatchDragEvent', { type: 'drop', x: 1, y: 1, data: { items: [], files: ['/etc/passwd'] } })

  // A drag of what is on the page is ordinary input.
  const ok = await a.client.call(
    'Input.dispatchDragEvent',
    { type: 'drop', x: 1, y: 1, data: { items: [] } },
    a.sessionId
  )
  assert.equal(ok.error, undefined)
  assert.equal(world.fake.commands('DOM.setFileInputFiles').length, 0)
  assert.equal(world.fake.commands('Page.setDownloadBehavior').length, 0)
})

test('Target.createTarget passes only what a page needs, and only into the run’s own context', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  const b = await controller(world, 'b')
  await a.client.call('Target.createTarget', { url: 'https://a/', enableBeginFrameControl: true, forTab: true })
  assert.deepEqual(world.fake.commands('Target.createTarget').at(-1)?.params, {
    url: 'https://a/',
    browserContextId: a.contextId
  })
  const refused = await a.client.call('Target.createTarget', { url: 'about:blank', browserContextId: b.contextId })
  assert.equal(refused.error.code, -32602)
})

test('another run’s browser cannot be reached, and says nothing about what exists', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  const b = await controller(world, 'b')
  const theirs = world.fake.createTarget({ browserContextId: b.contextId })
  await world.fake.flush()
  await b.attach()
  const theirSession = b.client.attachedSessions()[0]
  await a.attach()
  const mine = (await a.client.call('Target.createTarget', { url: 'about:blank' })).result.targetId

  const message = async (method: string, params: Record<string, any>, sessionId?: string) => {
    const answer = await a.client.call(method, params, sessionId)
    assert.ok(answer.error, `${method} was refused`)
    return answer.error.message
  }
  const nothing = await message('Target.attachToTarget', { targetId: 'no-such-target', flatten: true })
  for (const method of [
    'Target.attachToTarget',
    'Target.closeTarget',
    'Target.activateTarget',
    'Target.getTargetInfo'
  ]) {
    assert.equal(await message(method, { targetId: theirs, flatten: true }), nothing, method)
  }
  assert.ok(world.fake.targets.has(theirs), 'their tab is still open')

  const withTheirContext: [string, Record<string, any>][] = [
    ['Storage.getCookies', { browserContextId: b.contextId }],
    ['Storage.clearCookies', { browserContextId: b.contextId }],
    ['Browser.grantPermissions', { permissions: [], browserContextId: b.contextId }],
    ['Browser.resetPermissions', { browserContextId: b.contextId }]
  ]
  for (const [method, params] of withTheirContext) {
    await message(method, params)
  }
  for (const method of ['Browser.close', 'Browser.crash', 'SystemInfo.getInfo', 'Target.attachToBrowserTarget']) {
    await message(method, {})
  }
  await message('Target.createBrowserContext', {})
  await message('Target.disposeBrowserContext', { browserContextId: b.contextId })
  await message('Target.detachFromTarget', { sessionId: theirSession })
  assert.equal(world.fake.wasClosed(), false, 'the browser was not closed')
  assert.equal((await a.client.call('Browser.getVersion')).result.product, 'FakeChrome/1', 'the connection survives')

  const foreign = await a.client.call('Page.enable', {}, theirSession)
  assert.equal(foreign.error.code, -32001)
  assert.equal(foreign.error.message, 'Session with given id not found.')
  assert.equal(foreign.sessionId, theirSession)
  assert.ok(mine, 'and its own browser still works')
  assert.ok(world.warnings.length > 0, 'the refusals were logged')
})

test('a page session is fenced: page commands pass, browser-wide ones do not', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  const b = await controller(world, 'b')
  world.fake.createTarget({ browserContextId: a.contextId })
  await world.fake.flush()
  await a.attach()
  const session = a.client.attachedSessions()[0]

  for (const method of [
    'Page.enable',
    'Runtime.evaluate',
    'Fetch.enable',
    'Input.dispatchMouseEvent',
    'Target.setAutoAttach'
  ]) {
    assert.ok((await a.client.call(method, { x: 1 }, session)).result, `${method} passes`)
  }
  assert.deepEqual((await a.client.call('Runtime.evaluate', { expression: '1+1' }, session)).result.params, {
    expression: '1+1'
  })
  for (const method of [
    'Storage.getCookies',
    'Tracing.start',
    'SystemInfo.getInfo',
    'Memory.getDOMCounters',
    'Browser.close',
    'Browser.grantPermissions',
    'Target.closeTarget',
    'Target.attachToTarget',
    'Target.sendMessageToTarget',
    'IO.read',
    'IO.close',
    'IO.resolveBlob'
  ]) {
    assert.equal((await a.client.call(method, {}, session)).error.code, -32601, `${method} is refused`)
  }
  assert.ok((await a.client.call('Browser.getWindowForTarget', {}, session)).result, 'window bounds are allowed')
  assert.ok((await a.client.call('Browser.getWindowBounds', { windowId: 1 }, session)).result)
  const crossContext = await a.client.call('Network.enable', { browserContextId: b.contextId }, session)
  assert.equal(crossContext.error.code, -32602, 'a foreign context named in a page command is refused')
  const foreignWindow = await a.client.call('Browser.getWindowForTarget', { targetId: 'target-x' }, session)
  assert.equal(foreignWindow.error.code, -32602)
})

test('a client leaving frees what it held but leaves the run’s tabs for the next client', async () => {
  const world = await setup()
  const { fake } = world
  const a = await controller(world, 'a')
  const existing = fake.createTarget({ browserContextId: a.contextId, url: 'https://a/existing' })
  await fake.flush()
  await a.attach()
  const fresh = (await a.client.call('Target.createTarget', { url: 'https://a/fresh' })).result.targetId
  const interceptor = (await a.client.call('Target.attachToTarget', { targetId: existing, flatten: true })).result
    .sessionId
  await a.client.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, interceptor)
  assert.equal(fake.isPaused(fresh), true)
  assert.equal(fake.sessions.size, 3)

  a.client.client.close()
  await fake.flush()
  assert.equal(fake.isPaused(fresh), false, 'a tab still paused for the leaver is resumed')
  assert.equal(fake.sessions.size, 0, 'every session it held is detached, so interception goes with it')
  assert.ok(fake.targets.has(existing) && fake.targets.has(fresh), 'the tabs stay open')
  assert.ok(fake.contexts.has(a.contextId), 'and so does the context')

  const next = connect(world.scope, fake, 'a')
  await next.call('Target.setAutoAttach', AUTO_ATTACH)
  assert.deepEqual(
    next
      .events('Target.attachedToTarget')
      .map((event) => event.params.targetInfo.targetId)
      .sort(),
    [existing, fresh].sort(),
    'the next client sees the same tabs'
  )
})

test('a popup is handed over paused when a client is attached, and released when none is', async () => {
  const world = await setup()
  const { fake } = world
  const a = await controller(world, 'a')
  fake.createTarget({ browserContextId: a.contextId })
  await fake.flush()
  await a.attach()
  const opener = a.client.attachedSessions()[0]
  const openerTarget = fake.sessions.get(opener)?.targetId

  const popup = fake.openPopup(opener)
  await fake.flush()
  const announced = a.client
    .events('Target.attachedToTarget')
    .find((event) => event.params.targetInfo.targetId === popup)
  assert.ok(announced, 'the popup was announced')
  assert.equal(announced.params.waitingForDebugger, true)
  assert.equal(announced.params.targetInfo.openerId, fake.sessions.get(opener)?.targetId)
  assert.equal(fake.isPaused(popup), true, 'held until the client has armed its routing')

  a.client.client.close()
  await fake.flush()
  const orphan = fake.createTarget({ browserContextId: a.contextId, openerId: openerTarget })
  await fake.flush()
  assert.equal(fake.sessions.size, 0)
  assert.equal(fake.isPaused(orphan), false, 'with nobody attached it is not left frozen')
})

test('a newer attaching client takes over, and the older one is closed and released', async () => {
  const world = await setup()
  const { fake } = world
  const a = await controller(world, 'a')
  fake.createTarget({ browserContextId: a.contextId })
  await fake.flush()
  await a.attach()
  assert.equal(fake.sessions.size, 1)

  const newer = connect(world.scope, fake, 'a')
  await newer.call('Target.setAutoAttach', AUTO_ATTACH)
  assert.deepEqual(a.client.closes, [{ code: 4000, reason: 'Superseded by a newer connection' }])
  assert.equal(newer.attachedSessions().length, 1)
  assert.equal(fake.sessions.size, 1, 'only the newer client’s session is left')

  // A client that never asked for auto-attach (the live view) does not displace the controller.
  const viewer = connect(world.scope, fake, 'a')
  await viewer.call('Target.getTargets')
  assert.deepEqual(newer.closes, [])
})

test('frames and workers attached under a client’s page belong to that client alone', async () => {
  const world = await setup()
  const { fake } = world
  const a = await controller(world, 'a')
  const b = await controller(world, 'b')
  fake.createTarget({ browserContextId: a.contextId })
  fake.createTarget({ browserContextId: b.contextId })
  await fake.flush()
  await a.attach()
  await b.attach()
  const page = a.client.attachedSessions()[0]
  await a.client.call('Target.setAutoAttach', AUTO_ATTACH, page)

  const frame = fake.addChildSession(page)
  await fake.flush()
  const announced = a.client.inbox.find((m) => m.method === 'Target.attachedToTarget' && m.params.sessionId === frame)
  assert.ok(announced, 'the frame was announced')
  assert.equal(announced.sessionId, page, 'announced on the parent session, as Chromium does')
  assert.equal(
    b.client.inbox.some((m) => m.params?.sessionId === frame),
    false
  )

  assert.ok((await a.client.call('Runtime.runIfWaitingForDebugger', {}, frame)).result)
  assert.equal((await b.client.call('Page.enable', {}, frame)).error.code, -32001)

  await a.client.call('Target.detachFromTarget', { sessionId: page })
  assert.equal((await a.client.call('Page.enable', {}, frame)).error.code, -32001, 'children go with their parent')
})

test('target discovery is limited to the run’s context', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  const b = await controller(world, 'b')
  const mine = world.fake.createTarget({ browserContextId: a.contextId })
  world.fake.createTarget({ browserContextId: b.contextId })
  await world.fake.flush()

  await a.client.call('Target.setDiscoverTargets', { discover: true })
  assert.deepEqual(
    a.client.events('Target.targetCreated').map((e) => e.params.targetInfo.targetId),
    [mine]
  )
  world.fake.createTarget({ browserContextId: b.contextId })
  const later = world.fake.createTarget({ browserContextId: a.contextId })
  await world.fake.flush()
  assert.deepEqual(
    a.client.events('Target.targetCreated').map((e) => e.params.targetInfo.targetId),
    [mine, later]
  )
  assert.equal(b.client.events('Target.targetCreated').length, 0, 'a client that did not ask hears nothing')
})

test('ending a run closes its clients and disposes its context', async () => {
  const world = await setup()
  const { fake, scope } = world
  const a = await controller(world, 'a')
  fake.createTarget({ browserContextId: a.contextId })
  await fake.flush()
  await a.attach()

  await scope.disposeRun('a')
  assert.deepEqual(a.client.closes, [{ code: 4001, reason: 'The slot was released' }])
  assert.equal(fake.contexts.has(a.contextId), false)
  assert.equal(
    [...fake.targets.values()].some((target) => target.browserContextId === a.contextId),
    false
  )
  assert.equal(scope.hasRun('a'), false)
  assert.throws(() => scope.connect('a', { send() {} }))
  await scope.disposeRun('a')
})

test('losing the browser closes every client with a code that says so', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  const b = await controller(world, 'b')
  world.scope.onUpstreamClosed()
  assert.equal(a.client.closes[0].code, 1011)
  assert.equal(b.client.closes[0].code, 1011)
  assert.deepEqual(world.scope.runKeys(), [])
  await assert.rejects(world.scope.createRun('c'))
})

test('malformed messages are ignored, and an unknown run cannot connect', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  for (const text of [
    'not json',
    '{"id":"x","method":1}',
    '{"id":9}',
    '{"method":"Browser.getVersion"}',
    '[]',
    'null'
  ]) {
    a.client.client.handleMessage(text)
  }
  await world.fake.flush()
  assert.deepEqual(a.client.inbox, [])
  assert.throws(() => world.scope.connect('nope', { send() {} }))
})

test('a page session may only use the windows it was given', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  const b = await controller(world, 'b')
  world.fake.createTarget({ browserContextId: a.contextId })
  world.fake.createTarget({ browserContextId: b.contextId })
  await world.fake.flush()
  await a.attach()
  await b.attach()
  const sessionA = a.client.attachedSessions()[0]
  const sessionB = b.client.attachedSessions()[0]

  // Window ids are browser-wide integers: knowing (or guessing) another run's is not enough.
  assert.equal((await a.client.call('Browser.getWindowBounds', { windowId: 1 }, sessionA)).error.code, -32602)
  const mine = (await a.client.call('Browser.getWindowForTarget', {}, sessionA)).result.windowId
  const theirs = (await b.client.call('Browser.getWindowForTarget', {}, sessionB)).result.windowId
  assert.notEqual(mine, theirs)

  assert.ok((await a.client.call('Browser.getWindowBounds', { windowId: mine }, sessionA)).result)
  assert.ok(
    (await a.client.call('Browser.setWindowBounds', { windowId: mine, bounds: { width: 800 } }, sessionA)).result
  )
  for (const method of ['Browser.getWindowBounds', 'Browser.setWindowBounds']) {
    const refused = await a.client.call(method, { windowId: theirs, bounds: { windowState: 'minimized' } }, sessionA)
    assert.equal(refused.error.code, -32602, method)
    assert.equal(refused.error.message, 'Browser window not found')
  }
  assert.equal(world.fake.commands('Browser.setWindowBounds').length, 1, 'only the run’s own window was touched')
})

test('a browser that stops answering makes requests fail instead of waiting for ever', async () => {
  const scope = createCdpScope({ upstream: { send() {} }, requestTimeoutMs: 20 })
  await assert.rejects(scope.createRun('a'), /did not answer in time/)
  await assert.rejects(scope.start(), /did not answer in time/)
})

test('a session created for a client that left in the meantime is let go', async () => {
  const world = await setup()
  const a = await controller(world, 'a')
  const tab = world.fake.createTarget({ browserContextId: a.contextId })
  await world.fake.flush()

  const viewer = connect(world.scope, world.fake, 'a')
  viewer.client.handleMessage(
    JSON.stringify({ id: 1, method: 'Target.attachToTarget', params: { targetId: tab, flatten: true } })
  )
  viewer.client.close() // gone before Chromium answers
  await world.fake.flush()
  assert.equal(world.fake.sessions.size, 0, 'the session Chromium made for it was detached, not left behind')
})

test('a reply is passed on untouched apart from its id, without being parsed again', async () => {
  const world = await setup()
  await world.scope.createRun('a')
  const raw: string[] = []
  const client = world.scope.connect('a', { send: (text) => raw.push(text) })
  client.handleMessage(JSON.stringify({ id: 7, method: 'Browser.getVersion' }))

  const parse = JSON.parse
  let parses = 0
  JSON.parse = (...args) => {
    parses++
    return parse(...args)
  }
  try {
    await world.fake.flush()
  } finally {
    JSON.parse = parse
  }
  assert.equal(parses, 0, 'a reply nobody has to inspect is not parsed and rebuilt')
  assert.deepEqual(raw, ['{"id":7,"result":{"product":"FakeChrome/1","userAgent":"FakeChrome"}}'])
})

test('a message the hub cannot handle is dropped and logged, not thrown', async () => {
  const world = await setup()
  const { contextId } = await world.scope.createRun('a')
  let broken = false
  const client = world.scope.connect('a', {
    send() {
      if (broken) throw new Error('the socket is gone')
    }
  })
  client.handleMessage(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: AUTO_ATTACH }))
  await world.fake.flush()

  broken = true
  world.fake.createTarget({ browserContextId: contextId }) // announcing it to the client now throws
  await world.fake.flush() // an escaped exception here would end the process
  assert.ok(world.warnings.includes('A message from the browser could not be handled'))
})

// ---- a dedicated browser: one run, so what keeps runs apart is lifted ---------------------------------------------

/** A dedicated browser with its one run, a client attached to it, and a page open. */
async function dedicatedRun() {
  const world = await setup({ dedicated: true })
  const run = await controller(world, 'slot')
  await run.attach()
  const created = await run.client.call('Target.createTarget', { url: 'about:blank' })
  const announced = run.client
    .events('Target.attachedToTarget')
    .find((event) => event.params.targetInfo.targetId === created.result.targetId)!
  await run.client.call('Runtime.runIfWaitingForDebugger', {}, announced.params.sessionId)
  return { ...world, ...run, sessionId: announced.params.sessionId as string }
}

test('dedicated: the browser-wide domains a shared browser refuses are open to the one run', async () => {
  const shared = await setup()
  const sharedRun = await controller(shared, 'slot')
  await sharedRun.attach()
  const sharedPage = await sharedRun.client.call('Target.createTarget', { url: 'about:blank' })
  const sharedSession = sharedRun.client
    .events('Target.attachedToTarget')
    .find((event) => event.params.targetInfo.targetId === sharedPage.result.targetId)!.params.sessionId
  for (const method of [
    'IO.read',
    'Tracing.start',
    'Memory.getDOMCounters',
    'SystemInfo.getInfo',
    'Storage.getUsageAndQuota'
  ]) {
    assert.equal(
      (await sharedRun.client.call(method, {}, sharedSession)).error?.code,
      -32601,
      `${method} on a shared browser`
    )
  }
  assert.equal((await sharedRun.client.call('Tracing.start')).error?.code, -32601, 'browser-level, shared')

  const world = await dedicatedRun()
  for (const method of [
    'IO.read',
    'IO.close',
    'Tracing.start',
    'Memory.getDOMCounters',
    'SystemInfo.getInfo',
    'Storage.getUsageAndQuota'
  ]) {
    const answer = await world.client.call(method, { handle: 'h' }, world.sessionId)
    assert.equal(answer.error, undefined, `${method} on a dedicated browser`)
    assert.equal(answer.result.method, method, 'and it reached the page unchanged')
  }
  assert.equal((await world.client.call('Tracing.start', { transferMode: 'ReturnAsStream' })).error, undefined)
  await world.client.call('Tracing.end')
  assert.equal(world.client.events('Tracing.tracingComplete').length, 1, 'the browser-wide event reaches the client')
  assert.equal(
    (await world.client.call('Browser.close')).error?.code,
    -32601,
    'the browser itself still is not the client’s to close'
  )
})

test('dedicated: the client can make contexts of its own, and they are the run’s', async () => {
  const world = await dedicatedRun()
  const { fake, client } = world
  const first = await client.call('Target.createBrowserContext', {
    disposeOnDetach: true,
    proxyServer: 'http://203.0.113.9:3128',
    originsWithUniversalNetworkAccess: ['https://x'],
    browserContextId: 'ignored',
    other: 1
  })
  const extra = first.result.browserContextId as string
  assert.ok(extra && extra !== world.contextId)
  const sent = fake.commands('Target.createBrowserContext').at(-1)!.params
  assert.deepEqual(
    sent,
    { proxyServer: 'http://203.0.113.9:3128', disposeOnDetach: false },
    'only a proxy passes, and it outlives any connection'
  )
  assert.deepEqual(fake.commands('Browser.setDownloadBehavior').at(-1)?.params, {
    behavior: 'deny',
    eventsEnabled: false,
    browserContextId: extra
  })

  assert.deepEqual(
    (await client.call('Target.getBrowserContexts')).result.browserContextIds.sort(),
    [world.contextId, extra].sort()
  )

  // A tab in it is announced paused, listed, and usable like one in the run’s first context.
  const tab = await client.call('Target.createTarget', { url: 'about:blank', browserContextId: extra })
  assert.equal(fake.targets.get(tab.result.targetId)?.browserContextId, extra)
  const attached = client
    .events('Target.attachedToTarget')
    .find((event) => event.params.targetInfo.targetId === tab.result.targetId)
  assert.equal(attached?.params.waitingForDebugger, true)
  const listed = (await client.call('Target.getTargets')).result.targetInfos.map(
    (info: { targetId: string }) => info.targetId
  )
  assert.ok(listed.includes(tab.result.targetId))
  await client.call('Storage.setCookies', { cookies: [{ name: 'a' }], browserContextId: extra })
  assert.equal(fake.cookies(extra).length, 1)
  assert.equal(fake.cookies(world.contextId).length, 0, 'cookies went to the context that was named')

  // A context that is not the run’s (the browser’s own default, anything else) is still not reachable.
  const foreign = fake.createTarget({ browserContextId: 'foreign' })
  await fake.flush()
  assert.ok(
    !(await client.call('Target.getTargets')).result.targetInfos.some(
      (info: { targetId: string }) => info.targetId === foreign
    )
  )
  assert.equal((await client.call('Target.createTarget', { browserContextId: 'foreign' })).error?.code, -32602)
  assert.equal((await client.call('Target.disposeBrowserContext', { browserContextId: 'foreign' })).error?.code, -32602)
  assert.equal(
    (await client.call('Target.disposeBrowserContext', { browserContextId: fake.DEFAULT_CONTEXT })).error?.code,
    -32602
  )
  assert.equal((await client.call('Storage.getCookies', { browserContextId: 'foreign' })).error?.code, -32602)

  // It can close its extra contexts, never the slot’s own, and releasing the slot disposes them all.
  assert.equal(
    (await client.call('Target.disposeBrowserContext', { browserContextId: world.contextId })).error?.code,
    -32602
  )
  const second = (await client.call('Target.createBrowserContext')).result.browserContextId as string
  assert.equal((await client.call('Target.disposeBrowserContext', { browserContextId: second })).error, undefined)
  assert.ok(!fake.contexts.has(second))
  assert.ok(!(await client.call('Target.getBrowserContexts')).result.browserContextIds.includes(second))
  await world.scope.disposeRun('slot')
  assert.ok(!fake.contexts.has(extra) && !fake.contexts.has(world.contextId), 'every context of the run is disposed')
})

test('shared: a client cannot make or close contexts, only dedicated ones can', async () => {
  const world = await setup()
  const run = await controller(world, 'slot')
  for (const method of ['Target.createBrowserContext', 'Target.disposeBrowserContext']) {
    assert.equal((await run.client.call(method, { browserContextId: run.contextId })).error?.code, -32601, method)
  }
})

test('dedicated: what keeps the node safe stays fenced, because it never depended on who else was on the browser', async () => {
  const world = await dedicatedRun()
  const { client, sessionId } = world
  for (const url of ['file:///etc/passwd', 'chrome://version', 'view-source:https://a', 'about:version']) {
    assert.equal((await client.call('Page.navigate', { url }, sessionId)).error?.code, -32602, url)
    assert.equal((await client.call('Target.createTarget', { url })).error?.code, -32602, url)
  }
  for (const method of ['DOM.setFileInputFiles', 'Page.setDownloadBehavior']) {
    assert.equal((await client.call(method, {}, sessionId)).error?.code, -32601, method)
  }
  const download = await client.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' })
  assert.equal(download.error, undefined)
  assert.deepEqual(world.fake.commands('Browser.setDownloadBehavior').at(-1)?.params, {
    behavior: 'deny',
    eventsEnabled: false,
    browserContextId: world.contextId
  })
})

// ---- a slot's proxy ---------------------------------------------------------------------------------------------------

test('a run made with a proxy has its context made with it, and a plain run with none', async () => {
  const { fake, scope } = await setup()
  await scope.createRun('plain')
  assert.deepEqual(fake.commands('Target.createBrowserContext').at(-1)!.params, { disposeOnDetach: false })
  await scope.createRun('empty', {})
  assert.deepEqual(fake.commands('Target.createBrowserContext').at(-1)!.params, { disposeOnDetach: false })

  await scope.createRun('proxied', { proxyServer: 'socks5://127.5.6.7:4000', proxyBypassList: '<-loopback>;a.test' })
  assert.deepEqual(fake.commands('Target.createBrowserContext').at(-1)!.params, {
    disposeOnDetach: false,
    proxyServer: 'socks5://127.5.6.7:4000',
    proxyBypassList: '<-loopback>;a.test'
  })
  await scope.createRun('no-bypass', { proxyServer: 'socks5://127.5.6.8:4001' })
  assert.deepEqual(fake.commands('Target.createBrowserContext').at(-1)!.params, {
    disposeOnDetach: false,
    proxyServer: 'socks5://127.5.6.8:4001'
  })
})

test('dedicated: a context the client makes starts from the slot’s proxy unless it names its own', async () => {
  const world = await setup({ dedicated: true })
  await world.scope.createRun('slot', { proxyServer: 'socks5://127.5.6.7:4000', proxyBypassList: '<-loopback>;a.test' })
  const client = connect(world.scope, world.fake, 'slot')
  const sent = () => world.fake.commands('Target.createBrowserContext').at(-1)!.params

  await client.call('Target.createBrowserContext')
  assert.deepEqual(sent(), {
    disposeOnDetach: false,
    proxyServer: 'socks5://127.5.6.7:4000',
    proxyBypassList: '<-loopback>;a.test'
  })

  await client.call('Target.createBrowserContext', { proxyServer: 'http://203.0.113.9:3128' })
  assert.deepEqual(
    sent(),
    { disposeOnDetach: false, proxyServer: 'http://203.0.113.9:3128' },
    'its own, with none of the slot’s bypass list'
  )

  await client.call('Target.createBrowserContext', {
    proxyServer: 'http://203.0.113.9:3128',
    proxyBypassList: 'b.test'
  })
  assert.deepEqual(sent(), {
    disposeOnDetach: false,
    proxyServer: 'http://203.0.113.9:3128',
    proxyBypassList: 'b.test'
  })

  // A plain slot's contexts stay plain.
  await world.scope.createRun('plain-slot')
  const plain = connect(world.scope, world.fake, 'plain-slot')
  await plain.call('Target.createBrowserContext')
  assert.deepEqual(sent(), { disposeOnDetach: false })
})

test('dedicated: a client cannot point a context of its own at the node itself, however it writes the address', async () => {
  const world = await setup({ dedicated: true })
  await world.scope.createRun('slot', { proxyServer: 'socks5://127.5.6.7:4000' })
  const client = connect(world.scope, world.fake, 'slot')
  const made = () => world.fake.commands('Target.createBrowserContext').length
  const before = made()

  for (const proxyServer of [
    '127.0.0.1:9',
    'socks5://localhost:1080',
    'http://[::1]:80',
    '0x7f000001:80',
    'socks5://127.5.6.7:4000', // another slot's forwarder is on loopback too
    '203.0.113.9:1,127.1:2',
    'http=203.0.113.9:80;https=localhost:443',
    'http://169.254.169.254:80',
    'http://127.5.6.7.nip.io:4000', // a name: Chromium resolves it, and it can be made to point at another slot's forwarder
    'proxy.example.com:8080',
    5 as never
  ]) {
    const answer = await client.call('Target.createBrowserContext', { proxyServer })
    assert.equal(answer.error?.code, -32602, JSON.stringify(proxyServer))
    assert.match(answer.error?.message, /proxy cannot be used/)
  }
  assert.equal(made(), before, 'none of them reached the browser')
  assert.ok(world.warnings.some((message) => /refused proxy/.test(message)))
  // An ordinary one still works.
  assert.equal(
    (await client.call('Target.createBrowserContext', { proxyServer: 'http://203.0.113.9:3128' })).error,
    undefined
  )
})
