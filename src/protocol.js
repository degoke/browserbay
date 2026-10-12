/**
 * The wire contract between the three parts of browserbox: the relay, the node agents that dial it, and the clients
 * (your services) that ask it for browsers. Types are in protocol.d.ts.
 *
 * Plain JavaScript with no imports, so the node (plain JS), the client (installed straight from git, no build step)
 * and the relay (TypeScript) can all load the same constants.
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
export const TOKEN_HEADER = 'x-browserbox-token'

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
}

/**
 * A setting the operator has to fix. The CLI exits with status 2 for it. Defined once, here, and recognised by `name`
 * (not `instanceof`) because the compiled relay carries its own copy of this file in dist/.
 */
export class ConfigError extends Error {
  name = 'ConfigError'
}

/** What the relay accepts when a slot is requested (400 `invalid_request` otherwise). */
export const SLOT_LIMITS = {
  minLifetimeSeconds: 60,
  maxLifetimeSeconds: 86_400,
  /** `runId` length, in characters. A client's namespace prefix counts. */
  maxRunIdLength: 200
}

export const RELAY_PATHS = {
  health: '/health',
  slots: '/v1/slots',
  nodes: '/v1/nodes',
  nodeConnect: '/v1/nodes/connect',
  slot: (slotId) => `/v1/slots/${slotId}`,
  cdp: (slotId) => `/v1/cdp/${slotId}`,
  nodeStream: (streamId) => `/v1/nodes/stream/${streamId}`
}

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
}
