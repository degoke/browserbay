/** Types for agent.mjs, which is plain JavaScript so it ships in the browser image without a build step. */
import type { CdpScope } from './scope.mjs'

export const NODE_PROTOCOL_VERSION: number

export interface AgentLogger {
  info?(message: string, fields?: Record<string, unknown>): void
  warn?(message: string, fields?: Record<string, unknown>): void
}

export interface AgentOptions {
  /** The relay's base URL (http(s):// or ws(s)://), with any path prefix it is served under. */
  relayUrl: string
  enrollmentSecret: string
  nodeId: string
  /** A started scope hub in front of this node's Chromium. */
  scope: CdpScope
  maxContexts?: number
  heartbeatMs?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
  maxBufferedBytes?: number
  slowConsumerGraceMs?: number
  logger?: AgentLogger
  WebSocketImpl?: typeof WebSocket
  random?: () => number
}

export interface Agent {
  whenConnected(timeoutMs?: number): Promise<void>
  contextCount(): number
  contextIds(): string[]
  isConnected(): boolean
  drain(timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

export function startAgent(options: AgentOptions): Agent

/** True once a consumer's backlog has stayed above `maxBytes` for longer than `graceMs`. */
export function createBacklogGuard(options: {
  maxBytes: number
  graceMs: number
  now?: () => number
}): (bufferedBytes: number) => boolean

/** Throws for a plain ws:// or http:// relay URL unless it is on this machine. */
export function assertSecureRelayUrl(relayUrl: string): void
