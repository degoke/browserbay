import type { NodeSummary, SlotSummary } from '../protocol.js'

export type { NodeSummary, SlotSummary }

export interface BrowserBoxOptions {
  /** The box's base URL, e.g. https://browsers.example.com. A path prefix is kept. */
  url: string
  /** The box's API key: lets this service create, list and release browsers. It never reaches a browser. */
  apiKey: string
  /**
   * Marks this service's slots (as a prefix on their run ids) so `list` and `reap` leave another service's alone when
   * several share a box. A naming convention, not an access control: anything holding the API key can still reach any slot.
   */
  namespace?: string
  logger?: { warn?(message: string, fields?: Record<string, unknown>): void }
  fetch?: typeof fetch
  now?: () => number
}

export interface AcquireOptions {
  /** Your own id for what the browser is for (a run, a task, a job). `list` and `reap` hand it back to you. */
  runId: string
  /** The browser's node closes it after this long, whether or not anyone is still connected. */
  maxLifetimeSeconds: number
  /** How long to wait for a free slot before giving up with a `NoCapacityError`. The box caps it at its own maximum. Default 30000. */
  waitMs?: number
}

/** The part of a slot worth keeping to come back to it later (`box.slot(stored)`). It contains the slot token: store it like a secret. */
export interface StoredSlot {
  slotId: string
  token: string
  /** The box the slot is on. Defaults to this client's box. */
  url?: string
  nodeId?: string
}

/** One isolated browser (a browser context on whichever node had room) and how to reach it. */
export interface Slot {
  readonly url: string
  readonly slotId: string
  readonly nodeId?: string
  /** Reaches this slot's browser and nothing else. Treat it as a secret. */
  readonly token: string
  /** The DevTools endpoint to hand to Playwright's or Puppeteer's connect, together with `headers`. */
  readonly cdpUrl: string
  /** The headers every DevTools connection to this slot must carry. A fresh object each time. */
  readonly headers: Record<string, string>
  /** True while the slot's browser is reachable. Never throws: a box that cannot be asked counts as "not alive". */
  isAlive(): Promise<boolean>
  /** Closes the browser. Safe to call for one that is already gone. */
  release(): Promise<void>
  /** The `StoredSlot` for this slot, so `JSON.stringify(slot)` is what to persist. */
  toJSON(): StoredSlot
}

export interface ReapOptions {
  /** Says whether the thing a slot was acquired for (its run id, without the namespace) still needs its browser. */
  isLive(runId: string): Promise<boolean>
  /** A slot younger than this is never reaped. Default 180000. */
  graceMs?: number
  /** Run ids that nothing can vouch for (and that close themselves at their lifetime), which are left alone. */
  skip?(runId: string): boolean
}

export interface BrowserBox {
  /** Takes a browser. Throws `NoCapacityError` when the box stays full for the whole wait. */
  acquire(options: AcquireOptions): Promise<Slot>
  /** A slot you stored earlier. Makes no request; use `isAlive()` to find out whether it still exists. */
  slot(stored: StoredSlot): Slot
  /** This service's slots (all of them, or only those in the namespace, with the namespace removed from their run ids). */
  list(): Promise<SlotSummary[]>
  nodes(): Promise<NodeSummary[]>
  /** Releases slots whose run `isLive` says no to, for when a crash lost track of them. Returns how many were released. */
  reap(options: ReapOptions): Promise<number>
}

export function createBrowserBox(options: BrowserBoxOptions): BrowserBox

export class BrowserBoxError extends Error {
  readonly status?: number
  constructor(message: string, status?: number)
}

/** The box has no browser to give: every node is full, or none is connected. */
export class NoCapacityError extends BrowserBoxError {
  constructor()
}
