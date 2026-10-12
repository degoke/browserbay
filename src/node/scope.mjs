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
 *
 * Plain Node, no dependencies, no sockets: the caller supplies the upstream connection and a transport per client,
 * so the same code is tested against a fake Chromium and run against a real one.
 */

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
function navigableUrl(value) {
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

export function createCdpScope({ upstream, logger = {}, requestTimeoutMs = 30_000 }) {
  const log = (level, message, fields) => logger[level]?.(message, fields)

  let nextUpstreamId = 1
  /** Upstream request id -> who is waiting: the hub itself ({resolve, reject}) or a client's forwarded command. */
  const pending = new Map()
  /** runKey -> { contextId, controller, clients } */
  const runs = new Map()
  const contextToRun = new Map()
  /** targetId -> targetInfo, from discovery. Authoritative for "which context does this target belong to". */
  const targets = new Map()
  /** sessionId -> { owner: client, paused, parent? }. A session nobody here owns is never forwarded to or from. */
  const sessions = new Map()
  let starting = false
  let closed = false

  function request(method, params = {}, sessionId) {
    if (closed) return Promise.reject(new Error('The browser connection is closed'))
    const id = nextUpstreamId++
    return new Promise((resolve, reject) => {
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
  function forward(client, message, { params = message.params, transform, after, orphan } = {}) {
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
  function discard(sessionId) {
    request('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(ignore)
    request('Target.detachFromTarget', { sessionId }).catch(ignore)
  }

  function dropSession(sessionId) {
    if (!sessions.delete(sessionId)) return
    for (const [id, record] of sessions) if (record.parent === sessionId) dropSession(id)
    for (const [id, entry] of pending) {
      if (entry.client && entry.sessionId === sessionId) {
        pending.delete(id)
        // -32001 is what Chromium answers for a vanished session, and what clients already tolerate.
        entry.client.sendError(entry.clientId, ERR_SESSION_NOT_FOUND, 'Session closed.', sessionId)
      }
    }
  }

  const runOf = (contextId) => {
    const runKey = contextToRun.get(contextId)
    return runKey === undefined ? undefined : runs.get(runKey)
  }

  // ---- Chromium -> clients -------------------------------------------------------------------------------------

  function onUpstreamMessage(text) {
    try {
      // A reply nobody needs to look inside (a screenshot, a large evaluate result) is passed on as it is, with the
      // client's own id in place of the hub's. Parsing and rebuilding it would stall every run on the node.
      const head = RESPONSE_HEAD.exec(text)
      if (head) {
        const entry = pending.get(Number(head[1]))
        if (entry?.client && !entry.transform && !entry.after && !entry.orphan) {
          pending.delete(Number(head[1]))
          entry.client.sendRaw(`{"id":${entry.clientId}${text.slice(head[0].length)}`)
          return
        }
      }
      let message
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      if (typeof message.id === 'number') onResponse(message)
      else if (typeof message.method === 'string') onEvent(message, text)
    } catch (error) {
      // One message the hub cannot handle must not become an uncaught exception that ends every run on the node.
      log('warn', 'A message from the browser could not be handled', { error: String(error) })
    }
  }

  function onResponse(message) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (entry.resolve) {
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

  function onEvent(message, text) {
    const { method, params = {} } = message
    if (message.sessionId) return onSessionEvent(message, text)
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
        // Browser.downloadWillBegin and friends carry no context, so they cannot be attributed to one run.
        return
    }
  }

  function fanOutDiscovery(contextId, text) {
    for (const client of runOf(contextId)?.clients ?? []) if (client.discover) client.sendRaw(text)
  }

  /**
   * Chromium attached the hub to a target. A paused target (waitingForDebugger) is a new one, and is either handed to
   * the run's controller as it is, still paused, or released at once. An unpaused attach is the hub's own explicit
   * attach (answered through its response) or the sweep over existing targets at start-up; neither is acted on here.
   */
  function onAttached(params) {
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

  function onSessionEvent(message, text) {
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

  function handleBrowserCommand(client, message) {
    const { id, method } = message
    const params = message.params ?? {}
    const ownsTarget = (targetId) => targets.get(targetId)?.browserContextId === client.contextId
    const notFound = () => client.sendError(id, ERR_INVALID_PARAMS, 'No target with given id found')
    const withContext = () => {
      if (params.browserContextId !== undefined && params.browserContextId !== client.contextId) {
        return client.sendError(
          id,
          ERR_INVALID_PARAMS,
          'Failed to find browser context with id ' + params.browserContextId
        )
      }
      forward(client, message, { params: { ...params, browserContextId: client.contextId } })
    }

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
            if (info.browserContextId === client.contextId) {
              client.send({ method: 'Target.targetCreated', params: { targetInfo: info } })
            }
          }
        }
        return

      case 'Target.getTargets':
        return forward(client, message, {
          transform: (result) => ({
            ...result,
            targetInfos: (result.targetInfos ?? []).filter((info) => info.browserContextId === client.contextId)
          })
        })

      case 'Target.getBrowserContexts':
        return client.send({ id, result: { browserContextIds: [client.contextId] } })

      case 'Target.getTargetInfo':
        if (params.targetId === undefined) return forward(client, message)
        return ownsTarget(params.targetId) ? forward(client, message) : notFound()

      case 'Target.createTarget': {
        if (params.browserContextId !== undefined && params.browserContextId !== client.contextId) return notFound()
        if (params.url !== undefined && !navigableUrl(params.url)) {
          log('warn', 'A target on a refused URL was not created', { runKey: client.runKey })
          return client.sendError(id, ERR_INVALID_PARAMS, URL_REFUSED)
        }
        const allowed = Object.fromEntries(
          CREATE_TARGET_PARAMS.filter((key) => key in params).map((key) => [key, params[key]])
        )
        return forward(client, message, { params: { ...allowed, browserContextId: client.contextId } })
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

  async function handleSetAutoAttach(client, message) {
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
      if (info.browserContextId !== run.contextId || !DELIVERABLE_TYPES.has(info.type)) continue
      if (client.delivered.has(info.targetId)) continue
      client.delivered.add(info.targetId)
      let attached
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

  function handleSessionCommand(client, message) {
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
      SESSION_DENIED_DOMAINS.has(domain)
    if (denied) {
      log('warn', 'A session-level command was refused', { method, runKey: client.runKey })
      return client.sendError(id, ERR_METHOD_NOT_FOUND, `${method} is not available on a shared browser`, sessionId)
    }
    if (params.browserContextId !== undefined && params.browserContextId !== client.contextId) {
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
      if (params.targetId !== undefined && targets.get(params.targetId)?.browserContextId !== client.contextId) {
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
  function release(client) {
    if (client.closed) return
    client.closed = true
    const run = runs.get(client.runKey)
    run?.clients.delete(client)
    if (run?.controller === client) run.controller = null
    // What an in-flight command was creating is still let go of when its answer arrives (see onResponse).
    for (const [id, entry] of pending) if (entry.client === client && !entry.orphan) pending.delete(id)
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

  function evict(client, code, reason) {
    release(client)
    client.transport.close?.(code, reason)
  }

  function connect(runKey, transport) {
    const run = runs.get(runKey)
    if (!run) throw new Error('Unknown slot')
    const client = {
      runKey,
      contextId: run.contextId,
      transport,
      delivered: new Set(),
      /** Window ids Chromium gave this client; window ids are browser-wide, so any other is another run's. */
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
        let message
        try {
          message = JSON.parse(text)
        } catch {
          return
        }
        if (typeof message?.id !== 'number' || typeof message.method !== 'string') return
        try {
          if (message.sessionId !== undefined) handleSessionCommand(client, message)
          else handleBrowserCommand(client, message)
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

  /** Takes over the browser: learns what exists, then becomes its only auto-attacher. Call once, before any run. */
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

  async function createRun(runKey) {
    if (runs.has(runKey)) throw new Error('This slot already has a browser context')
    // disposeOnDetach:false, so a client disconnecting (a service handing the browser to a person) leaves the context alone.
    const { browserContextId } = await request('Target.createBrowserContext', { disposeOnDetach: false })
    // Files would land on this machine, outside any run's control. Denied from the start, not only if a client asks.
    await request('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: false, browserContextId }).catch(
      (error) => {
        void request('Target.disposeBrowserContext', { browserContextId }).catch(ignore)
        throw error
      }
    )
    runs.set(runKey, { contextId: browserContextId, controller: null, clients: new Set() })
    contextToRun.set(browserContextId, runKey)
    return { contextId: browserContextId }
  }

  async function disposeRun(runKey) {
    const run = runs.get(runKey)
    if (!run) return
    runs.delete(runKey)
    contextToRun.delete(run.contextId)
    for (const client of [...run.clients]) evict(client, 4001, 'The slot was released')
    for (const [id, info] of targets) if (info.browserContextId === run.contextId) targets.delete(id)
    await request('Target.disposeBrowserContext', { browserContextId: run.contextId }).catch(ignore)
  }

  /** Chromium went away: every context and page with it. Clients are told with a code they can tell from a normal close. */
  function onUpstreamClosed() {
    if (closed) return
    closed = true
    for (const entry of pending.values()) entry.reject?.(new Error('The browser connection closed'))
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
