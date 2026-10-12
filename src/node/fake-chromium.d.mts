/** Types for fake-chromium.mjs, the in-memory Chromium used to test scope.mjs and agent.mjs without a browser. */

export interface FakeTarget {
  targetId: string
  type: string
  url: string
  browserContextId: string
  openerId?: string
}

export interface FakeSession {
  sessionId: string
  targetId: string
  parent?: string
  paused: boolean
  fetchEnabled: boolean
  childAutoAttach: unknown
}

export interface FakeCommand {
  method: string
  params?: Record<string, any>
  sessionId?: string
}

export interface FakeChromium {
  receive(text: string): void
  onMessage(handler: (text: string) => void): void
  contexts: Map<string, { cookies: unknown[]; disposeOnDetach?: boolean }>
  targets: Map<string, FakeTarget>
  sessions: Map<string, FakeSession>
  log: FakeCommand[]
  DEFAULT_CONTEXT: string
  wasClosed(): boolean
  commands(method: string): FakeCommand[]
  cookies(contextId?: string): unknown[]
  sessionsOf(targetId: string): string[]
  isPaused(targetId: string): boolean
  createTarget(options?: { url?: string; browserContextId?: string; type?: string; openerId?: string }): string
  openPopup(sessionId: string): string
  addChildSession(parentSessionId: string, options?: { type?: string }): string
  emitSessionEvent(sessionId: string, method: string, params?: unknown): void
  flush(): Promise<void>
}

export function createFakeChromium(): FakeChromium
