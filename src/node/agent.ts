/**
 * The node agent: the part of a browser node that talks to the relay. Everything it does is outbound, so a node
 * works from any provider, behind NAT, or on a laptop with no open port.
 *
 *   - one long-lived CONTROL socket (wss://relay/v1/nodes/connect): authenticates in its first frame, sends
 *     heartbeats that list the node's contexts, and receives context.create / context.release / stream.open;
 *   - one short-lived STREAM socket (wss://relay/v1/nodes/stream/<id>) per client CDP connection, dialled when the relay
 *     asks for it and bound to that run's virtual browser (scope.ts). It carries raw DevTools JSON and nothing else.
 *
 * It owns the leases that stop a crashed client from leaking browsers: every context closes itself after the maximum
 * lifetime the relay gave it, even while the relay is unreachable. Contexts survive a relay outage or restart (a run
 * may be waiting on a person); on reconnect the node lists them in its hello and the relay adopts the ones it knows.
 *
 * No dependencies: it uses Node's built-in WebSocket client.
 */

import { createBacklogGuard } from '../backlog-guard.js'
import {
  CLOSE,
  NODE_PROTOCOL_VERSION,
  RELAY_PATHS,
  type NodeContextReport,
  type NodeToRelay,
  type RelayToNode
} from '../protocol.js'
import { featuresFor, parseNodeSlotOptions, SlotRefusedError } from '../slot-options.js'
import type { RunHost, ScopeClient } from './scope.js'

const OPEN = 1

/** The built-in WebSocket client can only send 1000 or 3000-4999; anything else becomes a generic application code. */
const sendableCode = (code: number) => (code === 1000 || (code >= 3000 && code <= 4999) ? code : 4500)
/** A close reason is limited to 123 bytes. */
const closeReason = (reason: unknown) => String(reason ?? '').slice(0, 100)

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.*\.localhost)$/

/** What kind of address a relay URL names, which decides whether the enrollment secret may be sent to it. */
export type RelayAddress =
  | 'tls' // https or wss
  | 'loopback' // plain, but on this machine
  | 'private' // plain, on a network that is not the public internet (private ranges, cluster-local names)
  | 'public' // plain, anywhere else
  | 'unsupported' // not http(s) or ws(s) at all

