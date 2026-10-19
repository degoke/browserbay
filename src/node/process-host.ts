/**
 * Process isolation: one Chromium per slot, in place of one shared Chromium with a BrowserContext per slot
 * (`BROWSERBAY_ISOLATION=process`).
 *
 * Each slot gets its own Chromium with its own profile directory, started when the slot is created and killed, with its
 * directory removed, when the slot is released, expires, or its browser dies. Slots no longer share a browser process, so
 * one slot's crash or runaway page takes only that slot with it, and a client of a slot holds a whole browser: the
 * browser-wide DevTools domains and `browser.newContext()` work (see `dedicated` in scope.ts). What the slot's client may
 * ask of the machine (no file: pages, no file paths into a page, no downloads) is fenced exactly as on a shared browser.
 *
 * The price is memory and start-up: a Chromium is a few hundred MB and about a second to start, so size
 * BROWSERBAY_MAX_CONTEXTS (here: the number of Chromium processes) for it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { errorMessage } from '../errors.js'
import type { SlotOptions } from '../protocol.js'
import { parseNodeSlotOptions, SlotRefusedError } from '../slot-options.js'
import { chromiumArgs, chromiumEnv, slotBrowser, type Display } from './chromium.js'
import { createPipeUpstream } from './pipe-upstream.js'
import { runContext, startProxyForwarder, type ProxyForwarder, type ProxyForwarderOptions } from './proxy-forwarder.js'
import { createCdpScope, type CdpScope, type RunHost, type ScopeLogger } from './scope.js'
import { startXvfb, type Xvfb, type XvfbOptions } from './xvfb.js'

/** The relay gives a node 15 s to confirm a new slot; a browser that is not up well before that is not worth waiting for. */
const START_TIMEOUT_MS = 12_000
const STOP_GRACE_MS = 3000
/** A slot id becomes a directory name: only what the relay generates (`s` and hex), never a path. */
const SLOT_KEY = /^[\w-]{1,100}$/
/** What the relay names a slot (`s` and 24 hex digits): the only directories under a profile root that are ours to remove. */
const RELAY_SLOT_ID = /^s[0-9a-f]{24}$/

/**
 * Removes the per-slot profile directories a node that was killed left under its profile root. Call it before the node
 * takes slots: nothing under the root can be live then, and slot ids are random, so they would otherwise pile up.
 */
