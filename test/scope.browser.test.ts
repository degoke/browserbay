/**
 * Real-browser check of the scope hub (src/node/scope.ts): one shared Chromium, one BrowserContext per slot, and
 * clients connecting through a virtual browser-level endpoint that shows only that slot.
 * Skipped unless PLAYWRIGHT_BROWSER_TESTS=1 (CI has no Chromium). Run with: pnpm test:browser
 *
 * Besides the watch-drive-reattach scenario, it covers what a shared browser adds: slots that never see each other, a
 * popup that is still covered by the slot's request routing, a client that dies mid-interception, large messages, and
 * every way another slot's browser could be reached.
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { createCdpScope, type CdpScope } from '../src/node/scope.js'
import {
  connect,
  enabled,
  launchChromium,
  rawSocket,
  serve,
  watchDriveReattach,
  type RawMessage,
  type Session
} from './support.js'

/**
 * One real Chromium behind the hub, with a loopback front that maps /cdp/<run> to that run's virtual browser.
 * `latencyMs` delays everything the hub says to a client (in order), as a distant client would see it: it widens the
 * window in which a tab that is not really held at start would already have started loading.
 */
async function startSharedChromium({ latencyMs = 0 }: { latencyMs?: number } = {}) {
  const chromium = await launchChromium()
  const upstream = new WebSocket(chromium.webSocketDebuggerUrl, {
    perMessageDeflate: false,
    maxPayload: 256 * 1024 * 1024
  })
  await new Promise<void>((resolve, reject) => {
    upstream.once('open', () => resolve())
    upstream.once('error', reject)
  })

  const refused: string[] = []
  const scope: CdpScope = createCdpScope({
    upstream: { send: (text) => upstream.send(text) },
    logger: { warn: (message, fields) => refused.push(`${message} ${JSON.stringify(fields ?? {})}`) }
  })
  upstream.on('message', (data) => scope.onUpstreamMessage(data.toString()))
  upstream.on('close', () => scope.onUpstreamClosed())
  await scope.start()

  /** Every browser-level (no sessionId) command clients sent: the surface the hub has to understand. */
  const browserLevelMethods = new Set<string>()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false })
  const front: Server = createServer((_request, response) => {
    // DevTools' HTTP side (/json/list, /json/new, /devtools/page/<id>) is never offered.
    response.writeHead(404)
    response.end()
  })
  front.on('upgrade', (request, socket, head) => {
    const runKey = /^\/cdp\/([\w-]+)$/.exec(request.url ?? '')?.[1]
    if (!runKey || !scope.hasRun(runKey)) return void socket.destroy()
    wss.handleUpgrade(request, socket, head, (ws) => {
      const client = scope.connect(runKey, {
        send: (text) =>
          latencyMs ? void setTimeout(() => ws.readyState === ws.OPEN && ws.send(text), latencyMs) : ws.send(text),
        close: (code, reason) => ws.close(code, reason)
      })
      ws.on('message', (data) => {
        const text = data.toString()
        try {
          const message = JSON.parse(text) as { method?: string; sessionId?: string }
          if (message.method && !message.sessionId) browserLevelMethods.add(message.method)
        } catch {
          // The hub ignores it too.
        }
        client.handleMessage(text)
      })
      ws.on('close', () => client.close())
      ws.on('error', () => client.close())
    })
  })
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', () => resolve()))
  const port = (front.address() as AddressInfo).port

  const endpointOf = (runKey: string) => `ws://127.0.0.1:${port}/cdp/${runKey}`
  /** A session that can also release its slot, as a service does when its work is over. */
  const withClose = (runId: string, session: Session) => ({
    ...session,
    close: async () => {
      await session.detach()
      await scope.disposeRun(runId)
    }
  })
  /** A new slot's browser, opened on `startUrl`; `guard` runs on its context first. */
  const open = async (runId: string, startUrl: string, guard?: (context: Session['context']) => Promise<unknown>) => {
    await scope.createRun(runId)
    return withClose(runId, await connect(endpointOf(runId), { startUrl, guard }))
  }
  /** Reconnects to a slot that is still there. */
  const reattach = async (runId: string) => withClose(runId, await connect(endpointOf(runId)))

  return {
    scope,
    open,
    reattach,
    endpointOf,
    browserLevelMethods,
    refused,
    async close() {
      wss.close()
      front.close()
      upstream.close()
      await chromium.stop()
    }
  }
}

