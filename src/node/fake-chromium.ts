/**
 * An in-memory stand-in for Chromium's browser-level DevTools endpoint, enough to test scope.ts without a browser.
 * Not shipped in the image. It mirrors the behaviour the hub depends on, as observed against a real Chromium by
 * test/scope.browser.test.ts (run it when changing either):
 *
 *   - a new target announces itself to an auto-attacher with Target.attachedToTarget BEFORE the createTarget answer,
 *     paused (waitingForDebugger) when the attacher asked for waitForDebuggerOnStart, until it is resumed;
 *   - an explicit attachToTarget also emits Target.attachedToTarget, unpaused, before its answer;
 *   - commands without a browserContextId act on the default context;
 *   - a detached session stops being known, and Chromium answers -32001 for it.
 *
 * Messages are delivered through the microtask queue, in the order they were produced.
 */

const DEFAULT_CONTEXT = 'default-context'

type Params = Record<string, any>

export interface FakeTarget {
  targetId: string
  type: string
  url: string
  browserContextId: string
  openerId?: string
}

export interface FakeSession {
  sessionId: string
  targetId: string
  parent?: string
  paused: boolean
  fetchEnabled: boolean
  childAutoAttach: unknown
}

export interface FakeCommand {
  method: string
  params?: Params
  sessionId?: string
}

/** A command as it arrives from the hub. */
interface Command extends FakeCommand {
  id: number
}

interface FakeContext {
  cookies: unknown[]
  disposeOnDetach?: boolean
}

/** The in-memory Chromium used to test scope.ts and agent.ts without a browser. */
export type FakeChromium = ReturnType<typeof createFakeChromium>

