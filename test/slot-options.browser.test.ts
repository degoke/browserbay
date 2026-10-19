/**
 * A slot's own proxy, time zone, language and node, against real Chromium and the whole path (client, relay, node). Skipped
 * unless PLAYWRIGHT_BROWSER_TESTS=1. Run with: pnpm test:browser
 *
 * The proxy here listens on this machine's own address, not on loopback: a node refuses a proxy at loopback (it is how a slot
 * would reach the node's other services), so that is the one place a test proxy cannot be. Without a network interface the
 * proxy tests are skipped.
 */
import assert from 'node:assert/strict'
import { connect as netConnect, createServer, type AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import test from 'node:test'
import { UnsupportedError } from '../src/client/index.js'
import { connect, enabled, serve, startBox } from './support.js'

const lan = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address

const USER = 'proxy-user'
const PASSWORD = 'proxy-secret-pw-that-must-stay-out-of-everything'

/** An HTTP proxy that checks its credentials and records every CONNECT, and tunnels all of them to `origin`. */
async function proxyServer(origin: number, credentials = `${USER}:${PASSWORD}`) {
  const requests: Array<{ target: string; auth?: string; allowed: boolean }> = []
  const server = createServer((client) => {
    client.on('error', () => undefined)
    let data = Buffer.alloc(0)
    client.on('data', function onData(chunk) {
      data = Buffer.concat([data, chunk])
      const end = data.indexOf('\r\n\r\n')
      if (end === -1) return
      client.off('data', onData)
      const [line = '', ...headers] = data.subarray(0, end).toString().split('\r\n')
      const auth = headers.find((header) => /^proxy-authorization:/i.test(header))?.split(': ')[1]
      const allowed = auth === `Basic ${Buffer.from(credentials).toString('base64')}`
      requests.push({ target: line.split(' ')[1] ?? '', auth, allowed })
      if (!allowed) return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      const upstream = netConnect(origin, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n')
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.on('error', () => client.destroy())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

for (const isolation of ['context', 'process'] as const) {
  test(
    `a slot's traffic leaves through its own proxy, with credentials the browser never holds: ${isolation} isolation`,
    { skip: !enabled || !lan },
    async () => {
      const pool = await startBox({ isolation })
      const { server, origin } = await serve()
      const originPort = Number(new URL(origin).port)
      const proxy = await proxyServer(originPort)
      try {
        const slot = await pool.acquire('proxied', {
          proxy: { server: `http://${lan}:${proxy.port}`, username: USER, password: PASSWORD }
        })
        const session = await connect(slot.cdpUrl, { headers: slot.headers })

        // A name that exists nowhere: it loads only because the proxy resolves it, so the request went through the proxy.
        await session.page.goto('http://shop.example.test:8080/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
        assert.ok((await session.page.content()).includes('Click me'), 'the origin behind the proxy answered')
        const first = proxy.requests.find((request) => request.target === 'shop.example.test:8080')
        assert.ok(first, `the proxy saw it: ${JSON.stringify(proxy.requests)}`)
        assert.equal(
          first.auth,
          `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`,
          'with the credentials, added on the node'
        )
        assert.equal(first.allowed, true)

        // Localhost is not exempt: a slot on a proxy cannot reach the node's own loopback by asking for it.
        await session.page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        assert.ok(
          proxy.requests.some((request) => request.target === `127.0.0.1:${originPort}`),
          'loopback went through the proxy too'
        )

        if (isolation === 'process') {
          // A context the client makes for itself starts from the slot's proxy.
          const other = await session.browser.newContext()
          const page = await other.newPage()
          await page.goto('http://other.example.test:8080/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
          assert.ok(proxy.requests.some((request) => request.target === 'other.example.test:8080'))
          await other.close()
        }

        // A plain slot on the same box has no such path: the name does not exist.
        const plainSlot = await pool.acquire('plain')
        const plain = await connect(plainSlot.cdpUrl, { headers: plainSlot.headers })
        await assert.rejects(
          plain.page.goto('http://shop.example.test:8080/', { timeout: 30_000 }),
          /ERR_NAME_NOT_RESOLVED|net::ERR/
        )

        const node = pool.relay.registry.listNodes()[0]!
        // What matters is what this node offers for the options under test: a proxy always, a language only with a Chromium per
        // slot. (Other features, such as whether it can leave a slot unsigned, are not this test's business.)
        assert.ok(node.features?.includes('proxy'), 'a proxy is offered')
        assert.equal(
          node.features?.includes('locale'),
          isolation === 'process',
          'a language only where each slot has its own browser'
        )
        assert.ok(!pool.logs.join('\n').includes(PASSWORD), 'the password is in no log of the relay or the node')

        await session.detach()
        await plain.detach()
        await slot.release()
        await plainSlot.release()
      } finally {
        server.close()
        await proxy.close()
        await pool.close()
      }
    }
  )
}

test(
  'a proxy that refuses the credentials is a failed page, not a login prompt that hangs',
  { skip: !enabled || !lan },
  async () => {
    const pool = await startBox({ isolation: 'context' })
    const { server, origin } = await serve()
    const proxy = await proxyServer(Number(new URL(origin).port))
    try {
      const slot = await pool.acquire('wrong-password', {
        proxy: { server: `http://${lan}:${proxy.port}`, username: USER, password: 'not-the-password' }
      })
      const session = await connect(slot.cdpUrl, { headers: slot.headers })
      const started = Date.now()
      await assert.rejects(session.page.goto('http://shop.example.test/', { timeout: 20_000 }), /net::ERR_/)
      assert.ok(Date.now() - started < 15_000, 'it failed, it did not wait for someone to type a password')
      assert.ok(proxy.requests.length > 0 && proxy.requests.every((request) => !request.allowed))
      await session.detach()
      await slot.release()
    } finally {
      server.close()
      await proxy.close()
      await pool.close()
    }
  }
)

test(
  'a slot can have its own time zone and language when each slot has a browser of its own',
  { skip: !enabled },
  async () => {
    const pool = await startBox({ isolation: 'process' })
    const languages: Array<string | undefined> = []
    const { server, origin } = await serve((request, response) => {
      languages.push(request.headers['accept-language'])
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>locale</title>')
    })
    try {
      const slot = await pool.acquire('german', { timezone: 'europe/berlin', locale: 'de-de' })
      const session = await connect(slot.cdpUrl, { headers: slot.headers, startUrl: origin })
      const seen = await session.page.evaluate(() => ({
        language: navigator.language,
        languages: [...navigator.languages],
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // January 15th: Central European Time, an hour ahead of UTC.
        offset: new Date(Date.UTC(2026, 0, 15, 12)).getTimezoneOffset()
      }))
      assert.equal(seen.timeZone, 'Europe/Berlin')
      assert.equal(seen.offset, -60)
      assert.equal(seen.language, 'de-DE')
      assert.equal(seen.languages[0], 'de-DE')
      assert.match(String(languages.at(-1)), /^de-DE/, 'and so is the header sites see')

      // A plain slot on the same node is in the node's own zone and language.
      const plainSlot = await pool.acquire('plain')
      const plain = await connect(plainSlot.cdpUrl, { headers: plainSlot.headers, startUrl: origin })
      const normal = await plain.page.evaluate(() => navigator.language)
      assert.notEqual(normal, 'de-DE')
      await session.detach()
      await plain.detach()
      await slot.release()
      await plainSlot.release()
    } finally {
      server.close()
      await pool.close()
    }
  }
)

test(
  'a box whose browsers are shared cannot give one slot a time zone, and says so at once',
  { skip: !enabled },
  async () => {
    const pool = await startBox({ isolation: 'context' })
    try {
      const started = Date.now()
      await assert.rejects(
        pool.acquire('german', { timezone: 'Europe/Berlin' }),
        (error: Error) => error instanceof UnsupportedError && /No node offers locale/.test(error.message)
      )
      assert.ok(Date.now() - started < 5000, 'not after the wait')
      assert.equal(pool.relay.registry.listSlots().length, 0, 'and nothing was made')
    } finally {
      await pool.close()
    }
  }
)

test(
  'a slot can ask for a node by its label, and a node kept for its labels takes only those',
  { skip: !enabled },
  async () => {
    const pool = await startBox({ labels: ['residential', 'eu'], exclusive: true })
    try {
      const slot = await pool.acquire('home', { nodeLabels: ['residential'] })
      assert.equal(slot.nodeId, 'browser-test-node')
      await assert.rejects(pool.acquire('abroad', { nodeLabels: ['us'] }), UnsupportedError)
      await assert.rejects(
        pool.acquire('ordinary'),
        (error: Error) => error instanceof UnsupportedError && /only takes slots that ask/.test(error.message)
      )
      const node = pool.relay.registry.listNodes()[0]!
      assert.deepEqual([node.labels, node.exclusive], [['residential', 'eu'], true])
      await slot.release()
    } finally {
      await pool.close()
    }
  }
)
