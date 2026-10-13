/**
 * Real-browser check of process isolation (`BROWSERBAY_ISOLATION=process`): `browserbay node` as a process with a Chromium
 * per slot, the relay, and the client a service uses. Needs `pnpm build`. Skipped unless PLAYWRIGHT_BROWSER_TESTS=1 (CI
 * has no Chromium). Run with: pnpm test:browser
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createBrowserBay } from '../src/client/index.js'
import { hashToken } from '../src/relay/registry.js'
import { createRelayServer } from '../src/relay/server.js'
import { enabled, removeProfile, serve, until } from './support.js'

const API_KEY = 'process-test-api-key-0123456789'
const SECRET = 'process-test-enrollment-secret'
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

/** The pids of the Chromium processes (browser and helpers) that were started with this profile directory. */
function pidsOf(profileDir: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', '--', `user-data-dir=${profileDir}`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}

async function startProcessBox() {
  const relay = createRelayServer({
    apiKey: API_KEY,
    enrollmentSecrets: [{ id: 'test', sha256: hashToken(SECRET) }],
    nodeTimeoutMs: 60_000
  })
  const port = await relay.listen(0, '127.0.0.1')
  const base = `http://127.0.0.1:${port}`
  const profileRoot = await mkdtemp(join(tmpdir(), 'browserbay-process-'))
  const stderr: string[] = []
  const node: ChildProcess = spawn(process.execPath, [CLI, 'node'], {
    env: {
      ...process.env,
      BROWSERBAY_RELAY_URL: base,
      BROWSERBAY_ENROLLMENT_SECRET: SECRET,
      BROWSERBAY_NODE_ID: 'node-1',
      BROWSERBAY_MAX_CONTEXTS: '3',
      BROWSERBAY_DRAIN_SECONDS: '1',
      BROWSERBAY_ISOLATION: 'process',
      BROWSERBAY_CHROMIUM_EXECUTABLE: chromium.executablePath(),
      BROWSERBAY_PROFILE_DIR: profileRoot
    },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  node.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  await until(() => relay.registry.listNodes().length === 1, 'the node to join', 30_000)
  const box = createBrowserBay({ url: base, apiKey: API_KEY })
  return {
    relay,
    box,
    profileRoot,
    stderr,
    slotDirs: () => readdirSync(profileRoot).sort(),
    async close() {
      if (node.exitCode === null) {
        const exited = new Promise((resolve) => node.once('exit', resolve))
        node.kill('SIGTERM')
        await exited
      }
      await relay.close()
      await removeProfile(profileRoot)
    }
  }
}

test(
  'process isolation: a Chromium per slot, with the browser-wide features a shared one withholds',
  { skip: !enabled },
  async () => {
    const pool = await startProcessBox()
    const { server, origin } = await serve()
    try {
      const a = await pool.box.acquire({ runId: 'run-a', maxLifetimeSeconds: 600, waitMs: 20_000 })
      const b = await pool.box.acquire({ runId: 'run-b', maxLifetimeSeconds: 600, waitMs: 20_000 })

      // Two slots, two Chromiums, each with a profile of its own.
      assert.deepEqual(pool.slotDirs(), [a.slotId, b.slotId].sort())
      const [pidsA, pidsB] = [pidsOf(join(pool.profileRoot, a.slotId)), pidsOf(join(pool.profileRoot, b.slotId))]
      assert.ok(pidsA.length > 0 && pidsB.length > 0)
      assert.ok(!pidsA.some((pid) => pidsB.includes(pid)), 'no process is shared')

      const browserA = await chromium.connectOverCDP(a.cdpUrl, { headers: a.headers })
      const browserB = await chromium.connectOverCDP(b.cdpUrl, { headers: b.headers })
      try {
        const contextA = browserA.contexts()[0]!
        const page = contextA.pages()[0] ?? (await contextA.newPage())
        await page.goto(`${origin}/?who=a`)
        await page.setContent('<h1 id="t">hello</h1>')

        // page.pdf() reads its result through the IO domain: refused on a shared browser, fine on a dedicated one.
        const pdf = await page.pdf()
        assert.equal(pdf.subarray(0, 4).toString(), '%PDF')

        // browser.newContext() makes a context of the slot's own, with its own cookies, and the slot sees its pages.
        const extra = await browserA.newContext()
        const extraPage = await extra.newPage()
        await extraPage.goto(`${origin}/?who=extra`)
        await extra.addCookies([{ name: 'k', value: 'v', url: origin }])
        assert.deepEqual(
          (await extra.cookies()).map((cookie) => cookie.name),
          ['k']
        )
        assert.deepEqual(await contextA.cookies(), [], 'the slot’s first context has none of them')
        assert.equal(browserA.contexts().length, 2)
        await extra.close()
        assert.equal(browserA.contexts().length, 1)

        // Browser-wide tracing works.
        await browserA.startTracing(page, { screenshots: false })
        await page.evaluate(() => 1 + 1)
        const trace = await browserA.stopTracing()
        assert.ok(trace.length > 0, 'a trace came back')

        // What protects the node's machine is unchanged: the slot is still held to the web.
        await assert.rejects(page.goto('file:///etc/passwd'))
        await assert.rejects(browserA.newBrowserCDPSession().then((cdp) => cdp.send('Browser.close' as never)))

        // The other slot is a different browser, which this one's contexts never touched.
        assert.equal(browserB.contexts().length, 1)
        assert.equal((await browserB.contexts()[0]!.cookies()).length, 0)
      } finally {
        await browserA.close()
        await browserB.close()
      }

      // Releasing a slot ends its Chromium and removes its profile; the other slot is untouched.
      await a.release()
      await until(() => !existsSync(join(pool.profileRoot, a.slotId)), 'the profile to be removed')
      await until(() => pidsOf(join(pool.profileRoot, a.slotId)).length === 0, 'its Chromium to end')
      assert.ok(pidsOf(join(pool.profileRoot, b.slotId)).length > 0)
      assert.equal(await b.isAlive(), true)
      await b.release()
      await until(() => pool.slotDirs().length === 0, 'every profile to be removed')
    } finally {
      server.close()
      await pool.close()
    }
  }
)

test(
  'process isolation: a slot’s browser crashing ends that slot only, and the node carries on',
  { skip: !enabled },
  async () => {
    const pool = await startProcessBox()
    try {
      const a = await pool.box.acquire({ runId: 'run-a', maxLifetimeSeconds: 600, waitMs: 20_000 })
      const b = await pool.box.acquire({ runId: 'run-b', maxLifetimeSeconds: 600, waitMs: 20_000 })
      const browserA = await chromium.connectOverCDP(a.cdpUrl, { headers: a.headers })
      const disconnected = new Promise<void>((resolve) => browserA.once('disconnected', () => resolve()))

      execFileSync('pkill', ['-9', '-f', '--', `user-data-dir=${join(pool.profileRoot, a.slotId)}`])
      await disconnected
      await until(
        () => !pool.relay.registry.listSlots().some((slot) => slot.slotId === a.slotId),
        'the relay to drop the slot'
      )
      assert.equal(await a.isAlive(), false)
      assert.equal(await b.isAlive(), true, 'the other slot never noticed')
      await until(() => !existsSync(join(pool.profileRoot, a.slotId)), 'the dead slot’s profile to be removed')

      // The node is still there: the next slot gets a fresh browser.
      const c = await pool.box.acquire({ runId: 'run-c', maxLifetimeSeconds: 600, waitMs: 20_000 })
      const browserC = await chromium.connectOverCDP(c.cdpUrl, { headers: c.headers })
      const page = await browserC.contexts()[0]!.newPage()
      await page.setContent('<p>fine</p>')
      await browserC.close()
      await c.release()
      await b.release()
    } finally {
      await pool.close()
    }
  }
)
