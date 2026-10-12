/**
 * The browserbox client: how your service gets a browser from a box. Types are in index.d.ts.
 *
 *   const box = createBrowserBox({ url: 'https://browsers.example.com', apiKey })
 *   const slot = await box.acquire({ runId: 'task-42', maxLifetimeSeconds: 1800 })
 *   const browser = await chromium.connectOverCDP(slot.cdpUrl, { headers: slot.headers })   // Playwright, Puppeteer, ...
 *   ...
 *   await slot.release()
 *
 * Plain JavaScript with no dependencies, so it can be installed straight from git and used from any Node project.
 */
import { RELAY_PATHS, TOKEN_HEADER } from '../protocol.js'

/** Longer than the relay's own wait, so a full box is answered with 503 and not cut off by this side's timer. */
const ACQUIRE_TIMEOUT_MARGIN_MS = 20_000
const LOOKUP_TIMEOUT_MS = 3000
const RELEASE_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 15_000

export class BrowserBoxError extends Error {
  /** @param {string} message @param {number} [status] the HTTP status the box answered with, when it answered */
  constructor(message, status) {
    super(message)
    this.name = 'BrowserBoxError'
    this.status = status
  }
}

/** The box has no browser to give: every node is full, or none is connected. */
export class NoCapacityError extends BrowserBoxError {
  constructor() {
    super('No browser capacity is available right now', 503)
    this.name = 'NoCapacityError'
  }
}

const trimSlashes = (value) => value.replace(/\/+$/, '')
const errorMessage = (error) => (error instanceof Error ? error.message : 'unknown')

/** The box's CDP socket for a slot: the box's own address with the scheme swapped and any path prefix kept. */
function cdpUrlFor(boxUrl, slotId) {
  const url = new URL(boxUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${RELAY_PATHS.cdp(encodeURIComponent(slotId))}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function assertBoxUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`The browserbox URL is not a URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('The browserbox URL must be http(s)://, e.g. https://browsers.example.com')
  }
  return trimSlashes(value)
}

/**
 * @param {import('./index.js').BrowserBoxOptions} options
 * @returns {import('./index.js').BrowserBox}
 */
export function createBrowserBox(options) {
  const boxUrl = assertBoxUrl(options.url)
  if (!options.apiKey) throw new TypeError('createBrowserBox needs an apiKey')
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const logger = options.logger ?? {}
  const namespacePrefix = options.namespace ? `${options.namespace}:` : undefined

  /** A call to the box as its owner (create, list, release). The address is a parameter: a stored slot names its own. */
  function api(base, path, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return doFetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
  }

  async function deleteSlot(base, slotId) {
    const response = await api(
      base,
      RELAY_PATHS.slot(encodeURIComponent(slotId)),
      { method: 'DELETE' },
      RELEASE_TIMEOUT_MS
    )
    // A slot that is already gone is the goal, not a problem.
    if (!response.ok && response.status !== 404) {
      throw new BrowserBoxError(`The browser service could not release a browser (${response.status})`, response.status)
    }
  }

  /** Asking the box is the liveness check: it answers 200 only while the slot's browser is reachable. */
  async function lookup(base, slotId, token) {
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
    }
    return false
  }

  function makeSlot({ url, slotId, token, nodeId }) {
    const base = assertBoxUrl(url)
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
      throw new BrowserBoxError(`The browser service could not list browsers (${response.status})`, response.status)
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
    async acquire({ runId, maxLifetimeSeconds, waitMs = 30_000 }) {
      const body = {
        runId: namespacePrefix ? `${namespacePrefix}${runId}` : runId,
        maxLifetimeSeconds,
        waitMs
      }
      const response = await api(
        boxUrl,
        RELAY_PATHS.slots,
        { method: 'POST', body: JSON.stringify(body) },
        waitMs + ACQUIRE_TIMEOUT_MARGIN_MS
      )
      // The box held the request for the whole wait and still found no node with room (or lost the node it chose).
      if (response.status === 503) throw new NoCapacityError()
      if (!response.ok)
        throw new BrowserBoxError(`The browser service could not start a browser (${response.status})`, response.status)
      const slot = (await response.json().catch(() => ({}))) ?? {}
      if (!slot.slotId || !slot.token || !slot.nodeId) {
        throw new BrowserBoxError('The browser service returned an incomplete slot', response.status)
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
      await deleteSlot(url ? assertBoxUrl(url) : boxUrl, slotId)
    },

    list,

    async nodes() {
      const response = await api(boxUrl, RELAY_PATHS.nodes)
      if (!response.ok)
        throw new BrowserBoxError(`The browser service could not list nodes (${response.status})`, response.status)
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
              error: errorMessage(error)
            })
            continue
          }
        }
        try {
          await deleteSlot(boxUrl, slot.slotId)
          released++
        } catch (error) {
          logger.warn?.('Could not release an orphaned browser', { slotId: slot.slotId, error: errorMessage(error) })
        }
      }
      return released
    }
  }
}
