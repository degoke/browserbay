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

/** A key's quota of slots: a whole number of 1 or more, up to six digits. */
export const QUOTA_PATTERN = /^[1-9]\d{0,5}$/

/** Why a key's quota cannot be used, or undefined. Shared by the relay's settings and `browserbay key`. */
export function quotaProblem(quota: string, namespace: string | undefined) {
  if (!QUOTA_PATTERN.test(quota)) return 'a quota must be a whole number of 1 or more'
  if (!namespace) return "a quota needs a namespace: it counts that namespace's slots"
  return undefined
}

/** What the relay accepts in a node's hello. A node that exceeds them is refused (close code 4400). */
export const NODE_LIMITS = {
  /** The most slots one node may offer. */
  maxContexts: 100,
  /** A node's name, up to 100 characters. Unique per node: a second one with the same name replaces the first. */
  nodeIdPattern: new RegExp(`^${NAME_CHARS}{1,100}$`)
} as const

/**
 * What a node can do for a slot beyond giving it a browser, told to the relay in its hello. A slot that asks for one is only
 * placed on a node that has it, because a node that does not know an option would make the slot without it: a slot that was
 * asked to use a proxy, going out direct.
 */
export const NODE_FEATURE = {
  /** `SlotOptions.proxy`: the slot's traffic goes through a proxy of its own. */
  proxy: 'proxy',
  /** `SlotOptions.timezone` and `locale`. Only a node with a Chromium per slot has it: they are set when the browser starts. */
  locale: 'locale',
  /** The node can sign a slot's requests (Web Bot Auth): `SlotOptions.signRequests: true`. */
  sign: 'sign',
  /** The node can leave a slot's requests unsigned: `SlotOptions.signRequests: false`. A node that always signs does not have it. */
  unsigned: 'unsigned'
} as const

/**
 * What a node that signs says about its key: `wba-key:<key id>`. A relay that publishes a key directory only sends a slot that
 * asks to be signed to a node signing with that key, because signatures made with another would not verify against it.
 */
export const SIGNING_KEY_FEATURE = 'wba-key:'

/** What the relay accepts of a node's labels, and of the labels a slot requires. */
export const LABEL_LIMITS = {
  /** Labels one node may carry. */
  maxPerNode: 16,
  /** Labels one slot may require. */
  maxRequired: 8,
  /** A label is a name (letters, digits, `_`, `.`, `-`), up to this long. */
  maxLength: 63
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
  /** Send the slot's traffic through a proxy. Needs a node with the `proxy` feature (422 `unsupported` if none has it or every node that does refuses the value). */
  proxy?: ProxySettings
  /** The IANA time zone the slot's browser runs in, such as `Europe/Berlin`. Needs the `locale` feature. */
  timezone?: string
  /** The slot's browser language, such as `de-DE`: its `navigator.language` and `Accept-Language`. Needs the `locale` feature. */
  locale?: string
  /** Only place the slot on a node that carries every one of these labels (`BROWSERBAY_NODE_LABELS`). */
  nodeLabels?: string[]
  /**
   * Sign every request of the slot's browser (Web Bot Auth), so sites that know the box can tell whose browser it is. `true` needs
   * a node that signs, `false` one that can leave it unsigned, and left out is the node's own default (`BROWSERBAY_WEB_BOT_AUTH`).
   */
  signRequests?: boolean
}

/** A proxy for one slot. The node reaches it through a forwarder of its own, so Chromium never holds the credentials. */
export interface ProxySettings {
  /** `http://host:port`, `https://host:port` or `socks5://host:port`. No user name, password or path in it. */
  server: string
  username?: string
  password?: string
  /** Chromium's proxy bypass list: host patterns that go direct, separated by `,` or `;`. */
  bypass?: string
}

/** What a slot asks of its browser beyond a place to run: the part of the request a node acts on. A plain slot has none. */
export interface SlotOptions {
  proxy?: ProxySettings
  timezone?: string
  locale?: string
  signRequests?: boolean
}

/**
 * 201 from POST /v1/slots. The token is shown once; the relay keeps only its hash. 503 `no_capacity` when full.
 *
 * `applied` names the options of the request that the slot has (`proxy`, `timezone`, `locale`, `nodeLabels`). A client
 * that sent options checks it: a box older than the options answers 201 and ignores what it does not know, and the
 * slot would be a plain one, going out direct from the node's own address.
 */
export interface CreateSlotResponse {
  slotId: string
  token: string
  nodeId: string
  applied?: string[]
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
  /** What the node can do for a slot (see NODE_FEATURE). */
  features?: string[]
  /** What the node's operator calls it (`BROWSERBAY_NODE_LABELS`): a slot can ask for them. */
  labels?: string[]
  /** The node only takes slots that ask for one of its labels. */
  exclusive?: boolean
}

/** GET /v1/nodes */
export interface ListNodesResponse {
  nodes: NodeSummary[]
}

/**
 * 403 `forbidden`: the API key is valid but not allowed this (a run id outside its namespace, or `GET /v1/nodes` from a key
 * that has one). 429 `quota_exceeded`: the key's namespace already holds as many slots as its quota allows.
 * 422 `unsupported`: nodes are connected but none could serve this request (none has a feature or a label it asks for, or
 * every node that does refused the slot's value, such as a time zone its system lacks), so waiting would not help. 400 `invalid_request` says in `message` what is wrong with options.
 */
export interface RelayErrorResponse {
  error:
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'no_capacity'
    | 'quota_exceeded'
    | 'invalid_request'
    | 'unsupported'
    | 'node_unavailable'
  message?: string
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
      /**
       * What this node can do (NODE_FEATURE), its operator's labels and whether it only takes labelled slots. A relay that does
       * not know these fields ignores them, and a node that does not send them has none: no protocol version needed.
       */
      features?: string[]
      labels?: string[]
      exclusive?: boolean
    }
  | { t: 'heartbeat'; draining: boolean; contexts: NodeContextReport[] }
  | { t: 'context.created'; reqId: string }
  | {
      t: 'context.failed'
      reqId: string
      message: string
      /**
       * The slot asked for something this node cannot give (a time zone it lacks, an option it does not know), as opposed to the
       * node being full or failing: asking this node again will not help, and `message` is for the person who asked.
       */
      refused?: boolean
    }
  /**
   * A context ended on the node's own account (process isolation: the slot's Chromium crashed). The relay drops the slot at
   * once instead of waiting for heartbeats to stop mentioning it. A relay that does not know this frame ignores it, and
   * gets there by the heartbeats; so it needs no protocol version of its own.
   */
  | { t: 'context.ended'; slotId: string; reason: string }
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
      /** Left out for a plain slot. A node answers `context.failed` for an option it does not know, never makes the slot without it. */
      options?: SlotOptions
    }
  | { t: 'context.release'; slotId: string }
  /** Dial `wss://relay/v1/nodes/stream/<streamId>` and serve slot `slotId` on it. The id is single-use and short-lived. */
  | { t: 'stream.open'; streamId: string; slotId: string }
