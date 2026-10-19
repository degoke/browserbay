/**
 * A virtual X display for a headful Chromium (`BROWSERBAY_HEADLESS=xvfb`).
 *
 * A headful browser has no `HeadlessChrome` in its user agent, a screen as large as its window, and none of the other
 * things headless mode announces. It needs a display, and a container has none, so the node starts an Xvfb for it.
 *
 *   - `-displayfd 3` has Xvfb pick a free display number and write it to a pipe, so there is no number to guess, no
 *     lock file to race over, and a pipe that says the server is ready.
 *   - The display is closed to everything but the browser. With no access control, any process in the same network
 *     namespace (a sidecar in a pod, another user on the host) can connect to Xvfb's abstract socket and watch or drive
 *     every page. So Xvfb is started with `-auth` on a file only this process can read, holding a random cookie, and
 *     Chromium is given the file through XAUTHORITY. The server only looks at the protocol name and the cookie in that
 *     file, so an entry for "any display" (family wild, no address, no number) is enough and the `xauth` tool is not needed.
 *   - `-nolisten tcp`: the display is reachable over a local socket only.
 *
 * With process isolation the node starts one per slot: a display is where the clipboard and the selection live, so slots
 * sharing one could paste into each other, and one Xvfb dying would take every slot with it.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { ConfigError } from '../protocol.js'

const u16 = (value: number) => Buffer.from([(value >> 8) & 0xff, value & 0xff])
const field = (bytes: Buffer) => Buffer.concat([u16(bytes.length), bytes])
const FAMILY_WILD = 0xffff

/** One entry of an Xauthority file: an MIT-MAGIC-COOKIE-1 for any display on any host. */
export function xauthorityEntry(cookie: Buffer): Buffer {
  return Buffer.concat([
    u16(FAMILY_WILD),
    field(Buffer.alloc(0)),
    field(Buffer.alloc(0)),
    field(Buffer.from('MIT-MAGIC-COOKIE-1')),
    field(cookie)
  ])
}

export interface XvfbOptions {
  /** Defaults to `Xvfb`, found through PATH. */
  executable?: string
  /** Defaults to 1920x1080x24: a common desktop, which is what a page's `screen` then reports. */
  screen?: string
  startTimeoutMs?: number
  stopGraceMs?: number
  /** For tests: how Xvfb is started. */
  spawnXvfb?: typeof spawn
}

export interface Xvfb {
  /** What DISPLAY says, such as `:0`. */
  display: string
  /** The file holding the cookie, for XAUTHORITY. */
  xauthority: string
  /** What a browser started on this display needs in its environment. */
  env: { DISPLAY: string; XAUTHORITY: string }
  /** Resolves, with why, when Xvfb is gone: also after `close()`, so a caller that did not ask for it checks. */
  exited: Promise<string>
  /** Stops Xvfb and removes its cookie file. Safe to call more than once. */
  close(): Promise<void>
}

export async function startXvfb(options: XvfbOptions = {}): Promise<Xvfb> {
  const {
    executable = 'Xvfb',
    screen = '1920x1080x24',
    startTimeoutMs = 8000,
    stopGraceMs = 2000,
    spawnXvfb = spawn
  } = options

  // X keeps its sockets in /tmp/.X11-unix whatever TMPDIR says. Xvfb makes the directory when it can, but an unprivileged
  // user cannot give it the sticky bit it wants, so make it here (a directory that exists and is not ours stays as it is).
  if (process.platform === 'linux') {
    await mkdir('/tmp/.X11-unix', { recursive: true, mode: 0o1777 }).catch(() => undefined)
    await chmod('/tmp/.X11-unix', 0o1777).catch(() => undefined)
  }

  const dir = await mkdtemp(join(tmpdir(), 'browserbay-xvfb-'))
  const xauthority = join(dir, 'Xauthority')
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined)
  await writeFile(xauthority, xauthorityEntry(randomBytes(16)), { mode: 0o600 })

  const child = spawnXvfb(
    executable,
    ['-displayfd', '3', '-auth', xauthority, '-screen', '0', screen, '-nolisten', 'tcp'],
    // fd 3 is where Xvfb reports its display number. Its stderr is kept for the message when it does not start.
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 4000) stderr += String(chunk)
  })
  let markExited: (reason: string) => void = () => undefined
  const exited = new Promise<string>((resolve) => (markExited = resolve))
  child.on('exit', (code, signal) => markExited(`exited (${signal ?? code})`))
  child.on('error', (error) => markExited(`could not start: ${error.message}`))

  let display: string
  try {
    display = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Xvfb did not report a display within ${Math.round(startTimeoutMs / 1000)} s`)),
        startTimeoutMs
      )
      const fail = (error: Error) => {
        clearTimeout(timer)
        reject(error)
      }
      let text = ''
      ;(child.stdio[3] as Readable).on('data', (chunk) => {
        text += String(chunk)
        const line = text.split('\n')
        const number = line[0]!.trim()
        if (line.length > 1 && /^\d+$/.test(number)) {
          clearTimeout(timer)
          resolve(`:${number}`)
        }
      })
      child.once('error', (error) =>
        fail(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? new ConfigError(
                'Xvfb was not found. Use the browserbay image, install xvfb, or set BROWSERBAY_HEADLESS to true or false.'
              )
            : error
        )
      )
      child.once('exit', (code, signal) => {
        const said = stderr.trim().split('\n').filter(Boolean).at(-1)
        fail(new Error(`Xvfb exited (${signal ?? code}) before it was ready${said ? `: ${said}` : ''}`))
      })
    })
  } catch (error) {
    child.kill('SIGKILL')
    await cleanup()
    throw error
  }

  return {
    display,
    xauthority,
    env: { DISPLAY: display, XAUTHORITY: xauthority },
    exited,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const hard = setTimeout(() => child.kill('SIGKILL'), stopGraceMs)
        hard.unref()
        await exited
        clearTimeout(hard)
      }
      await cleanup()
    }
  }
}
