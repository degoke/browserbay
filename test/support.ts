/**
 * Shared helpers for the real-browser tests (*.browser.test.ts). They are skipped unless PLAYWRIGHT_BROWSER_TESTS=1,
 * because CI has no Chromium; run them with `pnpm test:browser`.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { WebSocket } from 'ws'
import { startXvfb } from '../src/node/xvfb.js'

export const enabled = process.env.PLAYWRIGHT_BROWSER_TESTS === '1'

/**
 * The display the whole suite runs on: BROWSERBAY_HEADLESS=xvfb runs every node, and the Chromium of launchChromium, headful
 * on a virtual display, which is what the image ships. CI runs the suite once each way. The nodes the tests start are
 * child processes that inherit the variable.
 */
export const xvfb = process.env.BROWSERBAY_HEADLESS === 'xvfb'

/**
 * Removes a Chromium profile. A killed Chromium's helper processes (GPU, renderers) can still be writing into it for a
 * moment, so a plain recursive remove can fail with ENOTEMPTY: try again until they are gone.
 */
export const removeProfile = (path: string) =>
  rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })

export const PAGE = `<!doctype html><html><body style="margin:0">
<button id="b" style="position:absolute;left:100px;top:100px;width:200px;height:60px"
  onclick="document.getElementById('out').textContent = 'clicked'">Click me</button>
<input id="i" aria-label="Name" style="position:absolute;left:100px;top:200px;width:300px;height:40px">
<div id="out" style="position:absolute;left:100px;top:300px">idle</div>
</body></html>`

export function serve(handler?: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer(
      handler ??
        ((_request, response) => {
          response.writeHead(200, { 'content-type': 'text/html' })
          response.end(PAGE)
        })
    )
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
    )
  })
}

export async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000) {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

// ---- a bare DevTools client --------------------------------------------------------------------------------------

export interface RawMessage {
  id?: number
  method?: string
  params?: Record<string, any>
  sessionId?: string
  result?: Record<string, any>
  error?: { code: number; message: string }
}

/** A DevTools client without Playwright, so a test can say exactly what a watcher or a hostile client would. */
export function rawSocket(url: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(url, { perMessageDeflate: false, headers, maxPayload: 256 * 1024 * 1024 })
  let nextId = 1
  const waiting = new Map<number, (message: RawMessage) => void>()
  const events: RawMessage[] = []
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as RawMessage
    if (message.id !== undefined) waiting.get(message.id)?.(message)
    else events.push(message)
  })
  return {
    events,
    opened: new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    }),
    send: (method: string, params: object = {}, sessionId?: string) =>
      new Promise<RawMessage>((resolve) => {
        const id = nextId++
        waiting.set(id, resolve)
        socket.send(JSON.stringify({ id, method, params, sessionId }))
      }),
    /** Drops the connection without a goodbye, as a killed process would. */
    kill: () => socket.terminate(),
    close: () => socket.close()
  }
}

// ---- Chromium ----------------------------------------------------------------------------------------------------

/** A plain Chromium with a DevTools port on loopback: what a node wraps, for tests that drive the scope hub directly. */
export async function launchChromium() {
  const profile = await mkdtemp(join(tmpdir(), 'browserbay-test-'))
  const display = xvfb ? await startXvfb() : undefined
  const child: ChildProcess = spawn(
    chromium.executablePath(),
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      ...(display ? ['--ozone-platform=x11'] : ['--headless=new']),
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      'about:blank'
    ],
    { stdio: 'ignore', env: display ? { ...process.env, ...display.env } : process.env }
  )
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGKILL')
      await exited
    }
    await display?.close()
    await removeProfile(profile)
  }
  // Chromium picks its own free port and writes it, then the browser's DevTools path, to DevToolsActivePort.
  let webSocketDebuggerUrl = ''
  try {
    await until(
      async () => {
        try {
          const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')
          if (!port || !path) return false
          webSocketDebuggerUrl = `ws://127.0.0.1:${port}${path}`
          return true
        } catch {
          return false
        }
      },
      'Chromium to start',
      60_000
    )
  } catch (error) {
    // A Chromium that never came up is still running and still owns its profile: do not leave either behind.
    await stop()
    throw error
  }
  return { webSocketDebuggerUrl, stop }
}

// ---- driving a browser the way a client does -------------------------------------------------------------------

export interface Session {
  browser: Browser
  context: BrowserContext
  page: Page
  /** Disconnects, as a service does when it hands the browser to a person. The remote browser stays. */
  detach(): Promise<void>
}

