/**
 * Real-browser check of the whole box: node processes (`browserbox node`, with Node's built-in WebSocket client and real
 * Chromium), the relay, and the client a service uses. Then the all-in-one `browserbox start`, which needs `pnpm build`.
 * Skipped unless PLAYWRIGHT_BROWSER_TESTS=1 (CI has no Chromium). Run with: pnpm test:browser
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createBrowserBox, NoCapacityError, type Slot } from '../src/client/index.js'
import { hashToken } from '../src/relay/registry.js'
import { createRelayServer } from '../src/relay/server.js'
import { connect, enabled, serve, until, watch, watchDriveReattach } from './support.js'

const API_KEY = 'box-test-api-key-0123456789'
const SECRET = 'box-test-enrollment-secret'
const CLI = fileURLToPath(new URL('../bin/browserbox.mjs', import.meta.url))

/** A process of the CLI, with its stderr kept for when a test fails. */
function run(args: string[], env: Record<string, string>) {
  const stderr: string[] = []
  const stdout: string[] = []
  const child: ChildProcess = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  return {
    child,
    stderr,
    stdout,
    exited,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
        await exited
        clearTimeout(timer)
      }
    }
  }
}

/** A node: `browserbox node` as a process, with the real Chromium, exactly as the image would run it. */
async function startNode(relayUrl: string, executable: string, nodeId = 'node-1', secret = SECRET) {
  const profileDir = await mkdtemp(join(tmpdir(), 'browserbox-node-'))
  const node = run(['node'], {
    BROWSERBOX_RELAY_URL: relayUrl,
    BROWSERBOX_ENROLLMENT_SECRET: secret,
    BROWSERBOX_NODE_ID: nodeId,
    BROWSERBOX_MAX_CONTEXTS: '3',
    BROWSERBOX_DRAIN_SECONDS: '1',
    BROWSERBOX_CHROMIUM_EXECUTABLE: executable,
    BROWSERBOX_PROFILE_DIR: profileDir
  })
  return {
    ...node,
    profileDir,
    /** Kills only Chromium, as a crash would; the node notices and leaves. */
    crashBrowser: () => execFileSync('pkill', ['-9', '-f', '--', `user-data-dir=${profileDir}`]),
    async stop() {
      await node.stop()
      await rm(profileDir, { recursive: true, force: true })
    }
  }
}

async function startBox({ acquireWaitMs = 5000 }: { acquireWaitMs?: number } = {}) {
  const executable = chromium.executablePath()
  const relay = createRelayServer({
    apiKey: API_KEY,
    enrollmentSecrets: [{ id: 'test', sha256: hashToken(SECRET) }],
    nodeTimeoutMs: 60_000,
    ...(process.env.BROWSERBOX_TEST_SHOW_NODE_LOGS ? { logger: { info: console.log, warn: console.log } } : {})
  })
  const port = await relay.listen(0, '127.0.0.1')
  const base = `http://127.0.0.1:${port}`
  const nodes: Array<Awaited<ReturnType<typeof startNode>>> = []
  const addNode = async (nodeId: string) => {
    const node = await startNode(base, executable, nodeId)
    nodes.push(node)
    await until(() => relay.registry.listNodes().some((entry) => entry.nodeId === nodeId), `${nodeId} to join`, 60_000)
    return node
  }
  const box = createBrowserBox({ url: base, apiKey: API_KEY })
  const acquire = (runId: string) => box.acquire({ runId, maxLifetimeSeconds: 600, waitMs: acquireWaitMs })
  return {
    relay,
    base,
    box,
    acquire,
    addNode,
    async close() {
      for (const node of nodes) {
        await node.stop()
        // BROWSERBOX_TEST_SHOW_NODE_LOGS=1 shows what each node process said, for when a test fails.
        if (process.env.BROWSERBOX_TEST_SHOW_NODE_LOGS) console.log(`--- ${node.profileDir}\n${node.stderr.join('')}`)
      }
      await relay.close()
    }
  }
}

