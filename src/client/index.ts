/**
 * The browserbay client: how your service gets a browser from a box.
 *
 *   const box = createBrowserBay({ url: 'https://browsers.example.com', apiKey })
 *   const slot = await box.acquire({ runId: 'task-42', maxLifetimeSeconds: 1800 })
 *   const browser = await chromium.connectOverCDP(slot.cdpUrl, { headers: slot.headers })   // Playwright, Puppeteer, ...
 *   ...
 *   await slot.release()
 *
 * No dependencies beyond the protocol constants, so it can be installed straight from git and used from any Node project.
 */
import { errorMessage } from '../errors.js'
import {
  NAME_PATTERN,
  RELAY_PATHS,
  SLOT_LIMITS,
  TOKEN_HEADER,
  type CreateSlotRequest,
  type CreateSlotResponse,
  type NodeSummary,
  type ProxySettings,
  type SlotSummary
} from '../protocol.js'

export type { NodeSummary, ProxySettings, SlotSummary }

export interface BrowserBayOptions {
  /** The box's base URL, e.g. https://browsers.example.com. A path prefix is kept. */
  url: string
  /** The box's API key: lets this service create, list and release browsers. It never reaches a browser. */
  apiKey: string
  /**
   * Marks this service's slots (as a prefix on their run ids) so `list` and `reap` leave another service's alone when
   * several share a box. Letters, digits, `_`, `.` and `-` only. On its own a naming convention, not an access control:
   * anything holding an unrestricted API key can still reach any slot. Give each service its own key confined to its
   * namespace on the box (`BROWSERBAY_API_KEYS`) and the box enforces it.
   */
  namespace?: string
  /**
   * Which boxes other than this client's a stored slot (`box.slot(stored)`, `box.release(id, { url })`) may name. None by
   * default: the API key and slot tokens are sent to the box a slot names, so an address read back from storage that
   * someone else could have written would be somewhere to send them. List the boxes your slots may have been made on
   * (the address your service used before it moved, say). Addresses are compared however they are spelled. `true` allows
   * any address, which is only safe for storage nobody else can write.
   */
  allowOtherBoxes?: boolean | string[]
  logger?: { warn?(message: string, fields?: Record<string, unknown>): void }
  fetch?: typeof fetch
  now?: () => number
  /** The pause between `isAlive`'s two asks. Default 300; tests set 0. */
  retryDelayMs?: number
}

export interface AcquireOptions {
  /** Your own id for what the browser is for (a run, a task, a job), up to 200 characters with the namespace. `list` and `reap` hand it back to you. */
  runId: string
  /** The browser's node closes it after this long, whether or not anyone is still connected. 60 to 86400. */
  maxLifetimeSeconds: number
  /** How long to wait for a free slot before giving up with a `NoCapacityError`, in whole milliseconds (0 means do not wait). The box caps it at its own maximum. Default 30000. */
  waitMs?: number
  /**
   * Send the slot's traffic through this proxy (`http://`, `https://` or `socks5://`, with `host:port`). The credentials stay
   * on the box's node, which reaches the proxy for the browser: the browser never holds them and a page cannot read them.
   * Throws `UnsupportedError` if no node of the box can do this.
   */
  proxy?: ProxySettings
  /** The IANA time zone the slot's browser runs in, such as `Europe/Berlin`. Only a box whose nodes run `BROWSERBAY_ISOLATION=process` can. */
  timezone?: string
  /** The slot's browser language, such as `de-DE`: its `navigator.language` and `Accept-Language`. Only a box whose nodes run `BROWSERBAY_ISOLATION=process` can. */
  locale?: string
  /** Only place the slot on a node that carries every one of these labels (`BROWSERBAY_NODE_LABELS` on the node). */
  nodeLabels?: string[]
}

/** The part of a slot worth keeping to come back to it later (`box.slot(stored)`). It contains the slot token: store it like a secret. */
export interface StoredSlot {
  slotId: string
  token: string
  /** The box the slot is on. Defaults to this client's box. */
  url?: string
  nodeId?: string
}