const page = (session: Session) => session.page

/** Playwright and a watcher must never be refused anything: a refusal is a client that breaks on upgrade. */
const assertNothingRefused = (shared: { refused: string[] }) =>
  assert.deepEqual(shared.refused, [], 'ordinary use never hits a command the hub refuses')

test('the watch-drive-reattach scenario works through a context of a shared Chromium', { skip: !enabled }, async () => {
  const shared = await startSharedChromium()
  try {
    await shared.scope.createRun('run-scenario')
    await watchDriveReattach(shared.endpointOf('run-scenario'))
    assertNothingRefused(shared)
  } finally {
    await shared.close()
  }
})

test('two runs on one Chromium never see each other’s pages or cookies', { skip: !enabled }, async () => {
  const shared = await startSharedChromium()
  const { server, origin } = await serve()
  try {
    const a = await shared.open('run-a', `${origin}/?who=a`)
    const b = await shared.open('run-b', `${origin}/?who=b`)

    for (const [session, who] of [
      [a, 'a'],
      [b, 'b']
    ] as const) {
      const pages = page(session).context().pages()
      assert.equal(pages.length, 1, `run ${who} sees only its own page`)
      assert.equal(new URL(pages[0]!.url()).searchParams.get('who'), who)
    }

    await page(a)
      .context()
      .addCookies([{ name: 'who', value: 'a', url: origin }])
    assert.deepEqual(await page(b).context().cookies(origin), [], 'a cookie set in one run is not in the other')
    assert.equal(await page(b).evaluate(() => document.cookie), '')

    // A new tab opened by one run stays in that run.
    await page(a).context().newPage()
    assert.equal(page(a).context().pages().length, 2)
    assert.equal(page(b).context().pages().length, 1)

    // Closing one run's connection leaves the other's untouched, and the first run's pages survive for a later client.
    await a.detach()
    assert.equal(await page(b).evaluate(() => 1 + 1), 2)
    const again = await shared.reattach('run-a')
    assert.equal(page(again).context().pages().length, 2, 'the same pages are there after reattaching')
    assert.equal(
      await page(again)
        .context()
        .cookies(origin)
        .then((cookies) => cookies.length),
      1
    )

    await again.close()
    await b.close()
    assertNothingRefused(shared)
  } finally {
    server.close()
    await shared.close()
  }
})

test('a popup is held for the run’s request routing before it loads anything', { skip: !enabled }, async () => {
  const shared = await startSharedChromium({ latencyMs: 120 })
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(request.url?.startsWith('/popup') ? '<title>direct</title>direct' : '<title>opener</title>opener')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // A context.route, which Playwright arms on a new tab while it is paused: the mechanism a navigation guard uses.
  const guard = async (context: Session['context']) => {
    await context.route('**/popup', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>routed</title>routed' })
    )
  }
  try {
    const run = await shared.open('run-popup', origin, guard)
    const opener = page(run)
    const [popup] = await Promise.all([opener.waitForEvent('popup'), opener.evaluate(() => window.open('/popup'))])
    await popup.waitForLoadState('domcontentloaded')
    assert.equal(await popup.title(), 'routed', 'the popup’s first request went through the run’s route')
    await run.close()
    assertNothingRefused(shared)
  } finally {
    server.close()
    await shared.close()
  }
})

test('a client that dies mid-interception does not freeze the run’s pages', { skip: !enabled }, async () => {
  const shared = await startSharedChromium()
  const { server, origin } = await serve()
  try {
    const first = await shared.open('run-rogue', origin)
    await first.detach()

    const rogue = rawSocket(shared.endpointOf('run-rogue'))
    await rogue.opened
    const { targetInfos } = (await rogue.send('Target.getTargets')).result as {
      targetInfos: Array<{ targetId: string; type: string }>
    }
    const target = targetInfos.find((info) => info.type === 'page')!
    const { sessionId } = (await rogue.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }))
      .result as {
      sessionId: string
    }
    await rogue.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId)
    rogue.kill()
    await new Promise((resolve) => setTimeout(resolve, 500))

    // With the dead client's interception still armed this navigation would wait for an answer nobody gives.
    const second = await shared.reattach('run-rogue')
    await page(second).goto(`${origin}/after`, { timeout: 8_000 })
    await second.close()
    assertNothingRefused(shared)
  } finally {
    server.close()
    await shared.close()
  }
})

