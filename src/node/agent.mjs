/**
 * The node agent: the part of a browser node that talks to the relay. Everything it does is outbound, so a node
 * works from any provider, behind NAT, or on a laptop with no open port.
 *
 *   - one long-lived CONTROL socket (wss://relay/v1/nodes/connect): authenticates in its first frame, sends
 *     heartbeats that list the node's contexts, and receives context.create / context.release / stream.open;
 *   - one short-lived STREAM socket (wss://relay/v1/nodes/stream/<id>) per client CDP connection, dialled when the relay
 *     asks for it and bound to that run's virtual browser (scope.mjs). It carries raw DevTools JSON and nothing else.
 *
 * It owns the leases that stop a crashed client from leaking browsers: every context closes itself after the maximum
 * lifetime the relay gave it, even while the relay is unreachable. Contexts survive a relay outage or restart (a run
 * may be waiting on a person); on reconnect the node lists them in its hello and the relay adopts the ones it knows.
 *
 * Plain Node, no dependencies: it uses Node's built-in WebSocket client.
 */

import { CLOSE, NODE_PROTOCOL_VERSION, RELAY_PATHS } from '../protocol.js'

export { NODE_PROTOCOL_VERSION }
const OPEN = 1

/** The built-in WebSocket client can only send 1000 or 3000-4999; anything else becomes a generic application code. */
const sendableCode = (code) => (code === 1000 || (code >= 3000 && code <= 4999) ? code : 4500)
/** A close reason is limited to 123 bytes. */
const closeReason = (reason) => String(reason ?? '').slice(0, 100)

/**
 * Decides when a connection's consumer is too slow to keep. The question is not "is a lot of data waiting right now":
 * one legitimate message (a full-page screenshot is tens of MB) leaves the buffer high until it drains, and the very
 * next message would then look like an overload. A consumer is too slow when its backlog stays above `maxBytes` for
 * longer than `graceMs`. Call the returned function with the socket's bufferedAmount before each send.
 * (relay/server.ts has the same logic on the relay side: relay/backlog-guard.ts.)
 */
export function createBacklogGuard({ maxBytes, graceMs, now = Date.now }) {
  let overSince = null
  return (bufferedBytes) => {
    if (bufferedBytes <= maxBytes) {
      overSince = null
      return false
    }
    overSince ??= now()
    return now() - overSince > graceMs
  }
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.*\.localhost)$/

/**
 * The enrollment secret travels in the first frame, so the relay must be reached over TLS unless it is on this
 * machine. Throws for a plain ws:// or http:// address anywhere else.
 */
export function assertSecureRelayUrl(relayUrl) {
  const url = new URL(relayUrl)
  const tls = url.protocol === 'https:' || url.protocol === 'wss:'
  const plain = url.protocol === 'http:' || url.protocol === 'ws:'
  if (!tls && !(plain && LOOPBACK.test(url.hostname))) {
    throw new Error('The relay URL must use https (or wss) unless the relay runs on this machine')
  }
}

