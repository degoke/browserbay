/** Types for scope.mjs, which is plain JavaScript so it ships in the browser image without a build step. */

export interface ScopeUpstream {
  /** Sends one DevTools message (JSON text) to the real browser. */
  send(text: string): void
}

export interface ScopeTransport {
  /** Sends one DevTools message (JSON text) to the client. */
  send(text: string): void
  /** Closes the client's connection when the hub ends it (superseded, run ended, browser gone). */
  close?(code?: number, reason?: string): void
}

export interface ScopeClient {
  /** Feed every message the client sends. */
  handleMessage(text: string): void
  /** Call when the client's connection closed. Releases what it held; the run's browser context stays. */
  close(): void
}

export interface ScopeLogger {
  warn?(message: string, fields?: Record<string, unknown>): void
}

export interface CdpScope {
  start(): Promise<void>
  createRun(runKey: string): Promise<{ contextId: string }>
  disposeRun(runKey: string): Promise<void>
  hasRun(runKey: string): boolean
  runKeys(): string[]
  connect(runKey: string, transport: ScopeTransport): ScopeClient
  onUpstreamMessage(text: string): void
  onUpstreamClosed(): void
}

export function createCdpScope(options: {
  upstream: ScopeUpstream
  logger?: ScopeLogger
  /** How long a request to the browser may go unanswered before it fails (default 30 s). */
  requestTimeoutMs?: number
}): CdpScope
