/**
 * Makes one shared Chromium look like a dedicated browser to each run that connects to it.
 *
 * Chromium's DevTools endpoint belongs to the whole browser, and Playwright assumes it owns that browser: it
 * auto-attaches to every target, files any context it does not know under its "default context", and sends
 * default-context commands without a browserContextId. Handed the raw endpoint, a run would see (and could drive)
 * other runs' pages, and its auto-attach would pause their new tabs. So nothing talks to Chromium directly. This hub
 * holds the only real connection, creates one BrowserContext per run, and gives each client a virtual browser-level
 * endpoint that shows that run's context and nothing else:
 *
 *   - Target.setAutoAttach is never forwarded. The hub is the sole real auto-attacher; a client gets synthesized
 *     Target.attachedToTarget events for its own context's targets, so it still sees pause-on-start for new tabs and
 *     can finish setting a tab up (routes, init scripts) before the tab runs.
 *   - Default-context commands are given the run's browserContextId; ids that name another context are refused with
 *     the same error as an id that does not exist.
 *   - A client disconnecting never disposes the run's context, so a later client sees the same pages. It does release
 *     everything the client held: a paused tab is resumed and its sessions are detached.
 *   - What a client can ask the machine for is limited (no navigating to file: or chrome:, no file paths into a page, no
 *     downloads). That keeps a browser's pages on the web; it does not make a client harmless. See "Trust" in the README.
 *   - With `dedicated: true` the Chromium behind the hub serves exactly one run (the node started it for that slot alone),
 *     so the fences that exist to keep runs apart are lifted: the browser-wide domains (IO, Tracing, Storage, Memory,
 *     SystemInfo) are open, and the client may make contexts of its own (`browser.newContext()`), which belong to the run
 *     like its first one. The fences around the machine stay: nothing about them depends on who else is on the browser.
 *
 * No dependencies and no sockets: the caller supplies the upstream connection and a transport per client, so the same
 * code is tested against a fake Chromium and run against a real one.
 */

import { proxyRulesAllowed } from '../proxy-address.js'
import type { SlotOptions } from '../protocol.js'

export interface ScopeUpstream {
  /** Sends one DevTools message (JSON text) to the real browser. */
  send(text: string): void
}

export interface ScopeTransport {
  /** Sends one DevTools message (JSON text) to the client. */
  send(text: string): void
  /** Closes the client's connection when the hub ends it (superseded, run ended, browser gone). */
  close?(code?: number, reason?: string): void
}

export interface ScopeClient {
  /** Feed every message the client sends. */
  handleMessage(text: string): void
  /** Call when the client's connection closed. Releases what it held; the run's browser context stays. */
  close(): void
}

export interface ScopeLogger {
  warn?(message: string, fields?: Record<string, unknown>): void
}

/**
 * What the hub applies to a run's context when it makes it. The values are the node's own: for a proxy, the address of a
 * forwarder the node started for the slot (proxy-forwarder.ts), never an address a client chose.
 */
export interface RunContext {
  proxyServer?: string
  proxyBypassList?: string
}

export interface CdpScope {
  /** Takes over the browser: learns what exists, then becomes its only auto-attacher. Call once, before any run. */
  start(): Promise<void>
  createRun(runKey: string, context?: RunContext): Promise<{ contextId: string }>
  disposeRun(runKey: string): Promise<void>
  hasRun(runKey: string): boolean
  runKeys(): string[]
  connect(runKey: string, transport: ScopeTransport): ScopeClient
  onUpstreamMessage(text: string): void
  onUpstreamClosed(): void
}

/**
 * What the agent needs of whatever holds a node's browsers: the hub of one shared Chromium, or (process isolation) a
 * Chromium of its own per slot. `CdpScope` is the first; node/process-host.ts is the second.
 */
export interface RunHost {
  /** Makes the slot's browser. `options` is what the slot asked for; a host that cannot do all of it fails, never makes less. */
  createRun(runKey: string, options?: SlotOptions): Promise<unknown>
  disposeRun(runKey: string): Promise<void>
  connect(runKey: string, transport: ScopeTransport): ScopeClient
  /** Told when a run's browser ends on its own (its Chromium crashed), so the node can end the slot instead of reporting it live. */
  onRunEnded?(listener: (runKey: string, reason: string) => void): void
}

/** DevTools parameters and results are open-ended; the hub only looks at the few fields it routes on. */
type Params = Record<string, any>

interface TargetInfo {
  targetId: string
  type: string
  browserContextId?: string
  [key: string]: unknown
}