/** One isolated browser (a browser context on whichever node had room) and how to reach it. */
export interface Slot {
  readonly url: string
  readonly slotId: string
  readonly nodeId?: string
  /** Reaches this slot's browser and nothing else. Treat it as a secret. */
  readonly token: string
  /** The DevTools endpoint to hand to Playwright's or Puppeteer's connect, together with `headers`. */
  readonly cdpUrl: string
  /** The headers every DevTools connection to this slot must carry. A fresh object each time. */
  readonly headers: Record<string, string>
  /** True while the slot's browser is reachable. Never throws: a box that cannot be asked counts as "not alive". */
  isAlive(): Promise<boolean>
  /** Closes the browser. Safe to call for one that is already gone. */
  release(): Promise<void>
  /** The `StoredSlot` for this slot, so `JSON.stringify(slot)` is what to persist. */
  toJSON(): StoredSlot
}

export interface ReapOptions {
  /** Says whether the thing a slot was acquired for (its run id, without the namespace) still needs its browser. */
  isLive(runId: string): Promise<boolean>
  /** A slot younger than this is never reaped. Default 180000. */
  graceMs?: number
  /** Run ids that nothing can vouch for (and that close themselves at their lifetime), which are left alone. */
  skip?(runId: string): boolean
}

export interface BrowserBay {
  /**
   * Takes a browser. Throws `NoCapacityError` when the box stays full for the whole wait, `QuotaExceededError` when the key's
   * quota is used up, and `ForbiddenError` when the key may not use this run id (it is confined to another namespace).
   * Throws `UnsupportedError` when options were asked for and the box cannot give them: no node can do it, or the box is
   * older than the options and would have made a plain browser. A browser the box made without what was asked for is
   * released before the error is thrown.
   */
  acquire(options: AcquireOptions): Promise<Slot>
  /** A slot you stored earlier. Makes no request; use `isAlive()` to find out whether it still exists. */
  slot(stored: StoredSlot): Slot
  /** Releases a slot by its id, for when you no longer hold its token (a stored handle you cannot decrypt, an orphan found by `list`). Idempotent. */
  release(slotId: string, options?: { url?: string }): Promise<void>
  /** This service's slots (all of them, or only those in the namespace, with the namespace removed from their run ids). */
  list(): Promise<SlotSummary[]>
  nodes(): Promise<NodeSummary[]>
  /** Releases slots whose run `isLive` says no to, for when a crash lost track of them. Returns how many were released. */
  reap(options: ReapOptions): Promise<number>
}

/** Longer than the relay's own wait, so a full box is answered with 503 and not cut off by this side's timer. */
const ACQUIRE_TIMEOUT_MARGIN_MS = 20_000
const LOOKUP_TIMEOUT_MS = 3000
const RELEASE_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 15_000
/** Between the two asks of `isAlive`: long enough for a blip to pass, short enough not to be felt. */
const RETRY_DELAY_MS = 300

export class BrowserBayError extends Error {
  /** The HTTP status the box answered with, when it answered. */
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'BrowserBayError'
    this.status = status
  }
}

/** The box has no browser to give: every node is full, or none is connected. */
export class NoCapacityError extends BrowserBayError {
  constructor() {
    super('No browser capacity is available right now', 503)
    this.name = 'NoCapacityError'
  }
}

/** The box's API key is valid but may not do this: a run id outside the key's namespace, or the node list. */
export class ForbiddenError extends BrowserBayError {
  constructor() {
    super(
      "The API key is not allowed to do this. A key confined to a namespace can only use run ids in it (set the client's `namespace` to match) and cannot list nodes",
      403
    )
    this.name = 'ForbiddenError'
  }
}

/** The API key's namespace already holds as many browsers as its quota allows. Release one, or ask the box's operator. */
export class QuotaExceededError extends BrowserBayError {
  constructor() {
    super("This API key's quota of browsers is used up", 429)
    this.name = 'QuotaExceededError'
  }
}

