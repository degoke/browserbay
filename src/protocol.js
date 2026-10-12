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
  unauthorized: 4401,
  unsupportedVersion: 4426,
  helloTimeout: 4408,
  replaced: 4409,
  nodeTimeout: 4410,
  slowConsumer: 4413,
  nodeUnavailable: 4503
}