/** The page a client left us on: the newest tab that is not blank. */
const activePage = (pages: Page[]) =>
  pages.filter((page) => page.url() && page.url() !== 'about:blank').at(-1) ?? pages.at(-1)

/**
 * Connects Playwright to a slot's endpoint. With `startUrl` it opens that page first (a new session); without it, it
 * reattaches to whatever the slot already shows.
 */
export async function connect(
  endpoint: string,
  options: {
    headers?: Record<string, string>
    startUrl?: string
    /** Runs on the context before the first navigation, as a service installs its request routing. */
    guard?: (context: BrowserContext) => Promise<unknown>
  } = {}
): Promise<Session> {
  const browser = await chromium.connectOverCDP(endpoint, {
    timeout: 20_000,
    ...(options.headers ? { headers: options.headers } : {})
  })
  const context = browser.contexts()[0] ?? (await browser.newContext())
  await options.guard?.(context)
  let page: Page
  if (options.startUrl) {
    page = context.pages()[0] ?? (await context.newPage())
    await page.goto(options.startUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  } else {
    page = activePage(context.pages()) ?? (await context.newPage())
  }
  return { browser, context, page, detach: () => browser.close().catch(() => undefined) }
}

// ---- watching a browser and taking over --------------------------------------------------------------------------

/**
 * A watcher: a second DevTools connection to a slot's browser that streams its screen and sends input, like a person
 * looking at a run and clicking in it. Only the page's own session is used, which is all a viewer needs.
 */
export async function watch(endpoint: string, headers?: Record<string, string>) {
  const raw = rawSocket(endpoint, headers)
  let sessionId = ''
  try {
    await raw.opened
    const { targetInfos } = (await raw.send('Target.getTargets')).result as {
      targetInfos: Array<{ targetId: string; type: string }>
    }
    const target = targetInfos.find((info) => info.type === 'page')
    assert.ok(target, 'the slot shows a page to watch')
    sessionId = (
      (await raw.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).result as {
        sessionId: string
      }
    ).sessionId
    await raw.send('Page.enable', {}, sessionId)
    await raw.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 900 }, sessionId)
  } catch (error) {
    raw.kill()
    throw error
  }

  const frames: Buffer[] = []
  let handled = 0
  const pump = setInterval(() => {
    for (; handled < raw.events.length; handled++) {
      const event = raw.events[handled]!
      if (event.method !== 'Page.screencastFrame' || event.sessionId !== sessionId) continue
      frames.push(Buffer.from(event.params!.data as string, 'base64'))
      void raw.send('Page.screencastFrameAck', { sessionId: event.params!.sessionId }, sessionId)
    }
  }, 20)
  pump.unref()

  const send = (method: string, params: object) => raw.send(method, params, sessionId)
  const click = async (x: number, y: number) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  return {
    frames,
    click,
    async type(text: string) {
      for (const key of text) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key })
      }
    },
    paste: (text: string) => send('Input.insertText', { text }),
    close() {
      clearInterval(pump)
      raw.close()
    }
  }
}

/**
 * The watch-drive-reattach scenario: a service opens a browser and steps away, a person watches it and drives it, and
 * the service comes back to the same browser and finds what they did. `endpoint` is a slot's DevTools address.
 */
export async function watchDriveReattach(endpoint: string, headers?: Record<string, string>) {
  const { server, origin } = await serve()
  try {
    // 1. The service opens the browser, then steps away.
    const first = await connect(endpoint, { headers, startUrl: origin })
    await first.detach()

    // 2. A person watches it: frames arrive, and they are JPEGs.
    const viewer = await watch(endpoint, headers)
    try {
      await until(() => viewer.frames.length > 0, 'the first frame')
      assert.deepEqual([...viewer.frames[0]!.subarray(0, 2)], [0xff, 0xd8], 'the frame is a JPEG')

      // 3. They click the button, then click the field and type and paste.
      await viewer.click(200, 130)
      await viewer.click(250, 220)
      await viewer.type('hi')
      await viewer.paste(' there')
    } finally {
      viewer.close()
    }

    // 4. The service comes back to the same browser and sees what they did.
    const second = await connect(endpoint, { headers })
    try {
      assert.equal(new URL(second.page.url()).origin, origin, 'the same page is there')
      await until(async () => (await second.page.textContent('#out')) === 'clicked', 'the click to land')
      await until(async () => (await second.page.inputValue('#i')) === 'hi there', 'the typing and paste to land')
    } finally {
      await second.detach()
    }
  } finally {
    server.close()
  }
}