test('a very large page result passes through the hub', { skip: !enabled }, async () => {
  const shared = await startSharedChromium()
  const { server, origin } = await serve()
  try {
    const run = await shared.open('run-large', origin)
    const length = await page(run).evaluate(() => 'x'.repeat(20_000_000).length)
    assert.equal(length, 20_000_000)
    const echoed = await page(run).evaluate(() => 'y'.repeat(20_000_000))
    assert.equal(echoed.length, 20_000_000)
    await run.close()
    assertNothingRefused(shared)
  } finally {
    server.close()
    await shared.close()
  }
})

test('one run cannot reach another run’s browser', { skip: !enabled }, async () => {
  const shared = await startSharedChromium()
  const { server, origin } = await serve()
  try {
    const a = await shared.open('run-a', `${origin}/?who=a`)
    const b = await shared.open('run-b', `${origin}/?who=b`)
    await page(b)
      .context()
      .addCookies([{ name: 'secret', value: 'b-only', url: origin }])

    const rawA = rawSocket(shared.endpointOf('run-a'))
    const rawB = rawSocket(shared.endpointOf('run-b'))
    await Promise.all([rawA.opened, rawB.opened])

    type Info = { targetId: string; type: string; browserContextId: string }
    const targetsOf = async (raw: typeof rawA) =>
      ((await raw.send('Target.getTargets')).result as { targetInfos: Info[] }).targetInfos
    const infoA = (await targetsOf(rawA)).filter((info) => info.type === 'page')
    const infoB = (await targetsOf(rawB)).filter((info) => info.type === 'page')
    assert.equal(infoA.length, 1)
    assert.equal(infoB.length, 1)
    const targetB = infoB[0]!.targetId
    const contextB = infoB[0]!.browserContextId
    assert.notEqual(infoA[0]!.browserContextId, contextB)
    assert.ok(
      (await targetsOf(rawA)).every((info) => info.browserContextId === infoA[0]!.browserContextId),
      'every target run A is shown is in run A’s context (so never Chromium’s default-context page either)'
    )

    const refusal = async (message: Promise<RawMessage>) => {
      const answer = await message
      assert.ok(answer.error, 'the command was refused')
      return answer.error.message
    }

    // Another run's target answers exactly like one that does not exist: no oracle for what else is on the browser.
    const nothing = await refusal(rawA.send('Target.attachToTarget', { targetId: 'no-such-target', flatten: true }))
    assert.equal(await refusal(rawA.send('Target.attachToTarget', { targetId: targetB, flatten: true })), nothing)
    assert.equal(await refusal(rawA.send('Target.closeTarget', { targetId: targetB })), nothing)
    assert.equal(await refusal(rawA.send('Target.activateTarget', { targetId: targetB })), nothing)
    assert.equal(await refusal(rawA.send('Target.getTargetInfo', { targetId: targetB })), nothing)

    // Another run's context.
    await refusal(rawA.send('Target.createTarget', { url: 'about:blank', browserContextId: contextB }))
    await refusal(rawA.send('Storage.getCookies', { browserContextId: contextB }))
    await refusal(rawA.send('Storage.clearCookies', { browserContextId: contextB }))
    await refusal(rawA.send('Browser.grantPermissions', { permissions: ['geolocation'], browserContextId: contextB }))
    const own = (await rawA.send('Storage.getCookies', {})).result as { cookies: Array<{ name: string }> }
    assert.deepEqual(own.cookies, [], 'a command without a context reads this run’s cookies, not the default profile’s')

    // Browser-wide commands.
    await refusal(rawA.send('Browser.close'))
    await refusal(rawA.send('Browser.crash'))
    await refusal(rawA.send('SystemInfo.getInfo'))
    await refusal(rawA.send('Target.attachToBrowserTarget'))
    await refusal(rawA.send('Target.createBrowserContext', {}))
    await refusal(rawA.send('Target.disposeBrowserContext', { browserContextId: contextB }))
    assert.ok((await rawA.send('Browser.getVersion')).result, 'the connection survives a refused Browser.close')
    assert.equal(await page(b).evaluate(() => 1 + 1), 2, 'and so does the other run’s browser')

    // Sessions: run A's own page session is fenced too, and another run's session id is not found.
    const sessionA = (
      (await rawA.send('Target.attachToTarget', { targetId: infoA[0]!.targetId, flatten: true })).result as {
        sessionId: string
      }
    ).sessionId
    const sessionB = (
      (await rawB.send('Target.attachToTarget', { targetId: targetB, flatten: true })).result as {
        sessionId: string
      }
    ).sessionId
    await refusal(rawA.send('Storage.getCookies', {}, sessionA))
    await refusal(rawA.send('Tracing.start', {}, sessionA))
    await refusal(rawA.send('Browser.grantPermissions', { permissions: [], browserContextId: contextB }, sessionA))
    await refusal(rawA.send('Target.attachToTarget', { targetId: targetB, flatten: true }, sessionA))
    const foreignSession = await rawA.send('Page.enable', {}, sessionB)
    assert.equal(foreignSession.error?.code, -32001)
    assert.equal(foreignSession.error?.message, 'Session with given id not found.')
    await refusal(rawA.send('Target.detachFromTarget', { sessionId: sessionB }))
    assert.ok((await rawB.send('Page.enable', {}, sessionB)).result, 'run B’s own session still works')

    // DevTools' HTTP side is not there at all, and a socket without a run is refused.
    const port = new URL(shared.endpointOf('run-a')).port
    for (const path of ['/json/list', '/json/version', '/json/new', `/devtools/page/${targetB}`]) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 404, path)
    }
    await assert.rejects(rawSocket(shared.endpointOf('run-missing')).opened)

    rawA.close()
    rawB.close()
    await a.close()
    await b.close()
  } finally {
    server.close()
    console.log('browser-level commands clients sent:', [...shared.browserLevelMethods].sort().join(', '))
    await shared.close()
  }
})