export function startAgent({
  relayUrl,
  enrollmentSecret,
  nodeId,
  scope,
  maxContexts = 5,
  heartbeatMs = 5000,
  reconnectMinMs = 500,
  reconnectMaxMs = 15_000,
  /** A stream whose unsent data stays above this for `slowConsumerGraceMs` is closed: a viewer that cannot keep up must not grow the node's memory. */
  maxBufferedBytes = 16 * 1024 * 1024,
  slowConsumerGraceMs = 10_000,
  logger = {},
  WebSocketImpl = globalThis.WebSocket,
  random = Math.random
}) {
  const log = (level, message, fields) => logger[level]?.(message, fields)

  assertSecureRelayUrl(relayUrl)
  const base = new URL(relayUrl)
  base.protocol = base.protocol === 'https:' || base.protocol === 'wss:' ? 'wss:' : 'ws:'
  const urlFor = (path) => {
    const url = new URL(base)
    url.pathname = url.pathname.replace(/\/$/, '') + path
    url.search = ''
    return url.toString()
  }

  /** slotId -> { slotId, runId, tokenHash, createdAt, timer } */
  const contexts = new Map()
  /** Creates in flight, counted against capacity so two arriving together cannot both take the last slot. */
  let reserved = 0
  const streams = new Set()
  let control = null
  let heartbeatTimer = null
  let reconnectTimer = null
  let attempt = 0
  let draining = false
  let closing = false
  let helloAcknowledged = false
  let lastConnectionError = ''
  const waiters = new Set()
  /** Callers of whenConnected: settled by the welcome, by close(), or by their own timeout. */
  const connectWaiters = new Set()

  const reports = () =>
    [...contexts.values()].map(({ slotId, runId, tokenHash, createdAt }) => ({ slotId, runId, tokenHash, createdAt }))

  function sendControl(message) {
    if (control?.readyState === OPEN) control.send(JSON.stringify(message))
  }

  function sendHeartbeat() {
    sendControl({ t: 'heartbeat', draining, contexts: reports() })
  }

  function notifyIdle() {
    if (contexts.size === 0 && reserved === 0) for (const resolve of [...waiters]) resolve()
  }

  // ---- control socket ---------------------------------------------------------------------------------------

  function connect() {
    if (closing) return
    const socket = new WebSocketImpl(urlFor(RELAY_PATHS.nodeConnect))
    control = socket
    lastConnectionError = ''
    socket.addEventListener('open', () => {
      sendControl({
        t: 'hello',
        secret: enrollmentSecret,
        nodeId,
        maxContexts,
        version: NODE_PROTOCOL_VERSION,
        contexts: reports()
      })
    })
    socket.addEventListener('message', (event) => onControlMessage(event.data))
    socket.addEventListener('close', (event) => onControlClosed(socket, event))
    // A failed connection is followed by a close event, which is where it is handled; this only keeps what it said.
    socket.addEventListener('error', (event) => {
      lastConnectionError = String(event?.message || event?.error?.cause?.code || event?.error?.message || '')
    })
  }

  function onControlClosed(socket, event) {
    if (socket !== control) return
    const wasConnected = helloAcknowledged
    control = null
    helloAcknowledged = false
    clearInterval(heartbeatTimer)
    if (closing) return
    if (event?.code === CLOSE.invalidHello) {
      log('warn', 'The relay refused this node: its id or slot count is not valid for this relay', {
        nodeId,
        maxContexts
      })
    } else if (event?.code === CLOSE.unauthorized) {
      log('warn', 'The relay rejected this node’s enrollment secret')
    } else if (event?.code === CLOSE.unsupportedVersion) {
      log('warn', 'The relay speaks a different protocol version than this node')
    } else if (event?.code === CLOSE.replaced) {
      log('warn', 'Another node with this id connected to the relay and took its place: is the node id unique?', {
        nodeId
      })
    } else if (wasConnected) {
      log('warn', 'Lost the connection to the relay; reconnecting', { code: event?.code })
    } else if (attempt < 3 || attempt % 10 === 0) {
      // Never got in: the address, the network and TLS are the usual causes. Said at the start and now and then.
      log('warn', 'Could not connect to the relay; retrying', {
        relay: new URL(relayUrl).origin,
        attempt: attempt + 1,
        ...(lastConnectionError ? { error: lastConnectionError } : {})
      })
    }
    const delay = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** attempt) * (0.5 + random() / 2)
    attempt++
    reconnectTimer = setTimeout(connect, delay)
    reconnectTimer.unref?.()
  }

  function onControlMessage(data) {
    let message
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null) return
    switch (message.t) {
      case 'welcome':
        if (message.version !== undefined && message.version !== NODE_PROTOCOL_VERSION) {
          log('warn', 'The relay speaks a different protocol version than this node', { relay: message.version })
        }
        helloAcknowledged = true
        for (const waiter of [...connectWaiters]) waiter.resolve()
        attempt = 0
        clearInterval(heartbeatTimer)
        heartbeatTimer = setInterval(sendHeartbeat, message.heartbeatMs || heartbeatMs)
        heartbeatTimer.unref?.()
        log('info', 'Connected to the relay', { nodeId, contexts: contexts.size })
        return
      case 'context.create':
        return void createContext(message)
      case 'context.release':
        return void releaseContext(message.slotId, 'released by the relay')
      case 'stream.open':
        return openStream(message)
      default:
        return
    }
  }

  // ---- contexts ---------------------------------------------------------------------------------------------

  async function createContext({ reqId, slotId, runId, tokenHash, maxLifetimeSeconds }) {
    if (draining) return sendControl({ t: 'context.failed', reqId, message: 'This node is draining' })
    if (contexts.size + reserved >= maxContexts) {
      return sendControl({ t: 'context.failed', reqId, message: 'This node is full' })
    }
    reserved++
    try {
      await scope.createRun(slotId)
      const timer = setTimeout(() => void releaseContext(slotId, 'maximum lifetime reached'), maxLifetimeSeconds * 1000)
      timer.unref?.()
      contexts.set(slotId, { slotId, runId, tokenHash, createdAt: new Date().toISOString(), timer })
      sendControl({ t: 'context.created', reqId })
    } catch (error) {
      log('warn', 'Could not create a context', { slotId, error: String(error) })
      sendControl({ t: 'context.failed', reqId, message: 'The browser could not create a context' })
    } finally {
      reserved--
      notifyIdle()
    }
  }

  async function releaseContext(slotId, reason) {
    const context = contexts.get(slotId)
    if (!context) return
    clearTimeout(context.timer)
    contexts.delete(slotId)
    log('info', 'Closing a context', { slotId, reason })
    await scope
      .disposeRun(slotId)
      .catch((error) => log('warn', 'Could not close a context', { slotId, error: String(error) }))
    sendHeartbeat()
    notifyIdle()
  }

  // ---- streams ----------------------------------------------------------------------------------------------

  function openStream({ streamId, slotId }) {
    if (!contexts.has(slotId)) {
      return sendControl({ t: 'stream.failed', streamId, message: 'No such context on this node' })
    }
    const socket = new WebSocketImpl(urlFor(RELAY_PATHS.nodeStream(streamId)))
    streams.add(socket)
    let client = null
    const tooSlow = createBacklogGuard({ maxBytes: maxBufferedBytes, graceMs: slowConsumerGraceMs })
    const end = (code, reason) => {
      if (socket.readyState === OPEN) socket.close(sendableCode(code), closeReason(reason))
    }
    socket.addEventListener('open', () => {
      try {
        client = scope.connect(slotId, {
          send(text) {
            if (socket.readyState !== OPEN) return
            if (tooSlow(socket.bufferedAmount)) {
              log('warn', 'Closing a stream that cannot keep up', { slotId })
              end(CLOSE.slowConsumer, 'The client cannot keep up')
              client?.close()
              return
            }
            socket.send(text)
          },
          close: end
        })
      } catch {
        // The context was released between the relay's request and this connection.
        end(4404, 'No such context')
      }
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') client?.handleMessage(event.data)
    })
    const finish = () => {
      streams.delete(socket)
      client?.close()
    }
    socket.addEventListener('close', finish)
    socket.addEventListener('error', finish)
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------

  connect()

  return {
    /** Resolves once the relay has accepted this node. */
    whenConnected(timeoutMs = 10_000) {
      if (helloAcknowledged) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const settle = (finish) => {
          clearTimeout(timer)
          connectWaiters.delete(waiter)
          finish()
        }
        const waiter = { resolve: () => settle(resolve), reject: (error) => settle(() => reject(error)) }
        const timer = setTimeout(
          () => waiter.reject(new Error('The relay did not accept this node in time')),
          timeoutMs
        )
        timer.unref?.()
        connectWaiters.add(waiter)
      })
    },
    contextCount: () => contexts.size,
    contextIds: () => [...contexts.keys()],
    isConnected: () => helloAcknowledged,
    /** Stops taking new contexts and waits for the existing ones to end (or `timeoutMs`). */
    async drain(timeoutMs = 120_000) {
      draining = true
      sendHeartbeat()
      if (contexts.size === 0 && reserved === 0) return
      await new Promise((resolve) => {
        const timer = setTimeout(done, timeoutMs)
        function done() {
          clearTimeout(timer)
          waiters.delete(done)
          resolve()
        }
        waiters.add(done)
      })
    },
    async close() {
      closing = true
      clearTimeout(reconnectTimer)
      clearInterval(heartbeatTimer)
      for (const socket of [...streams]) if (socket.readyState === OPEN) socket.close(1000, 'The node is stopping')
      for (const { timer } of contexts.values()) clearTimeout(timer)
      if (control?.readyState === OPEN) control.close(1000, 'The node is stopping')
      control = null
      for (const resolve of [...waiters]) resolve()
      for (const waiter of [...connectWaiters]) waiter.reject(new Error('The agent was closed'))
    }
  }
}