interface CdpMessage {
  id?: number
  method?: string
  params?: Params
  result?: Params
  error?: { code: number; message?: string }
  sessionId?: string
}

/** A command from a client: it has an id to answer under and a method. */
type Command = CdpMessage & { id: number; method: string }

/** Everything the hub knows about one connected client. */
interface Client {
  runKey: string
  contextId: string
  transport: ScopeTransport
  /** Targets already handed to this client, so none is announced twice. */
  delivered: Set<string>
  /** Window ids Chromium gave this client; window ids are browser-wide, so any other is another run's. */
  windows: Set<number>
  discover: boolean
  closed: boolean
  send(object: unknown): void
  sendRaw(text: string): void
  sendError(id: number, code: number, message: string, sessionId?: string): void
}

/** A request the hub made for itself: someone in the hub is awaiting the answer. */
interface HubRequest {
  resolve(value: Params): void
  reject(error: Error): void
}

/** A client's command, sent upstream under a hub-owned id; the answer is routed back under the client's own. */
interface ForwardedCommand {
  client: Client
  clientId: number
  sessionId?: string
  /** Rewrites the result before the client sees it. */
  transform?: (result: Params) => Params
  /** Runs on a successful result, before it is delivered. */
  after?: (result: Params) => void
  /** Runs on a successful result when the client left while the command was in flight. */
  orphan?: (result: Params) => void
}

interface ForwardOptions {
  params?: Params
  transform?: ForwardedCommand['transform']
  after?: ForwardedCommand['after']
  orphan?: ForwardedCommand['orphan']
}

interface SessionRecord {
  owner: Client
  paused: boolean
  parent?: string
}

interface Run {
  /** What the run's context was made with. A context a client of a dedicated browser makes starts from it. */
  proxy?: RunContext
  contextId: string
  /** The run's own context and, on a dedicated browser, any the client made (all of them are the run's). */
  contexts: Set<string>
  controller: Client | null
  clients: Set<Client>
}

/** Target types a client is handed. Playwright ignores the rest (tabs, devtools, browser). */
const DELIVERABLE_TYPES = new Set(['page', 'service_worker', 'background_page'])

/** Browser-level methods that take a browserContextId; the run's own is filled in when the client leaves it out. */
const CONTEXT_METHODS = new Set([
  'Storage.getCookies',
  'Storage.setCookies',
  'Storage.clearCookies',
  'Browser.grantPermissions',
  'Browser.resetPermissions',
  'Browser.setPermission',
  'Browser.cancelDownload'
])

/** What a page session may still say to Browser/Target. Everything else in those domains reaches beyond the page. */
const SESSION_BROWSER_METHODS = new Set([
  'Browser.getWindowForTarget',
  'Browser.getWindowBounds',
  'Browser.setWindowBounds',
  'Browser.setDockTile'
])
const SESSION_TARGET_METHODS = new Set(['Target.setAutoAttach', 'Target.detachFromTarget'])
/**
 * Browser-wide in their effect (they would observe or disturb other runs), and ordinary page automation never needs them. IO
 * reads streams by a handle that is not tied to the session that was given it, so it is not offered at all (this
 * rules out page.pdf() and tracing on a shared browser).
 */
const SESSION_DENIED_DOMAINS = new Set(['SystemInfo', 'Tracing', 'Storage', 'Memory', 'IO'])

/** What `Target.createBrowserContext` may carry on a dedicated browser: where the context's traffic goes, nothing else. */
const CREATE_CONTEXT_PARAMS = ['proxyServer', 'proxyBypassList']

/**
 * Methods a page session may not call because they hand the client something of the machine the browser runs on: a
 * file path read into a page (`DOM.setFileInputFiles`; Playwright uploads from a remote client as buffers and does not
 * need it), and a download whose destination the client could pick.
 */
const SESSION_DENIED_METHODS = new Set(['DOM.setFileInputFiles', 'Page.setDownloadBehavior'])

/**
 * Where a client may point a page. Navigating to file:, chrome:, devtools: or view-source: opens the node itself (its
 * files, its browser's internal pages) and not the web, so only these are allowed. `about:` is only the blank page:
 * `about:version` and friends redirect to chrome: pages.
 */
const NAVIGABLE_SCHEMES = new Set(['http:', 'https:', 'data:', 'blob:'])
function navigableUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    if (url.protocol === 'about:') return url.pathname === 'blank' || url.pathname === 'srcdoc'
    return NAVIGABLE_SCHEMES.has(url.protocol)
  } catch {
    return false
  }
}
const URL_REFUSED = 'This URL cannot be opened on a shared browser'