test(
  'a slot is held to the web: no file:, no browser internals, no file paths read into a page',
  { skip: !enabled },
  async () => {
    const shared = await startSharedChromium()
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>upload</title><input id="f" type="file">')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const run = await shared.open('run-held', origin)
      const refused = /cannot be opened on a shared browser/

      // What a person at a keyboard would try first: type the address of a local file or an internal page.
      for (const url of [
        'file:///etc/hosts',
        'view-source:file:///etc/hosts',
        'chrome://inspect/#pages',
        'chrome://version',
        'about:version'
      ]) {
        await assert.rejects(run.page.goto(url, { timeout: 8_000 }), refused, url)
        assert.equal(new URL(run.page.url()).origin, origin, `${url} did not move the page`)
      }
      // The same through a new tab, and through the protocol directly.
      await assert.rejects(
        run.context.newPage().then((page) => page.goto('file:///etc/hosts')),
        refused
      )
      const raw = rawSocket(shared.endpointOf('run-held'))
      await raw.opened
      const created = await raw.send('Target.createTarget', { url: 'file:///etc/hosts' })
      assert.match(created.error?.message ?? '', refused)

      // A file path read into the page by the browser is refused; Playwright's buffer upload (how a remote client uploads) works.
      const { targetInfos } = (await raw.send('Target.getTargets')).result as {
        targetInfos: Array<{ targetId: string; type: string; url: string }>
      }
      const target = targetInfos.find((info) => info.type === 'page' && info.url.startsWith(origin))!
      const { sessionId } = (await raw.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }))
        .result as { sessionId: string }
      const { root } = (await raw.send('DOM.getDocument', {}, sessionId)).result as { root: { nodeId: number } }
      const { nodeId } = (await raw.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#f' }, sessionId))
        .result as { nodeId: number }
      const byPath = await raw.send('DOM.setFileInputFiles', { files: ['/etc/hosts'], nodeId }, sessionId)
      assert.match(byPath.error?.message ?? '', /not available on a shared browser/)
      raw.close()

      await run.page.setInputFiles('#f', {
        name: 'cv.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 hello')
      })
      assert.equal(
        await run.page.evaluate(() => (document.getElementById('f') as HTMLInputElement).files![0]!.size),
        14
      )

      // Refusing is not breaking: the web still works afterwards.
      await run.page.goto(`${origin}/after`)
      assert.equal(await run.page.title(), 'upload')
      await run.close()
      // Every attempt above was refused by the hub and logged, and nothing else was.
      const logged = (start: string) => shared.refused.filter((line) => line.startsWith(start)).length
      assert.equal(logged('A navigation to a refused URL'), 6)
      assert.equal(logged('A target on a refused URL'), 1)
      assert.equal(logged('A session-level command was refused {"method":"DOM.setFileInputFiles"'), 1)
      assert.equal(shared.refused.length, 8, shared.refused.join('\n'))
    } finally {
      server.close()
      await shared.close()
    }
  }
)