const isPrivateIPv4 = (host: string) => {
  const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!octets) return false
  const [a, b] = [Number(octets[1]), Number(octets[2])]
  // 10/8, 172.16/12, 192.168/16, link-local 169.254/16 and the shared range 100.64/10 (carrier-grade NAT, some clusters).
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}
// fc00::/7 (unique local) and fe80::/10 (link-local). The URL parser has already written the address in full groups.
const isPrivateIPv6 = (host: string) => /^\[(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host)
// A single label ("relay", as a Service answers inside its namespace), or a name that only exists on a private network.
const isPrivateName = (host: string) =>
  (!host.includes('.') && !host.includes(':')) ||
  /\.(svc|internal|local)$/.test(host) ||
  host.endsWith('.svc.cluster.local')

/** Classifies a relay URL. The one place that says what counts as TLS, loopback and private. */
export function classifyRelayUrl(relayUrl: string): RelayAddress {
  const url = new URL(relayUrl)
  if (url.protocol === 'https:' || url.protocol === 'wss:') return 'tls'
  if (url.protocol !== 'http:' && url.protocol !== 'ws:') return 'unsupported'
  const host = url.hostname
  if (LOOPBACK.test(host)) return 'loopback'
  return isPrivateIPv4(host) || isPrivateIPv6(host) || isPrivateName(host) ? 'private' : 'public'
}

/**
 * The enrollment secret travels in the first frame, so the relay must be reached over TLS unless it is on this
 * machine. Throws for a plain ws:// or http:// address anywhere else, unless `allowInsecure` is set: an explicit
 * opt-in for a network the operator trusts (an in-cluster Service, a private link), where TLS is not wanted.
 * `allowInsecure` only covers plain http and ws to a private address. A public address, or any other protocol, is
 * still refused, so a wrong address cannot send the secret across the internet in the clear.
 */
export function assertSecureRelayUrl(
  relayUrl: string,
  { allowInsecure = false }: { allowInsecure?: boolean } = {}
): void {
  const kind = classifyRelayUrl(relayUrl)
  if (kind === 'tls' || kind === 'loopback' || (kind === 'private' && allowInsecure)) return
  if (kind === 'public' && allowInsecure) {
    throw new Error(
      `The relay URL must use https (or wss): BROWSERBAY_ALLOW_INSECURE_RELAY only covers a relay on a private network (a private IP range, a single-label or .svc/.internal/.local name), and ${new URL(relayUrl).hostname} is not one`
    )
  }
  throw new Error(
    'The relay URL must use https (or wss) unless the relay runs on this machine ' +
      '(or BROWSERBAY_ALLOW_INSECURE_RELAY=true says the private network between them is trusted)'
  )
}

/** True when the enrollment secret would travel without TLS to another machine: only the opt-in allows that. */
export function sendsSecretInTheClear(relayUrl: string): boolean {
  const kind = classifyRelayUrl(relayUrl)
  return kind === 'private' || kind === 'public'
}

export interface AgentLogger {
  info?(message: string, fields?: Record<string, unknown>): void
  warn?(message: string, fields?: Record<string, unknown>): void
}

export interface AgentOptions {
  /** The relay's base URL (http(s):// or ws(s)://), with any path prefix it is served under. */
  relayUrl: string
  /**
   * Allow a plain http or ws relay address on another machine. The enrollment secret then crosses that network
   * without TLS, so this is only for one the operator trusts. A warning is logged whenever it is in effect.
   */
  allowInsecureRelay?: boolean
  enrollmentSecret: string
  nodeId: string
  /** What holds this node's browsers: a started scope hub in front of its Chromium, or a Chromium per slot. */
  scope: RunHost
  maxContexts?: number
  /**
   * What this node can do for a slot beyond giving it a browser (NODE_FEATURE), told to the relay so it only sends a slot that
   * asks for one to a node that has it. A node refuses a `context.create` that needs one it was not given.
   */
  features?: string[]
  /** What this node's operator calls it, told to the relay so a slot can ask for it. */
  labels?: string[]
  /** Only take slots that ask for one of this node's labels. */
  exclusive?: boolean
  heartbeatMs?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
  /** A stream whose unsent data stays above this for `slowConsumerGraceMs` is closed: a viewer that cannot keep up must not grow the node's memory. */
  maxBufferedBytes?: number
  slowConsumerGraceMs?: number
  logger?: AgentLogger
  WebSocketImpl?: typeof WebSocket
  random?: () => number
}

export interface Agent {
  /** Resolves once the relay has accepted this node. */
  whenConnected(timeoutMs?: number): Promise<void>
  contextCount(): number
  contextIds(): string[]
  isConnected(): boolean
  /** Stops taking new contexts and waits for the existing ones to end (or `timeoutMs`). */
  drain(timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

/** A context this node holds for a slot: what the relay is told about it, and the timer that ends its lease. */
interface Context extends NodeContextReport {
  timer: NodeJS.Timeout
}

/** A caller of `whenConnected`: settled by the welcome, by `close()`, or by its own timeout. */
interface ConnectWaiter {
  resolve(): void
  reject(error: Error): void
}

export function startAgent({
  relayUrl,
  allowInsecureRelay = false,
  enrollmentSecret,
  nodeId,
  scope,
  maxContexts = 5,
  features = [],
  labels = [],
  exclusive = false,
  heartbeatMs = 5000,
  reconnectMinMs = 500,
  reconnectMaxMs = 15_000,
  maxBufferedBytes = 16 * 1024 * 1024,
  slowConsumerGraceMs = 10_000,
  logger = {},
  WebSocketImpl = globalThis.WebSocket,
  random = Math.random
}: AgentOptions): Agent {
  const log = (level: keyof AgentLogger, message: string, fields?: Record<string, unknown>) =>
    logger[level]?.(message, fields)

  assertSecureRelayUrl(relayUrl, { allowInsecure: allowInsecureRelay })
  if (allowInsecureRelay && sendsSecretInTheClear(relayUrl)) {
    log(
      'warn',
      `The enrollment secret is sent to ${new URL(relayUrl).origin} without TLS (BROWSERBAY_ALLOW_INSECURE_RELAY). Only do this on a network you trust.`
    )
  }
  const base = new URL(relayUrl)
  base.protocol = base.protocol === 'https:' || base.protocol === 'wss:' ? 'wss:' : 'ws:'
  const urlFor = (path: string) => {
    const url = new URL(base)
    url.pathname = url.pathname.replace(/\/$/, '') + path
    url.search = ''
    return url.toString()
  }

  const contexts = new Map<string, Context>()
  /**
   * Creates in flight, and contexts being closed: both still hold a browser, so both count against capacity. Two creates
   * arriving together cannot both take the last slot, and a slot released and re-acquired at once cannot start a new
   * browser while the old one is still shutting down (it matters when a slot is a whole Chromium).
   */
  let reserved = 0
  const streams = new Set<WebSocket>()
  let control: WebSocket | null = null
  let heartbeatTimer: NodeJS.Timeout | undefined
  let reconnectTimer: NodeJS.Timeout | undefined
  let attempt = 0
  let draining = false
  let closing = false
  let helloAcknowledged = false
  let lastConnectionError = ''
  const waiters = new Set<() => void>()
  const connectWaiters = new Set<ConnectWaiter>()

  const reports = (): NodeContextReport[] =>
    [...contexts.values()].map(({ slotId, runId, tokenHash, createdAt }) => ({ slotId, runId, tokenHash, createdAt }))

  function sendControl(message: NodeToRelay) {
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
        contexts: reports(),
        // Left out when empty: a plain node's hello is what it always was.
        ...(features.length > 0 ? { features } : {}),
        ...(labels.length > 0 ? { labels } : {}),
        ...(exclusive ? { exclusive } : {})
      })
    })
    socket.addEventListener('message', (event) => onControlMessage(event.data))
    socket.addEventListener('close', (event) => onControlClosed(socket, event))
    // A failed connection is followed by a close event, which is where it is handled; this only keeps what it said.
    socket.addEventListener('error', (event) => {
      const detail = event as { message?: string; error?: { message?: string; cause?: { code?: string } } }
      lastConnectionError = String(detail.message || detail.error?.cause?.code || detail.error?.message || '')
    })
  }

  function onControlClosed(socket: WebSocket, event: { code?: number }) {
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

  function onControlMessage(data: unknown) {
    let message: RelayToNode
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

  async function createContext({
    reqId,
    slotId,
    runId,
    tokenHash,
    maxLifetimeSeconds,
    options
  }: Extract<RelayToNode, { t: 'context.create' }>) {
    if (draining) return sendControl({ t: 'context.failed', reqId, message: 'This node is draining' })
    if (contexts.size + reserved >= maxContexts) {
      return sendControl({ t: 'context.failed', reqId, message: 'This node is full' })
    }
    // What the slot asked for is checked again here (a timezone becomes an environment variable, a proxy a listener), and a node
    // that cannot do all of it says so: a slot made without its proxy would go out from this node's own address.
    const asked = parseNodeSlotOptions(options)
    if (!asked.ok) return sendControl({ t: 'context.failed', reqId, message: asked.message, refused: true })
    const missing = featuresFor(asked.value).filter((feature) => !features.includes(feature))
    if (missing.length > 0) {
      return sendControl({
        t: 'context.failed',
        reqId,
        message: `This node does not offer: ${missing.join(', ')}`,
        refused: true
      })
    }
    reserved++
    try {
      await scope.createRun(slotId, Object.keys(asked.value).length > 0 ? asked.value : undefined)
      const timer = setTimeout(() => void releaseContext(slotId, 'maximum lifetime reached'), maxLifetimeSeconds * 1000)
      timer.unref?.()
      contexts.set(slotId, { slotId, runId, tokenHash, createdAt: new Date().toISOString(), timer })
      sendControl({ t: 'context.created', reqId })
    } catch (error) {
      log('warn', 'Could not create a context', { slotId, error: String(error) })
      if (error instanceof SlotRefusedError)
        sendControl({ t: 'context.failed', reqId, message: error.message, refused: true })
      else sendControl({ t: 'context.failed', reqId, message: 'The browser could not create a context' })
    } finally {
      reserved--
      notifyIdle()
    }
  }

  async function releaseContext(slotId: string, reason: string) {
    const context = contexts.get(slotId)
    if (!context) return
    clearTimeout(context.timer)
    contexts.delete(slotId)
    reserved++
    log('info', 'Closing a context', { slotId, reason })
    try {
      await scope
        .disposeRun(slotId)
        .catch((error) => log('warn', 'Could not close a context', { slotId, error: String(error) }))
    } finally {
      reserved--
    }
    sendHeartbeat()
    notifyIdle()
  }

  // ---- streams ----------------------------------------------------------------------------------------------

  function openStream({ streamId, slotId }: Extract<RelayToNode, { t: 'stream.open' }>) {
    if (!contexts.has(slotId)) {
      return sendControl({ t: 'stream.failed', streamId, message: 'No such context on this node' })
    }
    const socket = new WebSocketImpl(urlFor(RELAY_PATHS.nodeStream(streamId)))
    streams.add(socket)
    let client: ScopeClient | null = null
    const tooSlow = createBacklogGuard({ maxBytes: maxBufferedBytes, graceMs: slowConsumerGraceMs })
    const end = (code: number, reason?: string) => {
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

  // A slot's own browser that dies takes only that slot with it: end the context rather than keep reporting it live.
  scope.onRunEnded?.((slotId, reason) => {
    if (!contexts.has(slotId)) return
    // Say so now, so the relay stops handing out a slot that is gone instead of waiting to notice it in a heartbeat.
    sendControl({ t: 'context.ended', slotId, reason })
    void releaseContext(slotId, reason)
  })

  connect()

  return {
    whenConnected(timeoutMs = 10_000) {
      if (helloAcknowledged) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const settle = (finish: () => void) => {
          clearTimeout(timer)
          connectWaiters.delete(waiter)
          finish()
        }
        const waiter: ConnectWaiter = { resolve: () => settle(resolve), reject: (error) => settle(() => reject(error)) }
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
    async drain(timeoutMs = 120_000) {
      draining = true
      sendHeartbeat()
      if (contexts.size === 0 && reserved === 0) return
      await new Promise<void>((resolve) => {
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
      // CONNECTING (0) as well as OPEN (1): a connection still being made has to be abandoned too, or it completes after
      // this and is never closed by anyone, which keeps the process (and the relay's own shutdown) waiting for it.
      for (const socket of [...streams]) if (socket.readyState <= OPEN) socket.close(1000, 'The node is stopping')
      for (const { timer } of contexts.values()) clearTimeout(timer)
      if (control && control.readyState <= OPEN) control.close(1000, 'The node is stopping')
      control = null
      for (const resolve of [...waiters]) resolve()
      for (const waiter of [...connectWaiters]) waiter.reject(new Error('The agent was closed'))
    }
  }
}