const driveEndpoint = (slot: Slot) => connect(slot.cdpUrl, { headers: slot.headers, startUrl: undefined })

test('watch, drive and reattach work through a slot: node process, relay and client', { skip: !enabled }, async () => {
  const pool = await startBox()
  try {
    await pool.addNode('node-1')
    const slot = await pool.acquire('run-scenario')
    assert.equal(slot.nodeId, 'node-1')
    assert.match(slot.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    await watchDriveReattach(slot.cdpUrl, slot.headers)
    await slot.release()
    await until(() => pool.relay.registry.listSlots().length === 0, 'the slot to be released')
  } finally {
    await pool.close()
  }
})

test('slots on one node are kept apart, and large results cross the whole path', { skip: !enabled }, async () => {
  const pool = await startBox()
  const { server, origin } = await serve()
  try {
    const node = await pool.addNode('node-1')
    const slotA = await pool.acquire('run-a')
    const slotB = await pool.acquire('run-b')
    const a = await connect(slotA.cdpUrl, { headers: slotA.headers, startUrl: `${origin}/?who=a` })
    const b = await connect(slotB.cdpUrl, { headers: slotB.headers, startUrl: `${origin}/?who=b` })
    assert.equal(pool.relay.registry.listNodes()[0]!.contexts, 2)

    assert.equal(a.context.pages().length, 1)
    assert.equal(new URL(b.page.url()).searchParams.get('who'), 'b')
    await a.context.addCookies([{ name: 'who', value: 'a', url: origin }])
    assert.deepEqual(await b.context.cookies(origin), [])

    // 20 MB in and out: the agent's built-in WebSocket client, the relay and Playwright all have to carry it.
    assert.equal(await a.page.evaluate(() => 'x'.repeat(20_000_000).length), 20_000_000)
    assert.equal((await b.page.evaluate(() => 'y'.repeat(20_000_000))).length, 20_000_000)

    // One slot's token opens that slot and nothing else.
    const wrongToken = { ...slotA.headers, 'x-browserbox-token': slotB.token }
    await assert.rejects(connect(slotA.cdpUrl, { headers: wrongToken }))

    await a.detach()
    await b.detach()
    await slotA.release()
    await slotB.release()
    await until(() => pool.relay.registry.listSlots().length === 0, 'both slots to be released')
    assert.equal(node.child.exitCode, null, 'the node is still up')
  } finally {
    server.close()
    await pool.close()
  }
})

test(
  'what a person watching costs: frames and bytes per second through node and relay',
  { skip: !enabled },
  async () => {
    const pool = await startBox()
    // A page that repaints every frame, which is the worst case for a screencast.
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<!doctype html><body style="margin:0"><canvas id="c" width="1280" height="900"></canvas><script>
      const ctx = document.getElementById('c').getContext('2d'); let n = 0;
      (function draw() { for (let i = 0; i < 40; i++) { ctx.fillStyle = 'hsl(' + ((n * 7 + i * 31) % 360) + ',70%,50%)'; ctx.fillRect((i * 97 + n * 13) % 1280, (i * 53) % 900, 200, 120) } n++; requestAnimationFrame(draw) })()
    </script></body>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      await pool.addNode('node-1')
      const slot = await pool.acquire('run-watched')
      const driver = await connect(slot.cdpUrl, { headers: slot.headers, startUrl: origin })
      await driver.detach()

      const viewer = await watch(slot.cdpUrl, slot.headers)
      await until(() => viewer.frames.length > 0, 'the first frame')
      const seconds = 5
      const startFrames = viewer.frames.length
      const startBytes = viewer.frames.reduce((sum, frame) => sum + frame.length, 0)
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
      const frames = viewer.frames.length - startFrames
      const bytes = viewer.frames.reduce((sum, frame) => sum + frame.length, 0) - startBytes
      console.log(
        `watching a slot (loopback, worst-case canvas): ${(frames / seconds).toFixed(1)} frames/s, ` +
          `${(bytes / seconds / 1024).toFixed(0)} KiB/s, ${(bytes / Math.max(frames, 1) / 1024).toFixed(0)} KiB/frame`
      )
      assert.ok(frames >= seconds, 'frames kept flowing')
      viewer.close()
      await slot.release()
    } finally {
      server.close()
      await pool.close()
    }
  }
)

