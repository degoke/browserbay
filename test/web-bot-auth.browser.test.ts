/**
 * Web Bot Auth against real Chromium and the whole path: the relay publishes the public key, a node signs the requests of the
 * slots that are to be signed, and every request a page makes reaches a site that verifies it with Cloudflare's own library, using
 * the key it fetched from the relay's directory, exactly as a real site would. Skipped unless PLAYWRIGHT_BROWSER_TESTS=1.
 *
 * What it pins down is the result of the spike in the pull request that added this: the hub's signing session adds headers after
 * Chromium's CORS check (so a cross-origin fetch sends no preflight), is armed before a tab runs, covers redirects, popups and
 * frames, and does not see WebSocket handshakes.
 */
import assert from 'node:assert/strict'
import type { IncomingHttpHeaders } from 'node:http'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { verify } from 'web-bot-auth'
import { verifierFromJWK } from 'web-bot-auth/crypto'
import { UnsupportedError } from '../src/client/index.js'
import { DIRECTORY_MEDIA_TYPE, DIRECTORY_PATH, generateSigningKey } from '../src/web-bot-auth.js'
import { connect, enabled, serve, startBox } from './support.js'

interface Seen {
  method: string
  path: string
  signed: boolean
  verified: boolean
  headers: IncomingHttpHeaders
}

/** A site: it checks the signature of every request it gets, with the key the relay publishes, and writes down what it found. */
async function verifyingSite(verifier: Awaited<ReturnType<typeof verifierFromJWK>>, redirectTo?: () => string) {
  const seen: Seen[] = []
  const { server, origin } = await serve(async (request, response) => {
    const path = request.url ?? '/'
    const signed = Boolean(request.headers.signature)
    let verified = false
    if (signed) {
      try {
        const headers = Object.fromEntries(
          Object.entries(request.headers).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, String(value)]]
          )
        )
        await verify(new Request(`http://${request.headers.host}${path}`, { method: request.method, headers }), {
          resolver: () => verifier
        } as never)
        verified = true
      } catch {
        verified = false
      }
    }
    seen.push({ method: request.method ?? 'GET', path, signed, verified, headers: request.headers })
    if (path.startsWith('/redirect')) return void response.writeHead(302, { location: redirectTo?.() ?? '/' }).end()
    // Without these headers allowed, a request that is not "simple" is refused at the preflight: that is how a strict site behaves.
    if (request.method === 'OPTIONS') return void response.writeHead(204, { 'access-control-allow-origin': '*' }).end()
    response.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' })
    response.end(
      path.startsWith('/popup') ? '<title>popup</title>popup' : '<!doctype html><title>site</title><body>ok</body>'
    )
  })
  return { server, origin, seen, find: (path: string) => seen.filter((entry) => entry.path.startsWith(path)) }
}

