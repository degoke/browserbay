/**
 * Keeping a session between runs, against real Chromium and the whole path (client, relay, node): a cookie a site set in one
 * slot, and what its page stored, can be taken out with an ordinary DevTools driver and put into another slot, and a slot that
 * is revived by its stored handle still has it. No box API is involved: cookies are the slot's own, reached through the calls a
 * driver already makes. The guide "Avoid bot blocks" tells people to do exactly this. Skipped unless PLAYWRIGHT_BROWSER_TESTS=1.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect, enabled, serve, startBox } from './support.js'

const SESSION = 'session-cookie-value-1234'

/** A site that signs a visitor in with an HttpOnly cookie, and shows what cookie each request carried. */
async function site() {
  const seen: Array<{ path: string; cookie?: string }> = []
  const { server, origin } = await serve((request, response) => {
    const path = new URL(request.url ?? '/', 'http://site').pathname
    seen.push({ path, cookie: request.headers.cookie })
    response.writeHead(200, {
      'content-type': 'text/html',
      ...(path === '/login' ? { 'set-cookie': `sid=${SESSION}; Path=/; HttpOnly; Max-Age=3600` } : {})
    })
    response.end(`<!doctype html><title>${path}</title>${path}`)
  })
  return { server, origin, seen }
}

for (const isolation of ['context', 'process'] as const) {
  test(
    `a session moves from one slot to another with a driver's own cookie calls: ${isolation} isolation`,
    { skip: !enabled },
    async () => {
      const pool = await startBox({ isolation })
      const { server, origin, seen } = await site()
      try {
        // Run 1: sign in (an HttpOnly cookie the page cannot read) and keep something in localStorage.
        const first = await pool.acquire('run-1')
        const one = await connect(first.cdpUrl, { headers: first.headers, startUrl: `${origin}/login` })
        await one.page.evaluate(() => localStorage.setItem('token', 'kept-in-storage'))
        const cookies = await one.context.cookies()
        const storage = await one.page.evaluate(() => ({ ...localStorage }))
        assert.ok(
          cookies.some((cookie) => cookie.name === 'sid' && cookie.httpOnly),
          'the HttpOnly cookie is exported'
        )
        assert.equal(await one.page.evaluate(() => document.cookie), '', 'the page itself cannot read it')
        await one.detach()
        await first.release()

        // Run 2: a new slot, a new browser context, none of it known. The driver puts the session back before the first request.
        const second = await pool.acquire('run-2')
        const two = await connect(second.cdpUrl, { headers: second.headers })
        await two.context.addCookies(cookies)
        await two.context.addInitScript(
          ([at, values]) => {
            if (location.origin === at)
              for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
          },
          [origin, storage] as const
        )
        seen.length = 0
        await two.page.goto(`${origin}/account`, { waitUntil: 'domcontentloaded' })
        assert.equal(seen[0]?.cookie, `sid=${SESSION}`, 'the site sees the session on the very first request')
        assert.equal(await two.page.evaluate(() => localStorage.getItem('token')), 'kept-in-storage')

        // A slot nobody gave the session to is a stranger, though it is on the same node.
        const stranger = await pool.acquire('run-3')
        const three = await connect(stranger.cdpUrl, { headers: stranger.headers, startUrl: `${origin}/account` })
        assert.equal(seen.at(-1)?.cookie, undefined, 'no cookie for a slot that was not given one')
        assert.equal(await three.page.evaluate(() => localStorage.getItem('token')), null)

        await two.detach()
        await three.detach()
        await second.release()
        await stranger.release()
      } finally {
        server.close()
        await pool.close()
      }
    }
  )

  test(
    `a slot revived from its stored handle still holds its session: ${isolation} isolation`,
    { skip: !enabled },
    async () => {
      const pool = await startBox({ isolation })
      const { server, origin, seen } = await site()
      try {
        const slot = await pool.acquire('run-1')
        const driver = await connect(slot.cdpUrl, { headers: slot.headers, startUrl: `${origin}/login` })
        await driver.detach() // the service steps away: the browser stays

        // Later, possibly in another process: the stored handle is all that is kept.
        const revived = pool.box.slot(JSON.parse(JSON.stringify(slot)))
        assert.equal(await revived.isAlive(), true)
        const back = await connect(revived.cdpUrl, { headers: revived.headers })
        assert.ok((await back.context.cookies()).some((cookie) => cookie.name === 'sid' && cookie.value === SESSION))
        seen.length = 0
        const page = await back.context.newPage()
        await page.goto(`${origin}/account`, { waitUntil: 'domcontentloaded' })
        assert.equal(seen[0]?.cookie, `sid=${SESSION}`)
        await back.detach()
        await revived.release()
      } finally {
        server.close()
        await pool.close()
      }
    }
  )
}
