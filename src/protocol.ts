/**
 * The wire contract between the three parts of browserbay: the relay, the node agents that dial it, and the clients
 * (your services) that ask it for browsers.
 *
 * It has no imports, so the relay, the node and the client all load the same constants and types.
 *
 * Three secrets, three jobs:
 *   - the enrollment secret lets a node join (node <-> relay control socket);
 *   - the API key lets a client manage slots (REST);
 *   - the slot token (header below) reaches one slot's browser and nothing else (CDP socket, slot lookup).
 *
 * A node holds ONE outbound control socket, and the relay asks it for one more outbound "stream" socket per client
 * CDP connection, so there is no multiplexing: each stream is a plain WebSocket carrying one client's DevTools
 * messages, with its own backpressure. Nothing ever connects in to a node.
 */

/** Sent by whoever drives or watches a slot's browser, on the CDP socket and on the slot lookup. */
export const TOKEN_HEADER = 'x-browserbay-token'

/** Bumped when the node <-> relay messages change incompatibly. The relay refuses a node that speaks another one. */
export const NODE_PROTOCOL_VERSION = 1

/**
 * The one rule for a name (a node's, a namespace's, an enrollment secret's): letters, digits, `_`, `.` and `-`. Kept
 * here so the relay, the node, the client and the CLI cannot drift apart on it.
 */
const NAME_CHARS = '[\\w.-]'
export const NAME_PATTERN = new RegExp(`^${NAME_CHARS}+$`)

/** What the relay accepts in a node's hello. A node that exceeds them is refused (close code 4400). */
export const NODE_LIMITS = {
  /** The most slots one node may offer. */
  maxContexts: 100,
  /** A node's name, up to 100 characters. Unique per node: a second one with the same name replaces the first. */
  nodeIdPattern: new RegExp(`^${NAME_CHARS}{1,100}$`)
} as const

/**
 * A setting the operator has to fix. The CLI exits with status 2 for it. Recognise it with `instanceof` or by
 * `name === 'ConfigError'`.
 */
export class ConfigError extends Error {
  override name = 'ConfigError' as const
}

/** What the relay accepts when a slot is requested (400 `invalid_request` otherwise). */
export const SLOT_LIMITS = {
  minLifetimeSeconds: 60,
  maxLifetimeSeconds: 86_400,
  /** `runId` length, in characters. A client's namespace prefix counts. */
  maxRunIdLength: 200
} as const

export const RELAY_PATHS = {
  health: '/health',
  slots: '/v1/slots',
  nodes: '/v1/nodes',
  nodeConnect: '/v1/nodes/connect',
  slot: (slotId: string) => `/v1/slots/${slotId}`,
  cdp: (slotId: string) => `/v1/cdp/${slotId}`,
  nodeStream: (streamId: string) => `/v1/nodes/stream/${streamId}`
} as const

/** Close codes the relay and nodes use (4000-4999 are application codes; the WHATWG WebSocket a node uses cannot send others). */
export const CLOSE = {
  /** An authenticated node whose hello the relay will not accept: an id or a slot count outside NODE_LIMITS. */
  invalidHello: 4400,
  unauthorized: 4401,
  unsupportedVersion: 4426,
  helloTimeout: 4408,
  replaced: 4409,
  nodeTimeout: 4410,
  slowConsumer: 4413,
  nodeUnavailable: 4503
} as const

// ---- REST (API key: `Authorization: Bearer <key>`, except where a slot token is named) ----------------------------

/** POST /v1/slots */
export interface CreateSlotRequest {
  /** Your own id for what the browser is for (a run, a task, a job). Listed back to you so you can tell what is orphaned. */
  runId: string
  /** The context is closed by its node after this long, whether or not anyone is still connected. */
  maxLifetimeSeconds: number
  /** How long to wait for a free slot before answering 503 `no_capacity`. The relay caps it at its own maximum. */
  waitMs?: number
}

/** 201 from POST /v1/slots. The token is shown once; the relay keeps only its hash. 503 `no_capacity` when full. */
export interface CreateSlotResponse {
  slotId: string
  token: string
  nodeId: string
}

export interface SlotSummary {
  slotId: string
  runId: string
  nodeId: string
  createdAt: string
}

/** GET /v1/slots */
export interface ListSlotsResponse {
  slots: SlotSummary[]
}

/**
 * GET /v1/slots/:id with the slot token: 200 while the slot's browser is reachable, 404 when there is no such slot (or the
 * token is wrong), 503 while its node's control socket is reconnecting (the slot is kept until the node has been silent
 * too long). DELETE /v1/slots/:id (API key) is idempotent: 204.
 */
export type SlotStatusResponse = SlotSummary

export interface NodeSummary {
  nodeId: string
  maxContexts: number
  contexts: number
  draining: boolean
  lastSeenAt: string
}

/** GET /v1/nodes */
export interface ListNodesResponse {
  nodes: NodeSummary[]
}

export interface RelayErrorResponse {
  error: 'unauthorized' | 'not_found' | 'no_capacity' | 'invalid_request' | 'node_unavailable'
}

// ---- Node control socket (wss://relay/v1/nodes/connect) --------------------------------------------------------

/** What a node reports about a context it holds, so a restarted relay can adopt it and reconcile what it lost. */
export interface NodeContextReport {
  slotId: string
  runId: string
  /** sha256 hex of the slot token: all a node ever learns of it, and enough for the relay to rebuild its table. */
  tokenHash: string
  createdAt: string
}

export type NodeToRelay =
  /** The first frame, within `helloTimeoutMs`. Authentication is in-band so it does not depend on socket headers. */
  | {
      t: 'hello'
      secret: string
      nodeId: string
      maxContexts: number
      version: number
      contexts: NodeContextReport[]
    }
  | { t: 'heartbeat'; draining: boolean; contexts: NodeContextReport[] }
  | { t: 'context.created'; reqId: string }
  | { t: 'context.failed'; reqId: string; message: string }
  | { t: 'stream.failed'; streamId: string; message: string }

export type RelayToNode =
  | { t: 'welcome'; heartbeatMs: number; version: number }
  | {
      t: 'context.create'
      reqId: string
      slotId: string
      runId: string
      tokenHash: string
      maxLifetimeSeconds: number
    }
  | { t: 'context.release'; slotId: string }
  /** Dial `wss://relay/v1/nodes/stream/<streamId>` and serve slot `slotId` on it. The id is single-use and short-lived. */
  | { t: 'stream.open'; streamId: string; slotId: string }