test(
  'when a node’s browser dies its slots are noticed, and the next acquire gets a fresh browser elsewhere',
  { skip: !enabled },
  async () => {
    const pool = await startBox({ acquireWaitMs: 300 })
    const { server, origin } = await serve()
    try {
      const first = await pool.addNode('node-1')
      const slot = await pool.acquire('run-crash')
      const session = await connect(slot.cdpUrl, { headers: slot.headers, startUrl: origin })
      await session.detach()
      assert.equal(await slot.isAlive(), true, 'reachable before the crash')

      first.crashBrowser()
      assert.notEqual(await first.exited, 0, 'the node leaves when its browser does, so the platform restarts it')
      await until(async () => !(await slot.isAlive()), 'the slot to be reported unreachable', 20_000)

      // With no node left there is nowhere to put a replacement: the caller is told so, not left hanging.
      await assert.rejects(pool.acquire('run-crash'), NoCapacityError)

      // A node comes back (the restart policy): the same work is given a fresh browser.
      await pool.addNode('node-2')
      const again = await pool.acquire('run-crash')
      const fresh = await driveEndpoint(again)
      assert.equal(await fresh.page.evaluate(() => 1 + 1), 2)
      await fresh.detach()
      await again.release()
    } finally {
      server.close()
      await pool.close()
    }
  }
)

test(
  'browserbox start: relay and node in one process, with remote nodes able to join it',
  { skip: !enabled },
  async () => {
    const executable = chromium.executablePath()
    const port = await freePort()
    const remoteSecret = randomBytes(24).toString('base64url')
    const profileDir = await mkdtemp(join(tmpdir(), 'browserbox-start-'))
    const box = run(['start'], {
      PORT: String(port),
      BROWSERBOX_API_KEY: API_KEY,
      BROWSERBOX_ENROLLMENT_SECRETS: `remote:${createHash('sha256').update(remoteSecret).digest('hex')}`,
      BROWSERBOX_NODE_ID: 'local-node',
      BROWSERBOX_MAX_CONTEXTS: '2',
      BROWSERBOX_DRAIN_SECONDS: '1',
      BROWSERBOX_CHROMIUM_EXECUTABLE: executable,
      BROWSERBOX_PROFILE_DIR: profileDir
    })
    const url = `http://127.0.0.1:${port}`
    const client = createBrowserBox({ url, apiKey: API_KEY })
    const { server, origin } = await serve()
    let remote: Awaited<ReturnType<typeof startNode>> | undefined
    try {
      await until(
        async () => (await client.nodes().catch(() => [])).some((node) => node.nodeId === 'local-node'),
        'the box’s own node to join',
        60_000
      )
      assert.equal((await fetch(`${url}/health`)).status, 200)
      assert.equal((await fetch(`${url}/v1/nodes`)).status, 401, 'the listing needs the API key')

      const slot = await client.acquire({ runId: 'run-start', maxLifetimeSeconds: 600 })
      const session = await connect(slot.cdpUrl, { headers: slot.headers, startUrl: origin })
      assert.equal(await session.page.textContent('#out'), 'idle')
      await session.detach()
      await slot.release()

      // Capacity can be added later: a node somewhere else dials the same box with its own enrollment secret.
      remote = await startNode(url, executable, 'remote-node', remoteSecret)
      await until(async () => (await client.nodes()).length === 2, 'the remote node to join', 60_000)

      box.child.kill('SIGTERM')
      assert.equal(await box.exited, 0, `the box stops cleanly on SIGTERM\n${box.stderr.join('')}`)
    } finally {
      server.close()
      await remote?.stop()
      await box.stop()
      await rm(profileDir, { recursive: true, force: true })
    }
  }
)

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}