export async function removeStaleProfiles(profileRoot: string) {
  const entries = await readdir(profileRoot).catch(() => [] as string[])
  await Promise.all(
    entries
      .filter((name) => RELAY_SLOT_ID.test(name))
      .map((name) =>
        rm(join(profileRoot, name), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(
          () => undefined
        )
      )
  )
}

export interface ProcessHostOptions {
  executable: string
  /** With `xvfb`, each slot gets a virtual display of its own, ended with it. */
  display?: Display
  hideWebdriver?: boolean
  sandbox?: boolean
  /** A directory to make each slot's profile in (as `<dir>/<slot id>`). A fresh temporary directory per slot when omitted. */
  profileRoot?: string
  startTimeoutMs?: number
  stopGraceMs?: number
  logger?: ScopeLogger & { info?(message: string, fields?: Record<string, unknown>): void }
  /** For tests: how a browser is started. */
  spawnChromium?: typeof spawn
  /** For tests: how Xvfb is found and started. */
  xvfb?: XvfbOptions
  /** For tests: how a slot's proxy forwarder is started and what it may connect to. */
  forwarder?: ProxyForwarderOptions & { start?: typeof startProxyForwarder }
}

export interface ProcessHost extends Omit<RunHost, 'onRunEnded'> {
  onRunEnded(listener: (runKey: string, reason: string) => void): void
  /** How many slots have a browser (or are getting one). */
  size(): number
  /** Ends every slot's browser. */
  close(): Promise<void>
}

interface Slot {
  child: ChildProcess
  scope: CdpScope
  /** The slot's own virtual display, when the node runs on `xvfb`. */
  xvfb?: Xvfb
  /** The slot's proxy, as the browser reaches it, when the slot asked for one. */
  forwarder?: ProxyForwarder
  profileDir: string
  /** Set once the browser answered and its context exists: only then is it a slot the node reports, and can lose. */
  ready: boolean
  /** We are ending it ourselves: its exit is expected and nothing is told about it. */
  stopping: boolean
  exited: Promise<void>
  /** Why the browser ended, when it was not us. */
  endedBecause?: string
}

export function createProcessHost(options: ProcessHostOptions): ProcessHost {
  const {
    executable,
    display = 'headless',
    hideWebdriver = true,
    sandbox = false,
    profileRoot,
    startTimeoutMs = START_TIMEOUT_MS,
    stopGraceMs = STOP_GRACE_MS,
    logger = {},
    spawnChromium = spawn
  } = options
  const slots = new Map<string, Slot>()
  /** Keys whose browser is still being started: reserved at once, so two creates for one key cannot both pass the check. */
  const creating = new Set<string>()
  const listeners = new Set<(runKey: string, reason: string) => void>()

  async function makeProfileDir(runKey: string) {
    if (!profileRoot) return mkdtemp(join(tmpdir(), 'browserbay-profile-'))
    const dir = join(profileRoot, runKey)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /** A killed Chromium's helper processes can still be writing into its profile for a moment, so retry the removal. */
  const removeProfile = (dir: string) =>
    rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined)

  /** Where the zone database is, when this system has one: a TZ that is not a file in it would silently be UTC. */
  const ZONEINFO = '/usr/share/zoneinfo'

  async function createRun(runKey: string, requested?: SlotOptions) {
    if (!SLOT_KEY.test(runKey)) throw new Error('Not a valid slot id')
    if (slots.has(runKey) || creating.has(runKey)) throw new Error('This slot already has a browser')
    const asked = parseNodeSlotOptions(requested)
    if (!asked.ok) throw new SlotRefusedError(asked.message)
    if (asked.value.timezone && existsSync(ZONEINFO) && !existsSync(join(ZONEINFO, asked.value.timezone))) {
      throw new SlotRefusedError('This node does not have that time zone')
    }
    creating.add(runKey)
    try {
      return await startSlot(runKey, asked.value)
    } finally {
      creating.delete(runKey)
    }
  }

  async function startSlot(runKey: string, requested: SlotOptions) {
    const profileDir = await makeProfileDir(runKey)
    const began = Date.now()
    let xvfb: Xvfb | undefined
    let forwarder: ProxyForwarder | undefined
    /** What exists before the browser does, ended when the browser cannot be made. */
    const undo = async () => {
      await forwarder?.close()
      await xvfb?.close()
      await removeProfile(profileDir)
    }
    let child: ChildProcess
    try {
      if (display === 'xvfb') {
        xvfb = await startXvfb({
          ...options.xvfb,
          startTimeoutMs: Math.min(options.xvfb?.startTimeoutMs ?? 8000, startTimeoutMs)
        })
      }
      if (requested.proxy) {
        const { start = startProxyForwarder, ...forwarderOptions } = options.forwarder ?? {}
        forwarder = await start(requested.proxy, { logger, ...forwarderOptions })
      }
      const browser = slotBrowser({
        proxied: Boolean(requested.proxy),
        timezone: requested.timezone,
        locale: requested.locale
      })
      // DevTools over a pipe (fds 3 and 4): no port, and no size limit on a screenshot or an evaluate result.
      child = spawnChromium(
        executable,
        chromiumArgs({ profileDir, display, sandbox, hideWebdriver, extraArgs: browser.args }),
        {
          stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'],
          // Not the node's own environment: it holds this box's secrets, and pages the browser runs are not trusted with them.
          env: chromiumEnv(process.env, { ...xvfb?.env, ...browser.env })
        }
      )
    } catch (error) {
      await undo()
      throw error
    }
    let pipe: ReturnType<typeof createPipeUpstream> | undefined
    const scope = createCdpScope({ upstream: { send: (text) => pipe?.send(text) }, logger, dedicated: true })
    let markExited: () => void = () => undefined
    const exited = new Promise<void>((resolve) => (markExited = resolve))
    const slot: Slot = { child, scope, xvfb, forwarder, profileDir, ready: false, stopping: false, exited }
    slots.set(runKey, slot)

    const gone = (reason: string) => {
      scope.onUpstreamClosed()
      if (slot.stopping) return
      // The first reason is the cause: a display that dies is reported as that, not as the browser it took with it.
      slot.endedBecause ??= reason
      const why = slot.endedBecause
      // Not yet a slot anyone was told about: createRun is failing and cleans up after itself.
      if (!slot.ready) return
      logger.warn?.('A slot’s browser ended on its own', { slotId: runKey, reason: why })
      void forget(runKey).then(() => {
        for (const listener of [...listeners]) listener(runKey, `its browser ended (${why})`)
      })
    }
    // `exited` is the process itself being gone (its profile can be removed), which the pipe closing does not prove.
    child.on('exit', (code, signal) => {
      markExited()
      gone(`Chromium exited (${signal ?? code})`)
    })
    child.on('error', (error) => {
      markExited()
      gone(`Chromium could not start: ${error.message}`)
    })
    pipe = createPipeUpstream({
      input: child.stdio[4] as Readable,
      output: child.stdio[3] as Writable,
      onMessage: (text) => scope.onUpstreamMessage(text),
      onClose: () => gone('The DevTools pipe closed')
    })
    // A browser cannot outlive its display: end it now rather than leave a slot that looks up and answers nothing.
    void xvfb?.exited.then((why) => {
      if (slot.stopping) return
      slot.endedBecause ??= `Xvfb ${why}`
      child.kill('SIGKILL')
    })

    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        scope.start().then(() => scope.createRun(runKey, runContext(forwarder, requested.proxy))),
        new Promise<never>((_, reject) => {
          // Starting the display took part of the time the relay gives a slot.
          const left = Math.max(1000, startTimeoutMs - (Date.now() - began))
          timer = setTimeout(() => reject(new Error('Chromium did not answer on its DevTools pipe')), left)
        })
      ])
      slot.ready = true
    } catch (error) {
      const reason = slot.endedBecause ?? errorMessage(error)
      await forget(runKey)
      throw new Error(reason)
    } finally {
      clearTimeout(timer)
    }
    return { slotId: runKey }
  }

  /** Ends a slot's browser and removes its profile. Safe to call more than once, and while the browser is dying. */
  async function forget(runKey: string) {
    const slot = slots.get(runKey)
    if (!slot) return
    slots.delete(runKey)
    slot.stopping = true
    await slot.scope.disposeRun(runKey).catch(() => undefined)
    if (slot.child.exitCode === null && slot.child.signalCode === null) {
      slot.child.kill('SIGTERM')
      const hard = setTimeout(() => slot.child.kill('SIGKILL'), stopGraceMs)
      hard.unref()
      await slot.exited
      clearTimeout(hard)
    }
    await slot.forwarder?.close()
    await slot.xvfb?.close()
    await removeProfile(slot.profileDir)
  }

  return {
    createRun,
    disposeRun: forget,
    connect(runKey, transport) {
      const slot = slots.get(runKey)
      if (!slot?.ready) throw new Error('Unknown slot')
      return slot.scope.connect(runKey, transport)
    },
    onRunEnded(listener) {
      listeners.add(listener)
    },
    size: () => slots.size,
    async close() {
      await Promise.all([...slots.keys()].map((runKey) => forget(runKey)))
    }
  }
}
