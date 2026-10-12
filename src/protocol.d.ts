/** Types for protocol.js: the wire contract between the relay, the node agents and the clients. */

export declare const TOKEN_HEADER: 'x-browserbox-token'

export declare const NODE_PROTOCOL_VERSION: 1

/** Letters, digits, `_`, `.` and `-`: the one rule for a name. */
export declare const NAME_PATTERN: RegExp

export declare const NODE_LIMITS: {
  readonly maxContexts: 100
  readonly nodeIdPattern: RegExp
}

/** A setting the operator has to fix. Recognise it by `name === 'ConfigError'`. */
export declare class ConfigError extends Error {
  name: 'ConfigError'
}

export declare const SLOT_LIMITS: {
  readonly minLifetimeSeconds: 60
  readonly maxLifetimeSeconds: 86400
  readonly maxRunIdLength: 200
}

export declare const RELAY_PATHS: {
  readonly health: '/health'
  readonly slots: '/v1/slots'
  readonly nodes: '/v1/nodes'
  readonly nodeConnect: '/v1/nodes/connect'
  readonly slot: (slotId: string) => string
  readonly cdp: (slotId: string) => string
  readonly nodeStream: (streamId: string) => string
}

export declare const CLOSE: {
  readonly invalidHello: 4400
  readonly unauthorized: 4401
  readonly unsupportedVersion: 4426
  readonly helloTimeout: 4408
  readonly replaced: 4409
  readonly nodeTimeout: 4410
  readonly slowConsumer: 4413
  readonly nodeUnavailable: 4503
}

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
