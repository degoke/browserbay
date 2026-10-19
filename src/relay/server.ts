import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { createBacklogGuard } from '../backlog-guard.js'
import {
  AllocationAbortedError,
  createNodeRegistry,
  hashToken,
  NoCapacityError,
  UnsupportedError,
  type NodeLink,
  type NodeRegistry
} from './registry.js'
import {
  appliedNames,
  featuresFor,
  parseNodeLabels,
  parseSlotOptions,
  REQUEST_FIELDS,
  sanitizeFeatures,
  sanitizeLabels
} from '../slot-options.js'
import {
  CLOSE,
  NODE_LIMITS,
  NODE_PROTOCOL_VERSION,
  RELAY_PATHS,
  SLOT_LIMITS,
  TOKEN_HEADER,
  type CreateSlotRequest,
  type CreateSlotResponse,
  type ListNodesResponse,
  type ListSlotsResponse,
  type NodeContextReport,
  type NodeToRelay,
  type RelayErrorResponse,
  type SlotStatusResponse
} from '../protocol.js'

export interface EnrollmentSecret {
  /** A name for the node (or group of nodes) holding the secret, for logs. */
  id: string
  /** sha256 hex of the secret. The relay never holds the secret itself. */
  sha256: string
}

export interface ApiKeyEntry {
  /** A name for the key, for logs. */
  id: string
  /** sha256 hex of the key. The relay never holds the key itself. */
  sha256: string
  /**
   * Confines the key to one namespace: it may only create slots whose run id starts with `<namespace>:`, and it only
   * sees and releases such slots. A key without one reaches every slot and the node list.
   */
  namespace?: string
  /** The most slots the namespace may hold at once (needs a namespace). */
  maxSlots?: number
}

export interface RelayLogger {
  info?(message: string, fields?: Record<string, unknown>): void
  warn?(message: string, fields?: Record<string, unknown>): void
}

export interface RelayOptions {
  /** An unrestricted key, as the secret itself. Shorthand for an `apiKeys` entry named `default` with no namespace. */
  apiKey?: string
  /** Keys by hash, each optionally confined to a namespace with a quota. At least one of `apiKey` and `apiKeys` is needed. */
  apiKeys?: ApiKeyEntry[]
  enrollmentSecrets: EnrollmentSecret[]
  heartbeatMs?: number
  nodeTimeoutMs?: number
  helloTimeoutMs?: number
  /** How long a client CDP connection waits for its node to dial back with a stream. */
  streamTimeoutMs?: number
  /** The most a slot request may wait for capacity, whatever it asks for. */
  maxAcquireWaitMs?: number
  /** Largest single DevTools message passed through (a full-page screenshot can be tens of MB). */
  maxMessageBytes?: number
  /** A stream whose unsent data stays above this for `slowConsumerGraceMs` is closed instead of growing memory. */
  maxBufferedBytes?: number
  slowConsumerGraceMs?: number
  createTimeoutMs?: number
  /** After the relay starts, a request no connected node could serve waits like any other (see the registry). Default 15 s. */
  unsupportedGraceMs?: number
  sweepMs?: number
  logger?: RelayLogger
  now?: () => number
}

const MAX_BODY_BYTES = 16 * 1024
const MAX_QUEUED_BYTES = 8 * 1024 * 1024
const NODE_ID = NODE_LIMITS.nodeIdPattern

const digest = (value: string) => createHash('sha256').update(value).digest()
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b))

/** The close codes a WebSocket may send: 1005, 1006 and friends only ever describe what was received. */
function sendableCode(code: number) {
  const ok =
    code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
  return ok ? code : 1011
}

const rawLength = (data: RawData) =>
  Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.length, 0) : data.byteLength

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const fail = (res: ServerResponse, status: number, error: RelayErrorResponse['error'], message?: string) =>
  json(res, status, message === undefined ? { error } : ({ error, message } satisfies RelayErrorResponse))

function rejectUpgrade(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
}

