/**
 * What a page can tell about the browser a slot gives it, through the whole path: node, relay and client, on each display
 * the node can run on and with each isolation. A headless Chromium announces itself (`HeadlessChrome` in its user agent, a
 * screen smaller than its window), and DevTools turns on `navigator.webdriver`; a slot should not do either unasked.
 * Skipped unless PLAYWRIGHT_BROWSER_TESTS=1. Run with: pnpm test:browser
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { createBrowserBay } from '../src/client/index.js'
import { startBrowserNode, type Isolation } from '../src/node/browser-node.js'
import type { Display } from '../src/node/chromium.js'
import { hashToken } from '../src/relay/registry.js'
import { createRelayServer } from '../src/relay/server.js'
import { connect, enabled, serve, until } from './support.js'
import { chromium } from 'playwright'

const API_KEY = 'fingerprint-test-api-key-0123456789'
const SECRET = 'fingerprint-test-enrollment-secret'

const hasXvfb = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v Xvfb'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

async function startBox(options: { display: Display; isolation: Isolation; hideWebdriver?: boolean }) {
  const relay = createRelayServer({
    apiKey: API_KEY,
    enrollmentSecrets: [{ id: 'test', sha256: hashToken(SECRET) }],
    nodeTimeoutMs: 60_000
  })
  const port = await relay.listen(0, '127.0.0.1')
  const base = `http://127.0.0.1:${port}`
  const node = await startBrowserNode({
    relayUrl: base,
    enrollmentSecret: SECRET,
    nodeId: 'fingerprint-node',
    maxContexts: 2,
    executable: chromium.executablePath(),
    ...options
  })
  await until(() => relay.registry.listNodes().length === 1, 'the node to join', 60_000)
  const box = createBrowserBay({ url: base, apiKey: API_KEY })
  return {
    acquire: (runId: string) => box.acquire({ runId, maxLifetimeSeconds: 600, waitMs: 10_000 }),
    async close() {
      await node.close()
      await relay.close()
    }
  }
}

/** The page's own view of the browser: what a bot detector reads first. */
const probe = () => ({
  userAgent: navigator.userAgent,
  webdriver: navigator.webdriver,
  brands: (navigator as unknown as { userAgentData?: { brands: Array<{ brand: string }> } }).userAgentData?.brands.map(
    (entry) => entry.brand
  ),
  screen: [screen.width, screen.height],
  window: [outerWidth, outerHeight],
  notification: Notification.permission,
  webgl: Boolean(document.createElement('canvas').getContext('webgl'))
})

for (const display of ['headless', 'xvfb'] as const) {
  for (const isolation of ['context', 'process'] as const) {
    test(
      `a slot's browser does not announce itself: ${display} display, ${isolation} isolation`,
      { skip: !enabled || (display === 'xvfb' && !hasXvfb) },
      async () => {
        const pool = await startBox({ display, isolation })
        const requests: Array<string | undefined> = []
        const { server, origin } = await serve((request, response) => {
          requests.push(request.headers['user-agent'])
          response.writeHead(200, { 'content-type': 'text/html' })
          response.end('<!doctype html><title>fingerprint</title>')
        })
        try {
          const slot = await pool.acquire('fingerprint')
          const session = await connect(slot.cdpUrl, { headers: slot.headers, startUrl: origin })
          const seen = await session.page.evaluate(probe)

          assert.equal(seen.webdriver, false, 'DevTools turns navigator.webdriver on; the node turns it off again')
          assert.ok(
            seen.screen[0]! >= seen.window[0]! && seen.screen[1]! >= seen.window[1]!,
            `a screen is at least as big as its window: ${seen.screen} against ${seen.window}`
          )
          assert.equal(seen.notification, 'default', 'a page on a secure origin has not been refused notifications')
          assert.equal(requests.at(-1), seen.userAgent, 'the header and the script say the same thing')
          assert.equal(
            seen.webgl,
            true,
            'a page can get a WebGL context (a software one with no GPU): none at all is a stronger tell'
          )
          if (display === 'xvfb') {
            assert.ok(!/Headless/.test(seen.userAgent), `a headful browser is not HeadlessChrome: ${seen.userAgent}`)
            assert.ok(
              (seen.brands ?? []).every((brand) => !/Headless/.test(brand)),
              `nor do its client hints say so: ${seen.brands}`
            )
          }
          await session.detach()
          await slot.release()
        } finally {
          server.close()
          await pool.close()
        }
      }
    )
  }
}

test('a node told to keep navigator.webdriver leaves it on', { skip: !enabled }, async () => {
  const pool = await startBox({ display: 'headless', isolation: 'context', hideWebdriver: false })
  const { server, origin } = await serve()
  try {
    const slot = await pool.acquire('fingerprint-keep')
    const session = await connect(slot.cdpUrl, { headers: slot.headers, startUrl: origin })
    assert.equal(
      await session.page.evaluate(() => navigator.webdriver),
      true,
      'the operator asked for the browser to say so'
    )
    await session.detach()
    await slot.release()
  } finally {
    server.close()
    await pool.close()
  }
})

test('on a virtual display, two pages in one slot both keep running', { skip: !enabled || !hasXvfb }, async () => {
  // Headful, only the tab in front of its window paints, and the others have their timers throttled: the node starts
  // Chromium with the flags that stop that, so a live view of (or a script in) a page that is not in front still works.
  const pool = await startBox({ display: 'xvfb', isolation: 'context' })
  const { server, origin } = await serve()
  try {
    const slot = await pool.acquire('fingerprint-pages')
    const session = await connect(slot.cdpUrl, { headers: slot.headers, startUrl: origin })
    const second = await session.context.newPage()
    await second.goto(origin)
    const ticks = (page: typeof second) =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            let count = 0
            const timer = setInterval(() => count++, 20)
            setTimeout(() => {
              clearInterval(timer)
              resolve(count)
            }, 1500)
          })
      )
    const [first, other] = await Promise.all([ticks(session.page), ticks(second)])
    assert.ok(first > 30 && other > 30, `both pages' timers ran about every 20 ms for 1.5 s: ${first} and ${other}`)
    await session.detach()
    await slot.release()
  } finally {
    server.close()
    await pool.close()
  }
})