const CREATE_TARGET_PARAMS = ['url', 'width', 'height', 'newWindow', 'background']

const ERR_METHOD_NOT_FOUND = -32601
const ERR_INVALID_PARAMS = -32602
const ERR_INTERNAL = -32603
const ERR_SESSION_NOT_FOUND = -32001

const ignore = () => undefined

/** How Chromium starts a reply: `{"id":7,...`. Anything else takes the slower, parsing path. */
const RESPONSE_HEAD = /^\{"id":(\d+)/

export function createCdpScope({
  upstream,
  logger = {},
  requestTimeoutMs = 30_000,
  dedicated = false
}: {
  upstream: ScopeUpstream
  logger?: ScopeLogger
  /** How long a request to the browser may go unanswered before it fails (default 30 s). */
  requestTimeoutMs?: number
  /**
   * This browser serves one run and nothing else, so what keeps runs apart is lifted: see the top of this file. Never
   * set it on a browser that more than one run is created on.
   */
  dedicated?: boolean
}): CdpScope {
  const log = (level: keyof ScopeLogger, message: string, fields?: Record<string, unknown>) =>
    logger[level]?.(message, fields)

  let nextUpstreamId = 1
  /** Upstream request id -> who is waiting: the hub itself or a client's forwarded command. */
  const pending = new Map<number, HubRequest | ForwardedCommand>()
  const runs = new Map<string, Run>()
  const contextToRun = new Map<string, string>()
  /** targetId -> targetInfo, from discovery. Authoritative for "which context does this target belong to". */
  const targets = new Map<string, TargetInfo>()
  /** A session nobody here owns is never forwarded to or from. */
  const sessions = new Map<string, SessionRecord>()
  let starting = false
  let closed = false

  function request(method: string, params: Params = {}, sessionId?: string): Promise<Params> {
    if (closed) return Promise.reject(new Error('The browser connection is closed'))
    const id = nextUpstreamId++
    return new Promise<Params>((resolve, reject) => {
      // A browser that stops answering must not leave callers (a context being created) waiting for ever.
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} did not answer in time`))
      }, requestTimeoutMs)
      timer.unref?.()
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      upstream.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  /** Sends a client's command upstream under a hub-owned id, and routes the answer back under the client's own. */
  function forward(
    client: Client,
    message: Command,
    { params = message.params, transform, after, orphan }: ForwardOptions = {}
  ) {
    const id = nextUpstreamId++
    pending.set(id, { client, clientId: message.id, sessionId: message.sessionId, transform, after, orphan })
    upstream.send(
      JSON.stringify({
        id,
        method: message.method,
        params,
        ...(message.sessionId ? { sessionId: message.sessionId } : {})
      })
    )
  }

  /** Lets a tab that is paused at start run, and lets go of it. Used for every tab no client wants. */
  function discard(sessionId: string) {
    request('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(ignore)
    request('Target.detachFromTarget', { sessionId }).catch(ignore)
  }

  function dropSession(sessionId: string) {
    if (!sessions.delete(sessionId)) return
    for (const [id, record] of sessions) if (record.parent === sessionId) dropSession(id)
    for (const [id, entry] of pending) {
      if ('client' in entry && entry.sessionId === sessionId) {
        pending.delete(id)
        // -32001 is what Chromium answers for a vanished session, and what clients already tolerate.
        entry.client.sendError(entry.clientId, ERR_SESSION_NOT_FOUND, 'Session closed.', sessionId)
      }
    }
  }

  /** Whether a context is the client's: its run's own, or (dedicated) one the client made. */
  const ownsContext = (client: Client, contextId: string | undefined) =>
    contextId !== undefined &&
    (contextId === client.contextId || Boolean(runs.get(client.runKey)?.contexts.has(contextId)))

  const runOf = (contextId: string | undefined) => {
    const runKey = contextId === undefined ? undefined : contextToRun.get(contextId)
    return runKey === undefined ? undefined : runs.get(runKey)
  }

  // ---- Chromium -> clients -------------------------------------------------------------------------------------

  function onUpstreamMessage(text: string) {
    try {
      // A reply nobody needs to look inside (a screenshot, a large evaluate result) is passed on as it is, with the
      // client's own id in place of the hub's. Parsing and rebuilding it would stall every run on the node.
      const head = RESPONSE_HEAD.exec(text)
      if (head) {
        const entry = pending.get(Number(head[1]))
        if (entry && 'client' in entry && !entry.transform && !entry.after && !entry.orphan) {
          pending.delete(Number(head[1]))
          entry.client.sendRaw(`{"id":${entry.clientId}${text.slice(head[0].length)}`)
          return
        }
      }
      let message: CdpMessage
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      if (typeof message.id === 'number') onResponse(message as CdpMessage & { id: number })
      else if (typeof message.method === 'string') onEvent(message, text)
    } catch (error) {
      // One message the hub cannot handle must not become an uncaught exception that ends every run on the node.
      log('warn', 'A message from the browser could not be handled', { error: String(error) })
    }
  }

  function onResponse(message: CdpMessage & { id: number }) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if ('resolve' in entry) {
      if (message.error)
        entry.reject(Object.assign(new Error(message.error.message ?? 'DevTools error'), message.error))
      else entry.resolve(message.result ?? {})
      return
    }
    const { client, clientId, sessionId } = entry
    if (client.closed) {
      // The client left while this was in flight; whatever it created has no owner now and must be let go.
      if (!message.error) entry.orphan?.(message.result ?? {})
      return
    }
    const tail = sessionId ? { sessionId } : {}
    if (message.error) {
      client.send({ id: clientId, error: message.error, ...tail })
      return
    }
    try {
      let result = message.result ?? {}
      entry.after?.(result)
      if (entry.transform) result = entry.transform(result)
      client.send({ id: clientId, result, ...tail })
    } catch (error) {
      log('warn', 'A scoped command could not be completed', { error: String(error) })
      client.sendError(clientId, ERR_INTERNAL, 'The command could not be completed', sessionId)
    }
  }

  function onEvent(message: CdpMessage, text: string) {
    const { method, params = {} } = message
    if (message.sessionId) return onSessionEvent(message as CdpMessage & { sessionId: string }, text)
    switch (method) {
      case 'Target.attachedToTarget':
        return onAttached(params)
      case 'Target.detachedFromTarget': {
        const record = sessions.get(params.sessionId)
        if (!record) return
        record.owner.sendRaw(text)
        return dropSession(params.sessionId)
      }
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const info = params.targetInfo
        if (!info) return
        targets.set(info.targetId, info)
        return fanOutDiscovery(info.browserContextId, text)
      }
      case 'Target.targetDestroyed': {
        const info = targets.get(params.targetId)
        targets.delete(params.targetId)
        if (!info) return
        const run = runOf(info.browserContextId)
        for (const client of run?.clients ?? []) client.delivered.delete(params.targetId)
        return fanOutDiscovery(info.browserContextId, text)
      }
      default:
        // On a dedicated browser the browser-wide domains the client may use (Tracing's data, say) belong to its one run.
        if (dedicated && method && SESSION_DENIED_DOMAINS.has(method.slice(0, method.indexOf('.')))) {
          for (const run of runs.values()) for (const client of run.clients) client.sendRaw(text)
          return
        }
        // Browser.downloadWillBegin and friends carry no context, so they cannot be attributed to one run.
        return
    }
  }

  function fanOutDiscovery(contextId: string | undefined, text: string) {
    for (const client of runOf(contextId)?.clients ?? []) if (client.discover) client.sendRaw(text)
  }

  /**
   * Chromium attached the hub to a target. A paused target (waitingForDebugger) is a new one, and is either handed to
   * the run's controller as it is, still paused, or released at once. An unpaused attach is the hub's own explicit
   * attach (answered through its response) or the sweep over existing targets at start-up; neither is acted on here.
   */
  function onAttached(params: Params) {
    const { sessionId, targetInfo, waitingForDebugger } = params
    if (!sessionId || !targetInfo || targetInfo.type === 'browser') return
    targets.set(targetInfo.targetId, targetInfo)
    if (!waitingForDebugger) {
      if (starting) request('Target.detachFromTarget', { sessionId }).catch(ignore)
      return
    }
    const controller = runOf(targetInfo.browserContextId)?.controller
    if (
      !controller ||
      controller.closed ||
      !DELIVERABLE_TYPES.has(targetInfo.type) ||
      controller.delivered.has(targetInfo.targetId)
    ) {
      discard(sessionId)
      return
    }
    controller.delivered.add(targetInfo.targetId)
    sessions.set(sessionId, { owner: controller, paused: true })
    controller.send({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo, waitingForDebugger: true } })
  }

  function onSessionEvent(message: CdpMessage & { sessionId: string }, text: string) {
    const record = sessions.get(message.sessionId)
    if (!record) return
    const { method, params = {} } = message
    if (method === 'Target.attachedToTarget' && params.sessionId) {
      // A frame or worker the client asked to be attached to inside its own page: it belongs to the same client.
      sessions.set(params.sessionId, {
        owner: record.owner,
        paused: Boolean(params.waitingForDebugger),
        parent: message.sessionId
      })
    }
    record.owner.sendRaw(text)
    if (method === 'Target.detachedFromTarget' && params.sessionId) dropSession(params.sessionId)
  }

  // ---- clients -> Chromium -------------------------------------------------------------------------------------

  function handleBrowserCommand(client: Client, message: Command) {
    const { id, method } = message
    const params = message.params ?? {}
    const ownsTarget = (targetId: string) => ownsContext(client, targets.get(targetId)?.browserContextId)
    const notFound = () => client.sendError(id, ERR_INVALID_PARAMS, 'No target with given id found')
    const contextNotFound = () =>
      client.sendError(id, ERR_INVALID_PARAMS, 'Failed to find browser context with id ' + params.browserContextId)
    const withContext = () => {
      if (params.browserContextId !== undefined && !ownsContext(client, params.browserContextId)) {
        return contextNotFound()
      }
      forward(client, message, { params: { ...params, browserContextId: params.browserContextId ?? client.contextId } })
    }

    if (dedicated && handleDedicatedBrowserCommand(client, message, { contextNotFound })) return

    switch (method) {
      case 'Browser.getVersion':
        return forward(client, message)

      case 'Target.setAutoAttach':
        return void handleSetAutoAttach(client, message)

      case 'Target.setDiscoverTargets':
        client.discover = Boolean(params.discover)
        client.send({ id, result: {} })
        if (client.discover) {
          for (const info of targets.values()) {
            if (ownsContext(client, info.browserContextId)) {
              client.send({ method: 'Target.targetCreated', params: { targetInfo: info } })
            }
          }
        }
        return

      case 'Target.getTargets':
        return forward(client, message, {
          transform: (result) => ({
            ...result,
            targetInfos: (result.targetInfos ?? []).filter((info: TargetInfo) =>
              ownsContext(client, info.browserContextId)
            )
          })
        })

      case 'Target.getBrowserContexts':
        return client.send({
          id,
          result: { browserContextIds: [...(runs.get(client.runKey)?.contexts ?? [client.contextId])] }
        })

      case 'Target.getTargetInfo':
        if (params.targetId === undefined) return forward(client, message)
        return ownsTarget(params.targetId) ? forward(client, message) : notFound()

      case 'Target.createTarget': {
        if (params.browserContextId !== undefined && !ownsContext(client, params.browserContextId)) return notFound()
        if (params.url !== undefined && !navigableUrl(params.url)) {
          log('warn', 'A target on a refused URL was not created', { runKey: client.runKey })
          return client.sendError(id, ERR_INVALID_PARAMS, URL_REFUSED)
        }
        const allowed = Object.fromEntries(
          CREATE_TARGET_PARAMS.filter((key) => key in params).map((key) => [key, params[key]])
        )
        return forward(client, message, {
          params: { ...allowed, browserContextId: params.browserContextId ?? client.contextId }
        })
      }

      case 'Target.closeTarget':
      case 'Target.activateTarget':
        return ownsTarget(params.targetId) ? forward(client, message) : notFound()

      case 'Target.attachToTarget':
        if (!ownsTarget(params.targetId)) return notFound()
        return forward(client, message, {
          params: { targetId: params.targetId, flatten: true },
          after: (result) => {
            if (result.sessionId) sessions.set(result.sessionId, { owner: client, paused: false })
          },
          orphan: (result) => {
            if (result.sessionId) request('Target.detachFromTarget', { sessionId: result.sessionId }).catch(ignore)
          }
        })

      case 'Target.detachFromTarget':
        if (sessions.get(params.sessionId)?.owner !== client) {
          return client.sendError(id, ERR_SESSION_NOT_FOUND, 'Session with given id not found.')
        }
        return forward(client, message, { after: () => dropSession(params.sessionId) })

      case 'Browser.setDownloadBehavior':
        // Files would land on this machine, outside any run's control. Pages in a run never need to download.
        return forward(client, message, {
          params: { behavior: 'deny', eventsEnabled: false, browserContextId: client.contextId }
        })

      default:
        if (CONTEXT_METHODS.has(method)) return withContext()
        log('warn', 'A browser-level command was refused', { method, runKey: client.runKey })
        return client.sendError(id, ERR_METHOD_NOT_FOUND, `${method} is not available on a shared browser`)
    }
  }

  /**
   * What a client of a dedicated browser may do beyond a shared one's: make and close contexts of its own, and use the
   * browser-wide domains. Returns whether it handled the command; anything else takes the usual path.
   */
  function handleDedicatedBrowserCommand(
    client: Client,
    message: Command,
    { contextNotFound }: { contextNotFound: () => void }
  ): boolean {
    const { id, method } = message
    const params = message.params ?? {}
    switch (method) {
      case 'Target.createBrowserContext':
        void createExtraContext(client, message)
        return true
      case 'Target.disposeBrowserContext': {
        const run = runs.get(client.runKey)
        if (!run || !run.contexts.has(params.browserContextId)) {
          contextNotFound()
        } else if (params.browserContextId === client.contextId) {
          // The slot is its context; the way to end it is to release the slot.
          client.sendError(id, ERR_INVALID_PARAMS, "The slot's own browser context cannot be closed; release the slot")
        } else {
          forward(client, message, { after: () => forgetContext(run, params.browserContextId) })
        }
        return true
      }
    }
    const domain = method.slice(0, method.indexOf('.'))
    // Storage's per-context calls (cookies) take the usual path, which fills in or checks the context.
    if (SESSION_DENIED_DOMAINS.has(domain) && !CONTEXT_METHODS.has(method)) {
      if (params.browserContextId !== undefined && !ownsContext(client, params.browserContextId)) {
        contextNotFound()
      } else {
        forward(client, message)
      }
      return true
    }
    return false
  }

  /** A context the client of a dedicated browser asked for: made like the run's own (downloads denied), then the run's. */
  async function createExtraContext(client: Client, message: Command) {
    const run = runs.get(client.runKey)
    if (!run) return
    const params = message.params ?? {}
    const allowed: Params = Object.fromEntries(
      CREATE_CONTEXT_PARAMS.filter((key) => key in params).map((key) => [key, params[key]])
    )
    // A proxy the client picks for its own context may not be one that reaches the node itself: the node's loopback holds the
    // forwarders of every other slot here, and (in a box) the relay.
    if (
      allowed.proxyServer !== undefined &&
      (typeof allowed.proxyServer !== 'string' || !proxyRulesAllowed(allowed.proxyServer))
    ) {
      log('warn', 'A context on a refused proxy was not created', { runKey: client.runKey })
      return client.sendError(message.id, ERR_INVALID_PARAMS, 'This proxy cannot be used on a slot')
    }
    // A slot with a proxy keeps it for the contexts its client makes, unless the client names another.
    if (allowed.proxyServer === undefined && run.proxy?.proxyServer) {
      allowed.proxyServer = run.proxy.proxyServer
      if (allowed.proxyBypassList === undefined && run.proxy.proxyBypassList) {
        allowed.proxyBypassList = run.proxy.proxyBypassList
      }
    }
    let created: string | undefined
    try {
      const result = await request('Target.createBrowserContext', { ...allowed, disposeOnDetach: false })
      created = String(result.browserContextId)
      await request('Browser.setDownloadBehavior', {
        behavior: 'deny',
        eventsEnabled: false,
        browserContextId: created
      })
      // The run ended while this was being made: nobody owns it.
      if (runs.get(client.runKey) !== run) throw new Error('The run ended')
      run.contexts.add(created)
      contextToRun.set(created, client.runKey)
      client.send({ id: message.id, result: { browserContextId: created } })
    } catch (error) {
      if (created) void request('Target.disposeBrowserContext', { browserContextId: created }).catch(ignore)
      client.sendError(message.id, ERR_INTERNAL, `The browser context could not be created: ${String(error)}`)
    }
  }

  function forgetContext(run: Run, contextId: string) {
    run.contexts.delete(contextId)
    contextToRun.delete(contextId)
    for (const [id, info] of targets) if (info.browserContextId === contextId) targets.delete(id)
  }

  async function handleSetAutoAttach(client: Client, message: Command) {
    const run = runs.get(client.runKey)
    if (!run) return
    if (!message.params?.autoAttach) {
      if (run.controller === client) run.controller = null
      return client.send({ id: message.id, result: {} })
    }
    if (run.controller && run.controller !== client) evict(run.controller, 4000, 'Superseded by a newer connection')
    run.controller = client
    // Tabs that already exist in this run's context, in the order Chromium reports them. They are not paused.
    for (const info of [...targets.values()]) {
      if (!run.contexts.has(info.browserContextId!) || !DELIVERABLE_TYPES.has(info.type)) continue
      if (client.delivered.has(info.targetId)) continue
      client.delivered.add(info.targetId)
      let attached: Params
      try {
        attached = await request('Target.attachToTarget', { targetId: info.targetId, flatten: true })
      } catch {
        client.delivered.delete(info.targetId)
        continue
      }
      if (client.closed) {
        request('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(ignore)
        return
      }
      sessions.set(attached.sessionId, { owner: client, paused: false })
      client.send({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: attached.sessionId,
          targetInfo: targets.get(info.targetId) ?? info,
          waitingForDebugger: false
        }
      })
    }
    // Clients wait for this answer before looking for pages, so every existing tab is announced before it.
    client.send({ id: message.id, result: {} })
  }

  function handleSessionCommand(client: Client, message: Command & { sessionId: string }) {
    const { id, method, sessionId } = message
    const params = message.params ?? {}
    const record = sessions.get(sessionId)
    if (!record || record.owner !== client) {
      return client.sendError(id, ERR_SESSION_NOT_FOUND, 'Session with given id not found.', sessionId)
    }
    const domain = method.slice(0, method.indexOf('.'))
    const denied =
      (domain === 'Target' && !SESSION_TARGET_METHODS.has(method)) ||
      (domain === 'Browser' && !SESSION_BROWSER_METHODS.has(method)) ||
      (SESSION_DENIED_DOMAINS.has(domain) && !dedicated)
    if (denied) {
      log('warn', 'A session-level command was refused', { method, runKey: client.runKey })
      return client.sendError(id, ERR_METHOD_NOT_FOUND, `${method} is not available on a shared browser`, sessionId)
    }
    if (params.browserContextId !== undefined && !ownsContext(client, params.browserContextId)) {
      return client.sendError(id, ERR_INVALID_PARAMS, 'Failed to find browser context', sessionId)
    }
    if (SESSION_DENIED_METHODS.has(method) || (method === 'Input.dispatchDragEvent' && params.data?.files?.length)) {
      log('warn', 'A session-level command was refused', { method, runKey: client.runKey })
      return client.sendError(id, ERR_METHOD_NOT_FOUND, `${method} is not available on a shared browser`, sessionId)
    }
    // Page.navigate, and a request rewritten to another URL while it is paused (Fetch.continueRequest).
    if (
      (method === 'Page.navigate' || (method === 'Fetch.continueRequest' && params.url !== undefined)) &&
      !navigableUrl(params.url)
    ) {
      log('warn', 'A navigation to a refused URL was blocked', { method, runKey: client.runKey })
      return client.sendError(id, ERR_INVALID_PARAMS, URL_REFUSED, sessionId)
    }
    if (method === 'Browser.getWindowForTarget') {
      if (params.targetId !== undefined && !ownsContext(client, targets.get(params.targetId)?.browserContextId)) {
        return client.sendError(id, ERR_INVALID_PARAMS, 'No target with given id found', sessionId)
      }
      return forward(client, message, {
        after: (result) => {
          if (result.windowId !== undefined) client.windows.add(result.windowId)
        }
      })
    }
    if (
      (method === 'Browser.getWindowBounds' || method === 'Browser.setWindowBounds') &&
      !client.windows.has(params.windowId)
    ) {
      return client.sendError(id, ERR_INVALID_PARAMS, 'Browser window not found', sessionId)
    }
    if (method === 'Target.detachFromTarget') {
      if (sessions.get(params.sessionId)?.owner !== client) {
        return client.sendError(id, ERR_SESSION_NOT_FOUND, 'Session with given id not found.', sessionId)
      }
      return forward(client, message, { after: () => dropSession(params.sessionId) })
    }
    if (method === 'Runtime.runIfWaitingForDebugger') record.paused = false
    forward(client, message)
  }

  // ---- clients -----------------------------------------------------------------------------------------------

  /** Lets go of everything a client held. The run's context and pages stay: the next client sees them as they are. */
  function release(client: Client) {
    if (client.closed) return
    client.closed = true
    const run = runs.get(client.runKey)
    run?.clients.delete(client)
    if (run?.controller === client) run.controller = null
    // What an in-flight command was creating is still let go of when its answer arrives (see onResponse).
    for (const [id, entry] of pending) {
      if ('client' in entry && entry.client === client && !entry.orphan) pending.delete(id)
    }
    // Children before parents. A paused tab must be resumed before it is let go, or it stays frozen; a session that
    // enabled request interception must be detached, or the tab's requests wait for an answer nobody will give.
    const owned = [...sessions].filter(([, record]) => record.owner === client).reverse()
    for (const [sessionId, record] of owned) {
      sessions.delete(sessionId)
      if (!closed) {
        if (record.paused) request('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(ignore)
        request('Target.detachFromTarget', { sessionId }).catch(ignore)
      }
    }
  }

  function evict(client: Client, code: number, reason: string) {
    release(client)
    client.transport.close?.(code, reason)
  }

  function connect(runKey: string, transport: ScopeTransport): ScopeClient {
    const run = runs.get(runKey)
    if (!run) throw new Error('Unknown slot')
    const client: Client = {
      runKey,
      contextId: run.contextId,
      transport,
      delivered: new Set(),
      windows: new Set(),
      discover: false,
      closed: false,
      send(object) {
        if (!client.closed) transport.send(JSON.stringify(object))
      },
      sendRaw(text) {
        if (!client.closed) transport.send(text)
      },
      sendError(id, code, message, sessionId) {
        client.send({ id, error: { code, message }, ...(sessionId ? { sessionId } : {}) })
      }
    }
    run.clients.add(client)
    return {
      handleMessage(text) {
        if (client.closed) return
        let message: CdpMessage
        try {
          message = JSON.parse(text)
        } catch {
          return
        }
        if (typeof message?.id !== 'number' || typeof message.method !== 'string') return
        const command = message as Command
        try {
          if (command.sessionId !== undefined) handleSessionCommand(client, command as Command & { sessionId: string })
          else handleBrowserCommand(client, command)
        } catch (error) {
          log('warn', 'A scoped command failed', { method: message.method, error: String(error) })
          client.sendError(message.id, ERR_INTERNAL, 'The command could not be completed', message.sessionId)
        }
      },
      close() {
        release(client)
      }
    }
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------

  async function start() {
    starting = true
    try {
      await request('Target.setDiscoverTargets', { discover: true })
      const { targetInfos = [] } = await request('Target.getTargets')
      for (const info of targetInfos) targets.set(info.targetId, info)
      await request('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    } finally {
      starting = false
    }
  }

  /** Keys whose context is still being made: reserved at once, so two creates for one key cannot both pass the check. */
  const creating = new Set<string>()

  async function createRun(runKey: string, context?: RunContext) {
    if (runs.has(runKey) || creating.has(runKey)) throw new Error('This slot already has a browser context')
    creating.add(runKey)
    try {
      return await makeRun(runKey, context)
    } finally {
      creating.delete(runKey)
    }
  }

  async function makeRun(runKey: string, context?: RunContext) {
    // disposeOnDetach:false, so a client disconnecting (a service handing the browser to a person) leaves the context alone.
    const { browserContextId } = await request('Target.createBrowserContext', {
      disposeOnDetach: false,
      ...(context?.proxyServer
        ? {
            proxyServer: context.proxyServer,
            ...(context.proxyBypassList ? { proxyBypassList: context.proxyBypassList } : {})
          }
        : {})
    })
    // Files would land on this machine, outside any run's control. Denied from the start, not only if a client asks.
    await request('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: false, browserContextId }).catch(
      (error) => {
        void request('Target.disposeBrowserContext', { browserContextId }).catch(ignore)
        throw error
      }
    )
    runs.set(runKey, {
      ...(context?.proxyServer
        ? {
            proxy: {
              proxyServer: context.proxyServer,
              ...(context.proxyBypassList ? { proxyBypassList: context.proxyBypassList } : {})
            }
          }
        : {}),
      contextId: browserContextId,
      contexts: new Set([browserContextId]),
      controller: null,
      clients: new Set()
    })
    contextToRun.set(browserContextId, runKey)
    return { contextId: browserContextId }
  }

  async function disposeRun(runKey: string) {
    const run = runs.get(runKey)
    if (!run) return
    runs.delete(runKey)
    for (const client of [...run.clients]) evict(client, 4001, 'The slot was released')
    const owned = [...run.contexts]
    for (const contextId of owned) forgetContext(run, contextId)
    await Promise.all(
      owned.map((browserContextId) => request('Target.disposeBrowserContext', { browserContextId }).catch(ignore))
    )
  }

  /** Chromium went away: every context and page with it. Clients are told with a code they can tell from a normal close. */
  function onUpstreamClosed() {
    if (closed) return
    closed = true
    for (const entry of pending.values()) {
      if ('reject' in entry) entry.reject(new Error('The browser connection closed'))
    }
    pending.clear()
    for (const run of runs.values()) for (const client of [...run.clients]) evict(client, 1011, 'The browser closed')
    runs.clear()
    contextToRun.clear()
    targets.clear()
    sessions.clear()
  }

  return {
    start,
    createRun,
    disposeRun,
    hasRun: (runKey) => runs.has(runKey),
    runKeys: () => [...runs.keys()],
    connect,
    onUpstreamMessage,
    onUpstreamClosed
  }
}