for (const isolation of ['context', 'process'] as const) {
  test(
    `every request of a slot that asks to be signed is signed and verifies, and no other slot's is: ${isolation} isolation`,
    { skip: !enabled },
    async () => {
      const key = generateSigningKey()
      const pool = await startBox({ isolation, webBotAuth: { mode: 'optional', key: key.privateJwk } })
      // A site finds the public key where the relay publishes it, not by being told.
      const directory = await fetch(`${pool.base}${DIRECTORY_PATH}`)
      assert.equal(directory.headers.get('content-type'), DIRECTORY_MEDIA_TYPE)
      const jwk = ((await directory.json()) as { keys: Array<Record<string, string>> }).keys[0]!
      assert.equal(jwk.kid, key.keyid)
      const verifier = await verifierFromJWK(jwk as never)

      const site = await verifyingSite(verifier)
      const other = await verifyingSite(verifier) // a second origin: cross-origin to the first
      const hop = await verifyingSite(verifier)
      const redirecting = await verifyingSite(verifier, () => `${hop.origin}/landed`)
      const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' })
      const socketHeaders: IncomingHttpHeaders[] = []
      sockets.on('connection', (socket, request) => {
        socketHeaders.push(request.headers)
        socket.close()
      })
      await new Promise((resolve) => sockets.once('listening', resolve))
      const socketPort = (sockets.address() as { port: number }).port
      try {
        const signed = await pool.acquire('signed', { signRequests: true })
        const driver = await connect(signed.cdpUrl, { headers: signed.headers })
        const { page, context } = driver

        // A client of the slot that adds a header of its own the way that works with signing (the browser applies it), and also
        // routes requests without changing their headers: both its interceptor and the hub's run on every request.
        await context.setExtraHTTPHeaders({ 'x-from-client': '1' })
        await context.route('**/*', (route) => route.continue())

        await page.goto(`${site.origin}/start`, { waitUntil: 'domcontentloaded' })
        assert.deepEqual(
          site.find('/start').map((e) => [e.signed, e.verified]),
          [[true, true]],
          'a navigation'
        )
        assert.equal(
          site.find('/start')[0]!.headers['x-from-client'],
          '1',
          'the client’s own header is there too, and signed over'
        )

        // A request from the page to the same origin, and to another one: with no preflight, and a strict site still answers.
        await page.evaluate((url) => fetch(url).then((r) => r.text()), `${site.origin}/same-origin`)
        await page.evaluate((url) => fetch(url).then((r) => r.text()), `${other.origin}/cross-origin`)
        assert.deepEqual(
          site.find('/same-origin').map((e) => [e.signed, e.verified]),
          [[true, true]]
        )
        assert.deepEqual(
          other.find('/cross-origin').map((e) => [e.method, e.signed, e.verified]),
          [['GET', true, true]],
          'one request, signed: no OPTIONS before it'
        )
        assert.equal(
          other.seen.filter((e) => e.method === 'OPTIONS').length,
          0,
          'adding the headers did not make the browser ask first'
        )

        // Each hop of a redirect is a request of its own, signed for the host it goes to.
        await page.goto(`${redirecting.origin}/redirect`, { waitUntil: 'domcontentloaded' })
        assert.deepEqual(
          redirecting.find('/redirect').map((e) => [e.signed, e.verified]),
          [[true, true]]
        )
        assert.deepEqual(
          hop.find('/landed').map((e) => [e.signed, e.verified]),
          [[true, true]],
          'the second host was signed for itself, not copied'
        )

        // A tab the page opens, and a frame in it: a new target the hub has to arm before its first request.
        await page.setContent(
          `<a id="open" target="_blank" href="${site.origin}/popup">open</a><iframe src="${site.origin}/frame"></iframe>`
        )
        const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#open')])
        await popup.waitForLoadState('domcontentloaded')
        for (let i = 0; i < 40 && site.find('/frame').length === 0; i++)
          await new Promise((resolve) => setTimeout(resolve, 100))
        assert.deepEqual(
          site.find('/popup').map((e) => [e.signed, e.verified]),
          [[true, true]],
          'a popup’s first request'
        )
        assert.deepEqual(
          site.find('/frame').map((e) => [e.signed, e.verified]),
          [[true, true]],
          'a frame'
        )

        // A tab made by the driver, as Playwright makes one: blank, then a navigation.
        const fresh = await context.newPage()
        await fresh.goto(`${site.origin}/fresh`, { waitUntil: 'domcontentloaded' })
        assert.deepEqual(
          site.find('/fresh').map((e) => [e.signed, e.verified]),
          [[true, true]]
        )

        // A WebSocket handshake never passes through request interception: it goes unsigned. This is a limit the docs name.
        await page.evaluate(
          (url) => new Promise((resolve) => Object.assign(new WebSocket(url), { onclose: resolve, onerror: resolve })),
          `ws://127.0.0.1:${socketPort}/`
        )
        assert.ok(socketHeaders.length > 0 && !socketHeaders[0]!.signature, 'the handshake is unsigned')

        // The same node, at the same time: a slot that did not ask, and one that asked not to, are not signed.
        for (const [name, options] of [
          ['default', {}],
          ['unsigned', { signRequests: false }]
        ] as const) {
          const plain = await pool.acquire(name, options)
          const driver2 = await connect(plain.cdpUrl, { headers: plain.headers })
          await driver2.page.goto(`${site.origin}/plain-${name}`, { waitUntil: 'domcontentloaded' })
          assert.deepEqual(
            site.find(`/plain-${name}`).map((e) => e.signed),
            [false],
            `the ${name} slot goes out unsigned`
          )
          await driver2.detach()
          await plain.release()
        }
        // And once the signed slot is released, nothing of it is left to sign.
        await driver.detach()
        await signed.release()
        assert.ok(
          site.seen.filter((e) => e.signed).every((e) => e.verified),
          'nothing was signed that did not verify'
        )
        assert.ok(!pool.logs.join('\n').includes(JSON.parse(key.privateJwk).d), 'and the private key is in no log')
      } finally {
        site.server.close()
        other.server.close()
        hop.server.close()
        redirecting.server.close()
        sockets.close()
        await pool.close()
      }
    }
  )
}