export function createFakeChromium() {
  let seq = 0
  const next = (prefix: string) => `${prefix}-${++seq}`
  const contexts = new Map<string, FakeContext>([[DEFAULT_CONTEXT, { cookies: [] }]])
  const targets = new Map<string, FakeTarget>()
  const sessions = new Map<string, FakeSession>()
  /** Every command the browser received, in order. */
  const log: FakeCommand[] = []
  /** targetId -> window id, handed out the way Chromium numbers windows: browser-wide small integers. */
  const windows = new Map<string, number>()
  let autoAttach: Params | null = null
  let discover = false
  let deliver: (text: string) => void = () => undefined
  let closed = false

  const emit = (method: string, params: unknown, sessionId?: string) => {
    const text = JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) })
    queueMicrotask(() => deliver(text))
  }
  const reply = (id: number, result: unknown, sessionId?: string) => {
    const text = JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) })
    queueMicrotask(() => deliver(text))
  }
  const fail = (id: number, code: number, message: string, sessionId?: string) => {
    const text = JSON.stringify({ id, error: { code, message }, ...(sessionId ? { sessionId } : {}) })
    queueMicrotask(() => deliver(text))
  }

  const info = (target: FakeTarget) => ({
    targetId: target.targetId,
    type: target.type,
    title: '',
    url: target.url,
    attached: [...sessions.values()].some((session) => session.targetId === target.targetId),
    browserContextId: target.browserContextId,
    ...(target.openerId ? { openerId: target.openerId } : {})
  })

  function attachSession(targetId: string, { paused = false, parent }: { paused?: boolean; parent?: string } = {}) {
    const sessionId = next('session')
    sessions.set(sessionId, { sessionId, targetId, parent, paused, fetchEnabled: false, childAutoAttach: null })
    return sessionId
  }

  function createTarget({
    url = 'about:blank',
    browserContextId = DEFAULT_CONTEXT,
    type = 'page',
    openerId
  }: { url?: string; browserContextId?: string; type?: string; openerId?: string } = {}) {
    const targetId = next('target')
    const target: FakeTarget = { targetId, type, url, browserContextId, openerId }
    targets.set(targetId, target)
    if (discover) emit('Target.targetCreated', { targetInfo: info(target) })
    if (autoAttach) {
      const paused = Boolean(autoAttach.waitForDebuggerOnStart)
      const sessionId = attachSession(targetId, { paused })
      emit('Target.attachedToTarget', { sessionId, targetInfo: info(target), waitingForDebugger: paused })
    }
    return targetId
  }

  function detach(sessionId: string): boolean {
    const session = sessions.get(sessionId)
    if (!session) return false
    for (const child of [...sessions.values()]) if (child.parent === sessionId) detach(child.sessionId)
    sessions.delete(sessionId)
    emit('Target.detachedFromTarget', { sessionId, targetId: session.targetId }, session.parent)
    return true
  }

  function closeTarget(targetId: string) {
    for (const session of [...sessions.values()]) if (session.targetId === targetId) detach(session.sessionId)
    targets.delete(targetId)
    if (discover) emit('Target.targetDestroyed', { targetId })
  }

  function receiveBrowser({ id, method, params = {} }: Command) {
    const context = () => contexts.get(params.browserContextId ?? DEFAULT_CONTEXT)
    switch (method) {
      case 'Browser.getVersion':
        return reply(id, { product: 'FakeChrome/1', userAgent: 'FakeChrome' })
      case 'Target.setDiscoverTargets':
        discover = Boolean(params.discover)
        if (discover) for (const target of targets.values()) emit('Target.targetCreated', { targetInfo: info(target) })
        return reply(id, {})
      case 'Target.getTargets':
        return reply(id, { targetInfos: [...targets.values()].map(info) })
      case 'Target.setAutoAttach':
        autoAttach = params.autoAttach ? params : null
        if (autoAttach) {
          for (const target of targets.values()) {
            const sessionId = attachSession(target.targetId)
            emit('Target.attachedToTarget', { sessionId, targetInfo: info(target), waitingForDebugger: false })
          }
        }
        return reply(id, {})
      case 'Target.createBrowserContext': {
        const browserContextId = next('context')
        contexts.set(browserContextId, { cookies: [], disposeOnDetach: params.disposeOnDetach })
        return reply(id, { browserContextId })
      }
      case 'Target.disposeBrowserContext':
        if (!contexts.has(params.browserContextId)) return fail(id, -32602, 'Failed to find context with id')
        for (const target of [...targets.values()]) {
          if (target.browserContextId === params.browserContextId) closeTarget(target.targetId)
        }
        contexts.delete(params.browserContextId)
        return reply(id, {})
      case 'Target.createTarget': {
        if (params.browserContextId && !contexts.has(params.browserContextId)) {
          return fail(id, -32602, 'Failed to find browser context with id ' + params.browserContextId)
        }
        return reply(id, { targetId: createTarget(params) })
      }
      case 'Target.attachToTarget': {
        const target = targets.get(params.targetId)
        if (!target) return fail(id, -32602, 'No target with given id found')
        const sessionId = attachSession(target.targetId)
        emit('Target.attachedToTarget', { sessionId, targetInfo: info(target), waitingForDebugger: false })
        return reply(id, { sessionId })
      }
      case 'Target.detachFromTarget':
        return detach(params.sessionId) ? reply(id, {}) : fail(id, -32001, 'Session with given id not found.')
      case 'Target.closeTarget':
        if (!targets.has(params.targetId)) return fail(id, -32602, 'No target with given id found')
        closeTarget(params.targetId)
        return reply(id, { success: true })
      case 'Target.activateTarget':
        return targets.has(params.targetId) ? reply(id, {}) : fail(id, -32602, 'No target with given id found')
      case 'Target.getTargetInfo': {
        const target = targets.get(params.targetId)
        return target ? reply(id, { targetInfo: info(target) }) : fail(id, -32602, 'No target with given id found')
      }
      case 'Storage.getCookies':
        return reply(id, { cookies: [...(context()?.cookies ?? [])] })
      case 'Storage.setCookies':
        context()?.cookies.push(...(params.cookies ?? []))
        return reply(id, {})
      case 'Storage.clearCookies': {
        const current = context()
        if (current) current.cookies.length = 0
        return reply(id, {})
      }
      case 'Browser.close':
        closed = true
        return reply(id, {})
      case 'Browser.setDownloadBehavior':
      case 'Browser.grantPermissions':
      case 'Browser.resetPermissions':
      case 'SystemInfo.getInfo':
        return reply(id, {})
      default:
        return fail(id, -32601, `'${method}' wasn't found`)
    }
  }

  function receiveSession({ id, method, params = {}, sessionId }: Command & { sessionId: string }) {
    const session = sessions.get(sessionId)
    if (!session) return fail(id, -32001, 'Session with given id not found.', sessionId)
    switch (method) {
      case 'Runtime.runIfWaitingForDebugger':
        session.paused = false
        return reply(id, {}, sessionId)
      case 'Fetch.enable':
        session.fetchEnabled = true
        return reply(id, {}, sessionId)
      case 'Target.setAutoAttach':
        session.childAutoAttach = params
        return reply(id, {}, sessionId)
      case 'Browser.getWindowForTarget': {
        const targetId = params.targetId ?? session.targetId
        if (!windows.has(targetId)) windows.set(targetId, windows.size + 1)
        return reply(
          id,
          { windowId: windows.get(targetId), bounds: { left: 0, top: 0, width: 1280, height: 900 } },
          sessionId
        )
      }
      case 'Target.detachFromTarget':
        return detach(params.sessionId)
          ? reply(id, {}, sessionId)
          : fail(id, -32001, 'Session with given id not found.', sessionId)
      default:
        // Anything a page session is asked: answer with what was sent, so a test can see it arrived intact.
        return reply(id, { method, params }, sessionId)
    }
  }

  return {
    /** The browser's side of the connection: what the hub sends upstream. */
    receive(text: string) {
      const message: Command = JSON.parse(text)
      log.push({ method: message.method, params: message.params, sessionId: message.sessionId })
      if (message.sessionId !== undefined) receiveSession(message as Command & { sessionId: string })
      else receiveBrowser(message)
    },
    /** Where the browser's answers and events go: the hub's onUpstreamMessage. */
    onMessage(handler: (text: string) => void) {
      deliver = handler
    },
    contexts,
    targets,
    sessions,
    log,
    DEFAULT_CONTEXT,
    wasClosed: () => closed,
    commands: (method: string) => log.filter((entry) => entry.method === method),
    cookies: (contextId: string = DEFAULT_CONTEXT) => contexts.get(contextId)?.cookies ?? [],
    sessionsOf: (targetId: string) =>
      [...sessions.values()].filter((session) => session.targetId === targetId).map((s) => s.sessionId),
    isPaused: (targetId: string) =>
      [...sessions.values()].some((session) => session.targetId === targetId && session.paused),
    /** A tab that appears by itself (the default-context page, or a tab another client made). */
    createTarget,
    /** A page script calling window.open: a new tab in the opener's context. */
    openPopup(sessionId: string) {
      const opener = targets.get(sessions.get(sessionId)!.targetId)!
      return createTarget({ url: 'about:blank', browserContextId: opener.browserContextId, openerId: opener.targetId })
    },
    /** A frame or worker attached under a page session that asked for auto-attach. Announced on the parent session. */
    addChildSession(parentSessionId: string, { type = 'iframe' }: { type?: string } = {}) {
      const parent = sessions.get(parentSessionId)!
      const owner = targets.get(parent.targetId)!
      const targetId = next('target')
      const target: FakeTarget = { targetId, type, url: 'about:blank', browserContextId: owner.browserContextId }
      targets.set(targetId, target)
      const sessionId = attachSession(targetId, { paused: true, parent: parentSessionId })
      emit(
        'Target.attachedToTarget',
        { sessionId, targetInfo: info(target), waitingForDebugger: true },
        parentSessionId
      )
      return sessionId
    },
    emitSessionEvent: (sessionId: string, method: string, params?: unknown) => emit(method, params, sessionId),
    /** Lets everything queued so far be delivered, however many hops it takes. */
    flush: () => new Promise<void>((resolve) => setImmediate(resolve))
  }
}