/**
 * The box cannot give what `acquire` asked for (a proxy, a time zone, a language, a node label): no node it has can, or the
 * box is older than the option and would have answered with a plain browser, which here is a browser that goes out from the
 * box's own address. Nothing is left running: a browser made without it is released first.
 */
export class UnsupportedError extends BrowserBayError {
  constructor(message: string, status?: number) {
    super(message, status)
    this.name = 'UnsupportedError'
  }
}

const trimSlashes = (value: string) => value.replace(/\/+$/, '')

/** The box's CDP socket for a slot: the box's own address with the scheme swapped and any path prefix kept. */
function cdpUrlFor(boxUrl: string, slotId: string) {
  const url = new URL(boxUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${RELAY_PATHS.cdp(encodeURIComponent(slotId))}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function assertBoxUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`The browserbay URL is not a URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('The browserbay URL must be http(s)://, e.g. https://browsers.example.com')
  }
  return trimSlashes(value)
}

export function createBrowserBay(options: BrowserBayOptions): BrowserBay {
  const boxUrl = assertBoxUrl(options.url)
  if (!options.apiKey) throw new TypeError('createBrowserBay needs an apiKey')
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS
  const logger = options.logger ?? {}
  // A ':' would let namespace `app` see and reap the slots of `app:staging`, which is the one thing a namespace is for.
  if (options.namespace && !NAME_PATTERN.test(options.namespace)) {
    throw new TypeError('A namespace may only contain letters, digits, "_", "." and "-"')
  }
  const namespacePrefix = options.namespace ? `${options.namespace}:` : undefined

  /** The same address however it is spelled: scheme and host in lower case, a default port dropped, no trailing slash. */
  const canonical = (value: string) => trimSlashes(new URL(value).href)
  const ownBox = canonical(boxUrl)
  // Other boxes a stored slot may name (a box that moved while slots were live): listed, so each is checked up front.
  const otherBoxes = new Set(
    Array.isArray(options.allowOtherBoxes) ? options.allowOtherBoxes.map((url) => canonical(assertBoxUrl(url))) : []
  )

  /**
   * The box a slot lives on. The API key (to release) and the slot token (to look it up) are sent there, so an address
   * read back from storage is only used when it is this client's own box or one `allowOtherBoxes` lists (`true` allows
   * any address, for storage nobody else can write).
   */
  function boxOf(url: string | undefined) {
    if (url === undefined) return boxUrl
    const base = assertBoxUrl(url)
    const known = canonical(base)
    if (known !== ownBox && options.allowOtherBoxes !== true && !otherBoxes.has(known)) {
      throw new TypeError(
        `This slot is on ${new URL(base).origin}, not on this client's box (${new URL(boxUrl).origin}). ` +
          'Its credentials are only sent to the box this client was made for or one listed in allowOtherBoxes.'
      )
    }
    return base
  }

  /** A call to the box as its owner (create, list, release). The address is a parameter: a stored slot names its own. */
  function api(base: string, path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return doFetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
  }

  async function deleteSlot(base: string, slotId: string) {
    const response = await api(
      base,
      RELAY_PATHS.slot(encodeURIComponent(slotId)),
      { method: 'DELETE' },
      RELEASE_TIMEOUT_MS
    )
    // A slot that is already gone is the goal, not a problem.
    if (!response.ok && response.status !== 404) {
      throw new BrowserBayError(`The browser service could not release a browser (${response.status})`, response.status)
    }
  }

  /** Asking the box is the liveness check: it answers 200 only while the slot's browser is reachable. */
  async function lookup(base: string, slotId: string, token: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await doFetch(`${base}${RELAY_PATHS.slot(encodeURIComponent(slotId))}`, {
          headers: { [TOKEN_HEADER]: token },
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
        })
        if (response.ok) return true
        // 404 or 401: the slot is gone, or the address now belongs to another. Only a server error is worth another try.
        if (response.status < 500) return false
      } catch {
        // A restart of the box or a dropped request is not proof the slot is gone, so try once more.
      }
      if (attempt === 0 && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
    return false
  }

  function makeSlot({ url, slotId, token, nodeId }: StoredSlot): Slot {
    const base = boxOf(url)
    const cdpUrl = cdpUrlFor(base, slotId)
    return Object.freeze({
      url: base,
      slotId,
      nodeId,
      token,
      cdpUrl,
      get headers() {
        return { [TOKEN_HEADER]: token }
      },
      isAlive: () => lookup(base, slotId, token),
      release: () => deleteSlot(base, slotId),
      // What is worth keeping to come back to this browser later: see `box.slot()`.
      toJSON: () => ({ url: base, slotId, nodeId, token })
    })
  }

  async function list() {
    const response = await api(boxUrl, RELAY_PATHS.slots, {}, REQUEST_TIMEOUT_MS)
    if (!response.ok)
      throw new BrowserBayError(`The browser service could not list browsers (${response.status})`, response.status)
    const { slots } = (await response.json().catch(() => ({}))) ?? {}
    const mine = []
    for (const slot of Array.isArray(slots) ? slots : []) {
      if (!slot?.slotId || typeof slot.runId !== 'string') continue
      // Another service's slots on a shared box carry its prefix, or none: not ours to see.
      if (namespacePrefix && !slot.runId.startsWith(namespacePrefix)) continue
      mine.push(namespacePrefix ? { ...slot, runId: slot.runId.slice(namespacePrefix.length) } : slot)
    }
    return mine
  }

  return {
    async acquire({ runId, maxLifetimeSeconds, waitMs = 30_000, proxy, timezone, locale, nodeLabels }) {
      const fullRunId = namespacePrefix ? `${namespacePrefix}${runId}` : runId
      if (typeof runId !== 'string' || !runId || fullRunId.length > SLOT_LIMITS.maxRunIdLength) {
        throw new TypeError(
          `runId must be a string of 1 to ${SLOT_LIMITS.maxRunIdLength} characters (the namespace counts)`
        )
      }
      if (
        !Number.isInteger(maxLifetimeSeconds) ||
        maxLifetimeSeconds < SLOT_LIMITS.minLifetimeSeconds ||
        maxLifetimeSeconds > SLOT_LIMITS.maxLifetimeSeconds
      ) {
        throw new TypeError(
          `maxLifetimeSeconds must be a whole number from ${SLOT_LIMITS.minLifetimeSeconds} to ${SLOT_LIMITS.maxLifetimeSeconds}`
        )
      }
      if (!Number.isInteger(waitMs) || waitMs < 0) {
        throw new TypeError('waitMs must be a whole number of milliseconds, 0 or more')
      }
      if (proxy !== undefined && (typeof proxy !== 'object' || proxy === null || typeof proxy.server !== 'string')) {
        throw new TypeError(
          'proxy must be an object with a server, such as { server: "http://proxy.example.com:8080" }'
        )
      }
      for (const [name, value] of [
        ['timezone', timezone],
        ['locale', locale]
      ] as const) {
        if (value !== undefined && typeof value !== 'string') throw new TypeError(`${name} must be a string`)
      }
      if (
        nodeLabels !== undefined &&
        (!Array.isArray(nodeLabels) || nodeLabels.some((label) => typeof label !== 'string'))
      ) {
        throw new TypeError('nodeLabels must be a list of strings')
      }
      // Only what was asked for is sent, so a request without options is the one a box has always taken.
      const options: Partial<CreateSlotRequest> = {
        ...(proxy !== undefined ? { proxy } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
        ...(locale !== undefined ? { locale } : {}),
        ...(nodeLabels !== undefined && nodeLabels.length > 0 ? { nodeLabels } : {})
      }
      const body: CreateSlotRequest = { runId: fullRunId, maxLifetimeSeconds, waitMs, ...options }
      // What was asked for is exactly the options: the plain fields are not among them, whatever is added to either part.
      const asked = Object.keys(options)
      const response = await api(
        boxUrl,
        RELAY_PATHS.slots,
        { method: 'POST', body: JSON.stringify(body) },
        waitMs + ACQUIRE_TIMEOUT_MARGIN_MS
      )
      // The box held the request for the whole wait and still found no node with room (or lost the node it chose).
      if (response.status === 503) throw new NoCapacityError()
      if (response.status === 403) throw new ForbiddenError()
      if (response.status === 429) throw new QuotaExceededError()
      if (response.status === 422 || response.status === 400) {
        // The box says what is wrong with what was asked for. It never repeats a credential, so the text is safe to show.
        const said = ((await response.json().catch(() => ({}))) as { message?: unknown } | null)?.message
        const detail = typeof said === 'string' && said ? `: ${said}` : ''
        if (response.status === 422) throw new UnsupportedError(`The box cannot give this browser${detail}`, 422)
        throw new BrowserBayError(`The browser service refused the request (400)${detail}`, 400)
      }
      if (!response.ok)
        throw new BrowserBayError(`The browser service could not start a browser (${response.status})`, response.status)
      const slot: Partial<CreateSlotResponse> = (await response.json().catch(() => ({}))) ?? {}
      if (!slot.slotId || !slot.token || !slot.nodeId) {
        throw new BrowserBayError('The browser service returned an incomplete slot', response.status)
      }
      // A box older than these options answers 201 and ignores what it does not know: the browser it made is a plain one.
      const missing = asked.filter((name) => !(Array.isArray(slot.applied) && slot.applied.includes(name)))
      if (missing.length > 0) {
        await deleteSlot(boxUrl, slot.slotId).catch((error) =>
          logger.warn?.('Could not release a browser made without the options asked for', {
            slotId: slot.slotId,
            error: errorMessage(error, 'unknown')
          })
        )
        throw new UnsupportedError(
          `The box did not apply ${missing.join(', ')}: it is older than these options. Upgrade the box (its relay and nodes)`
        )
      }
      return makeSlot({ url: boxUrl, slotId: slot.slotId, token: slot.token, nodeId: slot.nodeId })
    },

    slot(stored) {
      if (typeof stored?.slotId !== 'string' || !stored.slotId || typeof stored.token !== 'string' || !stored.token) {
        throw new TypeError('A stored slot needs a slotId and a token')
      }
      return makeSlot({ url: stored.url ?? boxUrl, slotId: stored.slotId, token: stored.token, nodeId: stored.nodeId })
    },

    async release(slotId, { url } = {}) {
      if (typeof slotId !== 'string' || !slotId) throw new TypeError('release needs a slotId')
      await deleteSlot(boxOf(url), slotId)
    },

    list,

    async nodes() {
      const response = await api(boxUrl, RELAY_PATHS.nodes)
      if (!response.ok)
        throw new BrowserBayError(`The browser service could not list nodes (${response.status})`, response.status)
      const { nodes } = (await response.json().catch(() => ({}))) ?? {}
      return Array.isArray(nodes) ? nodes : []
    },

    async reap({ isLive, graceMs = 3 * 60_000, skip }) {
      let released = 0
      for (const slot of await list()) {
        const created = slot.createdAt ? Date.parse(slot.createdAt) : Number.NaN
        // A slot younger than the grace period may be between "created" and "saved on its run".
        if (Number.isFinite(created) && now() - created < graceMs) continue
        if (skip?.(slot.runId)) continue
        if (slot.runId) {
          try {
            if (await isLive(slot.runId)) continue
          } catch (error) {
            // Not knowing is not a reason to release someone's browser, or to stop checking the others.
            logger.warn?.('Could not tell whether a browser is still needed', {
              slotId: slot.slotId,
              error: errorMessage(error, 'unknown')
            })
            continue
          }
        }
        try {
          await deleteSlot(boxUrl, slot.slotId)
          released++
        } catch (error) {
          logger.warn?.('Could not release an orphaned browser', {
            slotId: slot.slotId,
            error: errorMessage(error, 'unknown')
          })
        }
      }
      return released
    }
  }
}