/** The path of a request target, or null when the target is not a URL at all (a client can send `//[`). */
function pathOf(req: IncomingMessage) {
  try {
    return new URL(req.url ?? '/', 'http://relay').pathname
  } catch {
    return null
  }
}

interface PendingStream {
  resolve: (socket: WebSocket) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * The relay: the one thing in a box that listens. Node agents dial in (control + stream sockets), your services
 * dial in (REST + CDP), and nothing else is exposed: DevTools itself never leaves a node. See protocol.js for the
 * contract and registry.ts for the scheduler behind it.
 */
export function createRelayServer(options: RelayOptions) {
  const logger = options.logger ?? {}
  const heartbeatMs = options.heartbeatMs ?? 5000
  const helloTimeoutMs = options.helloTimeoutMs ?? 5000
  const streamTimeoutMs = options.streamTimeoutMs ?? 10_000
  const maxAcquireWaitMs = options.maxAcquireWaitMs ?? 60_000
  const maxMessageBytes = options.maxMessageBytes ?? 128 * 1024 * 1024
  const maxBufferedBytes = options.maxBufferedBytes ?? 32 * 1024 * 1024
  const slowConsumerGraceMs = options.slowConsumerGraceMs ?? 10_000
  const now = options.now ?? Date.now

  const clientSockets = new Map<string, Set<WebSocket>>()
  const pendingStreams = new Map<string, PendingStream>()

  const registry: NodeRegistry = createNodeRegistry({
    now: options.now,
    nodeTimeoutMs: options.nodeTimeoutMs,
    createTimeoutMs: options.createTimeoutMs,
    unsupportedGraceMs: options.unsupportedGraceMs,
    onCreateFailed(nodeId, error) {
      logger.warn?.('A node could not create a context', { nodeId, error: String(error) })
    },
    onSlotRemoved(slotId, reason) {
      logger.info?.('Slot removed', { slotId, reason })
      for (const socket of clientSockets.get(slotId) ?? []) socket.close(4001, 'The slot was released')
    }
  })

  const wssOptions = { noServer: true, perMessageDeflate: false } as const
  const nodeWss = new WebSocketServer({ ...wssOptions, maxPayload: 1024 * 1024 })
  const streamWss = new WebSocketServer({ ...wssOptions, maxPayload: maxMessageBytes })
  const clientWss = new WebSocketServer({ ...wssOptions, maxPayload: maxMessageBytes })

  const apiKeys: ApiKeyEntry[] = [
    ...(options.apiKey ? [{ id: 'default', sha256: hashToken(options.apiKey) }] : []),
    ...(options.apiKeys ?? [])
  ]
  if (apiKeys.length === 0) throw new TypeError('The relay needs an apiKey or at least one entry in apiKeys')

  /** The key a request presents, or undefined. */
  const authenticateKey = (req: IncomingMessage) => {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
    const presented = hashToken(header.slice(7))
    let matched: ApiKeyEntry | undefined
    // No early exit: how long this takes must not depend on which key matched.
    for (const entry of apiKeys) if (safeEqual(presented, entry.sha256.toLowerCase())) matched = entry
    return matched
  }
  /** A namespaced key owns the run ids that start with `<namespace>:`; a name has no ':', so `a` never owns `a:b:`'s. */
  const inNamespace = (key: ApiKeyEntry, runId: string) => !key.namespace || runId.startsWith(`${key.namespace}:`)
  /** Creates a key's namespace has been asked for and not yet answered: they count against its quota already. */
  const inFlight = new Map<string, number>()
  const runToken = (req: IncomingMessage) => {
    const value = req.headers[TOKEN_HEADER]
    return typeof value === 'string' ? value : undefined
  }

  // ---- REST ----------------------------------------------------------------------------------------------------

  async function handleHttp(req: IncomingMessage, res: ServerResponse) {
    const path = pathOf(req)
    const method = req.method ?? 'GET'
    if (path === null) return fail(res, 400, 'invalid_request')
    try {
      if (method === 'GET' && path === RELAY_PATHS.health) return json(res, 200, { status: 'ok' })

      const slotMatch = /^\/v1\/slots\/([\w-]+)$/.exec(path)
      // The slot token, not the API key: this is how a client asks "is my browser still there?".
      if (slotMatch && method === 'GET') {
        const slot = registry.authorize(slotMatch[1]!, runToken(req))
        if (!slot) return fail(res, 404, 'not_found')
        if (!registry.linkFor(slot.slotId)) return fail(res, 503, 'node_unavailable')
        const summary = registry.getSlot(slot.slotId) as SlotStatusResponse
        return json(res, 200, summary)
      }

      const key = authenticateKey(req)
      if (!key) return fail(res, 401, 'unauthorized')

      if (path === RELAY_PATHS.slots && method === 'POST') return await createSlot(req, res, key)
      if (path === RELAY_PATHS.slots && method === 'GET') {
        const slots = registry.listSlots((runId) => inNamespace(key, runId))
        return json(res, 200, { slots } satisfies ListSlotsResponse)
      }
      if (path === RELAY_PATHS.nodes && method === 'GET') {
        // Which machines exist and how loaded they are is the operator's business, not a tenant's.
        if (key.namespace) return fail(res, 403, 'forbidden')
        return json(res, 200, { nodes: registry.listNodes() } satisfies ListNodesResponse)
      }
      if (slotMatch && method === 'DELETE') {
        // Another namespace's slot is left alone and answered like one that does not exist, so a key cannot probe for ids.
        const slot = registry.getSlot(slotMatch[1]!)
        if (!slot || inNamespace(key, slot.runId)) registry.release(slotMatch[1]!)
        res.writeHead(204)
        return void res.end()
      }
      return fail(res, 404, 'not_found')
    } catch (error) {
      logger.warn?.('A request failed', { path, error: String(error) })
      if (!res.headersSent) fail(res, 500, 'node_unavailable')
    }
  }

  async function createSlot(req: IncomingMessage, res: ServerResponse, key: ApiKeyEntry) {
    let body: Partial<CreateSlotRequest> | null
    try {
      body = (await readJson(req)) as Partial<CreateSlotRequest> | null
    } catch {
      return fail(res, 400, 'invalid_request')
    }
    // A field this relay does not know is refused, not skipped: a relay older than an option would otherwise answer 201 for a
    // slot that lacks it (one asked to use a proxy, going out direct). The body is checked as a whole before anything else.
    const isObject = typeof body === 'object' && body !== null && !Array.isArray(body)
    const known = new Set<string>(REQUEST_FIELDS)
    const unknownField = isObject ? Object.keys(body!).find((name) => !known.has(name)) : undefined
    if (unknownField !== undefined) {
      return fail(res, 400, 'invalid_request', `Unknown field ${JSON.stringify(unknownField.slice(0, 40))}`)
    }
    const { runId, maxLifetimeSeconds, waitMs } = body ?? {}
    const valid =
      typeof runId === 'string' &&
      runId.length >= 1 &&
      runId.length <= SLOT_LIMITS.maxRunIdLength &&
      Number.isInteger(maxLifetimeSeconds) &&
      maxLifetimeSeconds! >= SLOT_LIMITS.minLifetimeSeconds &&
      maxLifetimeSeconds! <= SLOT_LIMITS.maxLifetimeSeconds &&
      (waitMs === undefined || (Number.isInteger(waitMs) && waitMs >= 0))
    if (!valid) return fail(res, 400, 'invalid_request')
    const parsedOptions = parseSlotOptions(body as Record<string, unknown>)
    if (!parsedOptions.ok) return fail(res, 400, 'invalid_request', parsedOptions.message)
    const parsedLabels =
      body!.nodeLabels === undefined
        ? ({ ok: true, value: [] as string[] } as const)
        : parseNodeLabels(body!.nodeLabels)
    if (!parsedLabels.ok) return fail(res, 400, 'invalid_request', parsedLabels.message)
    const slotOptions = parsedOptions.value
    const nodeLabels = parsedLabels.value
    if (!inNamespace(key, runId)) return fail(res, 403, 'forbidden')

    // The count and the claim are one synchronous step, so concurrent requests cannot both squeeze under the quota.
    const { namespace, maxSlots } = key
    if (namespace && maxSlots !== undefined) {
      const held = registry.countSlots((runId) => inNamespace(key, runId))
      if (held + (inFlight.get(namespace) ?? 0) >= maxSlots) return fail(res, 429, 'quota_exceeded')
    }
    if (namespace) inFlight.set(namespace, (inFlight.get(namespace) ?? 0) + 1)
    // A caller that hangs up while waiting for capacity must not be given a slot nobody will ever release.
    const abandoned = new AbortController()
    res.once('close', () => {
      if (!res.writableFinished) abandoned.abort()
    })
    try {
      const slot = await registry.allocate({
        runId,
        maxLifetimeSeconds: maxLifetimeSeconds!,
        waitMs: Math.min(waitMs ?? 0, maxAcquireWaitMs),
        signal: abandoned.signal,
        need: {
          features: [...featuresFor(slotOptions)],
          labels: nodeLabels
        },
        options: slotOptions
      })
      // Which options the slot has, never what they are: a proxy's password is not for a log.
      const applied = appliedNames(slotOptions, nodeLabels)
      logger.info?.('Slot created', { slotId: slot.slotId, runId, nodeId: slot.nodeId, key: key.id, applied })
      return json(res, 201, { ...slot, applied } satisfies CreateSlotResponse)
    } catch (error) {
      if (error instanceof AllocationAbortedError) return
      if (error instanceof NoCapacityError) return fail(res, 503, 'no_capacity')
      if (error instanceof UnsupportedError) return fail(res, 422, 'unsupported', error.message)
      throw error
    } finally {
      if (namespace) {
        const left = (inFlight.get(namespace) ?? 1) - 1
        if (left > 0) inFlight.set(namespace, left)
        else inFlight.delete(namespace)
      }
    }
  }

  // ---- nodes ---------------------------------------------------------------------------------------------------

  const authenticate = (secret: string) => {
    const presented = hashToken(secret)
    let matched: EnrollmentSecret | undefined
    // No early exit: how long this takes must not depend on which secret matched.
    for (const entry of options.enrollmentSecrets) if (safeEqual(presented, entry.sha256.toLowerCase())) matched = entry
    return matched
  }

  const sanitizeContexts = (value: unknown): NodeContextReport[] => {
    if (!Array.isArray(value)) return []
    return value
      .slice(0, 500)
      .filter(
        (item): item is NodeContextReport =>
          Boolean(item) &&
          typeof item.slotId === 'string' &&
          typeof item.runId === 'string' &&
          typeof item.tokenHash === 'string' &&
          /^[0-9a-f]{64}$/.test(item.tokenHash) &&
          typeof item.createdAt === 'string'
      )
      .map(({ slotId, runId, tokenHash, createdAt }) => ({ slotId, runId, tokenHash, createdAt }))
  }

  function handleNodeSocket(ws: WebSocket) {
    let nodeId: string | null = null
    let link: NodeLink | null = null
    const helloTimer = setTimeout(() => ws.close(CLOSE.helloTimeout, 'No hello'), helloTimeoutMs)
    ws.on('error', () => undefined)
    ws.on('close', () => {
      clearTimeout(helloTimer)
      if (nodeId && link) registry.unregisterNode(nodeId, link)
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      let message: NodeToRelay
      try {
        message = JSON.parse(data.toString()) as NodeToRelay
      } catch {
        return
      }
      if (!nodeId) {
        const enrollment =
          message?.t === 'hello' && typeof message.secret === 'string' ? authenticate(message.secret) : undefined
        if (message?.t !== 'hello' || !enrollment) return void ws.close(CLOSE.unauthorized, 'Unauthorized')
        const validHello =
          typeof message.nodeId === 'string' &&
          NODE_ID.test(message.nodeId) &&
          Number.isInteger(message.maxContexts) &&
          message.maxContexts >= 1 &&
          message.maxContexts <= NODE_LIMITS.maxContexts
        if (!validHello) return void ws.close(CLOSE.invalidHello, 'Invalid hello')
        // A node and relay that disagree on the frames cannot work together; say so rather than fail obscurely later.
        if (message.version !== NODE_PROTOCOL_VERSION) {
          logger.warn?.('A node speaks a different protocol version', {
            nodeId: message.nodeId,
            nodeVersion: message.version,
            relayVersion: NODE_PROTOCOL_VERSION
          })
          return void ws.close(CLOSE.unsupportedVersion, 'Unsupported protocol version')
        }
        clearTimeout(helloTimer)
        nodeId = message.nodeId
        link = {
          send: (outgoing) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(outgoing))
          },
          close: (code, reason) => ws.close(code, reason)
        }
        registry.registerNode({
          id: nodeId,
          maxContexts: message.maxContexts,
          link,
          contexts: sanitizeContexts(message.contexts),
          features: sanitizeFeatures(message.features),
          labels: sanitizeLabels(message.labels),
          exclusive: message.exclusive === true
        })
        logger.info?.('Node connected', { nodeId, enrollment: enrollment.id, contexts: message.contexts?.length ?? 0 })
        link.send({ t: 'welcome', heartbeatMs, version: NODE_PROTOCOL_VERSION })
        return
      }
      // Authenticated, but still only a peer: a frame that is not an object ends nothing but itself.
      if (typeof message !== 'object' || message === null) return
      switch (message.t) {
        case 'heartbeat':
          if (link)
            registry.heartbeat(nodeId, link, {
              draining: Boolean(message.draining),
              contexts: sanitizeContexts(message.contexts)
            })
          return
        case 'context.created':
          return registry.answerCreate(nodeId, String(message.reqId))
        case 'context.failed':
          return registry.answerCreate(
            nodeId,
            String(message.reqId),
            String(message.message ?? 'failed'),
            message.refused === true
          )
        case 'context.ended':
          return void registry.endFromNode(
            nodeId,
            String(message.slotId),
            String(message.reason ?? 'ended').slice(0, 200)
          )
        case 'stream.failed': {
          const pending = pendingStreams.get(String(message.streamId))
          if (!pending) return
          clearTimeout(pending.timer)
          pendingStreams.delete(String(message.streamId))
          pending.reject(new Error(String(message.message ?? 'The node could not open the stream')))
          return
        }
        default:
          return
      }
    })
  }

  // ---- clients -------------------------------------------------------------------------------------------------

  /** Asks the slot's node for a stream socket and resolves with it once the node has dialled in. */
  function requestStream(slotId: string, link: NodeLink) {
    const streamId = randomBytes(24).toString('base64url')
    let cancel = () => undefined as void
    const promise = new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingStreams.delete(streamId)
        reject(new Error('The node did not open the stream in time'))
      }, streamTimeoutMs)
      pendingStreams.set(streamId, { resolve, reject, timer })
      cancel = () => {
        clearTimeout(timer)
        pendingStreams.delete(streamId)
      }
      link.send({ t: 'stream.open', streamId, slotId })
    })
    return { promise, cancel: () => cancel() }
  }

  const backlogGuard = () => createBacklogGuard({ maxBytes: maxBufferedBytes, graceMs: slowConsumerGraceMs, now })

  function relay(
    from: WebSocket,
    to: WebSocket,
    data: RawData,
    isBinary: boolean,
    tooSlow: (bufferedBytes: number) => boolean
  ) {
    if (to.readyState !== WebSocket.OPEN) return
    if (tooSlow(to.bufferedAmount)) {
      logger.warn?.('Closing a stream that cannot keep up')
      from.close(CLOSE.slowConsumer, 'The client cannot keep up')
      to.close(CLOSE.slowConsumer, 'The client cannot keep up')
      return
    }
    to.send(Array.isArray(data) ? Buffer.concat(data) : data, { binary: isBinary })
  }

  function handleClientSocket(client: WebSocket, slotId: string) {
    const link = registry.linkFor(slotId)
    if (!link) return void client.close(CLOSE.nodeUnavailable, 'The browser is not reachable')
    const sockets = clientSockets.get(slotId) ?? new Set<WebSocket>()
    sockets.add(client)
    clientSockets.set(slotId, sockets)

    // The client starts talking the moment it connects; hold what it says until the node's stream is up.
    const queued: Array<[RawData, boolean]> = []
    let queuedBytes = 0
    let node: WebSocket | null = null
    let closed = false
    const request = requestStream(slotId, link)
    const toNode = backlogGuard()
    const toClient = backlogGuard()

    client.on('error', () => undefined)
    client.on('message', (data, isBinary) => {
      if (node) return relay(client, node, data, isBinary, toNode)
      queuedBytes += rawLength(data)
      if (queuedBytes > MAX_QUEUED_BYTES)
        return void client.close(1009, 'Too much was sent before the browser was ready')
      queued.push([data, isBinary])
    })
    client.on('close', () => {
      closed = true
      request.cancel()
      sockets.delete(client)
      if (sockets.size === 0) clientSockets.delete(slotId)
      node?.close(1000, 'The client closed')
    })

    request.promise
      .then((stream) => {
        if (closed) return void stream.close(1000, 'The client is gone')
        node = stream
        stream.on('error', () => undefined)
        stream.on('message', (data, isBinary) => relay(stream, client, data, isBinary, toClient))
        stream.on('close', (code, reason) => client.close(sendableCode(code), reason.toString().slice(0, 100)))
        for (const [data, isBinary] of queued) relay(client, stream, data, isBinary, toNode)
        queued.length = 0
      })
      .catch((error: unknown) => {
        logger.warn?.('A client could not be connected to its browser', { slotId, error: String(error) })
        if (!closed) client.close(CLOSE.nodeUnavailable, 'The browser is not reachable')
      })
  }

  // ---- server --------------------------------------------------------------------------------------------------

  const server: Server = createServer((req, res) => void handleHttp(req, res))

  server.on('upgrade', (req, socket, head) => {
    const path = pathOf(req)
    if (path === null) return rejectUpgrade(socket, 400, 'Bad Request')
    if (path === RELAY_PATHS.nodeConnect) {
      return nodeWss.handleUpgrade(req, socket, head, (ws) => handleNodeSocket(ws))
    }
    const stream = /^\/v1\/nodes\/stream\/([\w-]+)$/.exec(path)
    if (stream) {
      // The id is a single-use capability the relay handed to one node a moment ago.
      const pending = pendingStreams.get(stream[1]!)
      if (!pending) return rejectUpgrade(socket, 404, 'Not Found')
      pendingStreams.delete(stream[1]!)
      clearTimeout(pending.timer)
      return streamWss.handleUpgrade(req, socket, head, (ws) => pending.resolve(ws))
    }
    const cdp = /^\/v1\/cdp\/([\w-]+)$/.exec(path)
    if (cdp) {
      const slot = registry.authorize(cdp[1]!, runToken(req))
      if (!slot) return rejectUpgrade(socket, 401, 'Unauthorized')
      if (!registry.linkFor(slot.slotId)) return rejectUpgrade(socket, 503, 'Service Unavailable')
      return clientWss.handleUpgrade(req, socket, head, (ws) => handleClientSocket(ws, slot.slotId))
    }
    rejectUpgrade(socket, 404, 'Not Found')
  })

  const sweeper = setInterval(() => registry.sweep(), options.sweepMs ?? 2000)
  sweeper.unref()

  return {
    server,
    registry,
    listen(port: number, host?: string) {
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => resolve((server.address() as AddressInfo).port))
      })
    },
    async close() {
      clearInterval(sweeper)
      for (const pending of pendingStreams.values()) clearTimeout(pending.timer)
      pendingStreams.clear()
      for (const wss of [nodeWss, streamWss, clientWss])
        for (const socket of wss.clients) socket.close(1001, 'The relay is stopping')
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    }
  }
}

export type RelayServer = ReturnType<typeof createRelayServer>