test('a node set to always sign signs every slot, and cannot leave one unsigned', { skip: !enabled }, async () => {
  const key = generateSigningKey()
  const pool = await startBox({ webBotAuth: { mode: 'always', key: key.privateJwk } })
  const jwk = ((await (await fetch(`${pool.base}${DIRECTORY_PATH}`)).json()) as { keys: Array<Record<string, string>> })
    .keys[0]!
  const site = await verifyingSite(await verifierFromJWK(jwk as never))
  try {
    const slot = await pool.acquire('default') // asked nothing: the node's own setting signs it
    const driver = await connect(slot.cdpUrl, { headers: slot.headers })
    await driver.page.goto(`${site.origin}/always`, { waitUntil: 'domcontentloaded' })
    assert.deepEqual(
      site.find('/always').map((e) => [e.signed, e.verified]),
      [[true, true]]
    )
    await assert.rejects(
      pool.acquire('unsigned', { signRequests: false }),
      (error: Error) => error instanceof UnsupportedError && /No node offers unsigned requests/.test(error.message),
      'said at once, and no slot was made unsigned'
    )
    await driver.detach()
    await slot.release()
  } finally {
    site.server.close()
    await pool.close()
  }
})

test(
  'a node that signs with a key the relay does not publish is not given slots that ask to be signed',
  { skip: !enabled },
  async () => {
    const nodeKey = generateSigningKey()
    const relayKey = generateSigningKey()
    const pool = await startBox({
      webBotAuth: { mode: 'optional', key: nodeKey.privateJwk, relayKey: relayKey.privateJwk }
    })
    try {
      await assert.rejects(
        pool.acquire('signed', { signRequests: true }),
        (error: Error) =>
          error instanceof UnsupportedError && /signing with the key this relay publishes/.test(error.message),
        'its signatures would not verify against the directory this relay serves'
      )
      assert.equal(pool.relay.registry.listSlots().length, 0)
      // The node itself is fine for slots that do not ask.
      const plain = await pool.acquire('plain')
      await plain.release()
    } finally {
      await pool.close()
    }
  }
)

test(
  'a client that copies a request’s headers back on every request re-sends the previous hop’s signature on a redirect',
  { skip: !enabled },
  async () => {
    // The limit the guide names. The client's own interception sits closer to the network than the hub's, so a client that
    // replaces a request's whole header set wins, and on a redirect Playwright hands it the headers of the hop before. This test is
    // here so the guide stays true: if it starts to fail because the second hop verifies, the guide can say less.
    const key = generateSigningKey()
    const pool = await startBox({ webBotAuth: { mode: 'optional', key: key.privateJwk } })
    const jwk = (
      (await (await fetch(`${pool.base}${DIRECTORY_PATH}`)).json()) as { keys: Array<Record<string, string>> }
    ).keys[0]!
    const verifier = await verifierFromJWK(jwk as never)
    const hop = await verifyingSite(verifier)
    const redirecting = await verifyingSite(verifier, () => `${hop.origin}/landed`)
    try {
      const slot = await pool.acquire('copying', { signRequests: true })
      const driver = await connect(slot.cdpUrl, { headers: slot.headers })
      await driver.context.route('**/*', (route) =>
        route.continue({ headers: { ...route.request().headers(), 'x-from-client': '1' } })
      )
      await driver.page.goto(`${redirecting.origin}/redirect`, { waitUntil: 'domcontentloaded' })
      assert.deepEqual(
        redirecting.find('/redirect').map((e) => [e.signed, e.verified]),
        [[true, true]],
        'the first request is fine'
      )
      const [landed] = hop.find('/landed')
      assert.equal(landed?.signed, true)
      assert.equal(
        landed?.verified,
        false,
        'the redirect hop carries the first hop’s signature, which is for another host'
      )
      assert.equal(landed?.headers.signature, redirecting.find('/redirect')[0]!.headers.signature, 'the very same one')

      // Adding the header another way, the way that works, leaves every hop with its own.
      await driver.context.unroute('**/*')
      await driver.context.setExtraHTTPHeaders({ 'x-from-client': '1' })
      hop.seen.length = 0
      await driver.page.goto(`${redirecting.origin}/redirect`, { waitUntil: 'domcontentloaded' })
      assert.deepEqual(
        hop.find('/landed').map((e) => [e.signed, e.verified]),
        [[true, true]]
      )
      assert.equal(hop.find('/landed')[0]!.headers['x-from-client'], '1', 'and the client’s header is there too')
      await driver.detach()
      await slot.release()
    } finally {
      hop.server.close()
      redirecting.server.close()
      await pool.close()
    }
  }
)
