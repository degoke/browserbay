import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { CLOSE, type NodeContextReport, type NodeSummary, type RelayToNode, type SlotSummary } from '../protocol.js'

/** How the registry talks to a connected node. The relay server backs it with the node's control socket. */
export interface NodeLink {
  send(message: RelayToNode): void
  close(code: number, reason: string): void
}

export class NoCapacityError extends Error {
  constructor() {
    super('No browser capacity is available')
    this.name = 'NoCapacityError'
  }
}

/** The caller of allocate() went away before a slot was ready; nobody is left to hand it to. */
export class AllocationAbortedError extends Error {
  constructor() {
    super('The request for a browser was abandoned')
    this.name = 'AllocationAbortedError'
  }
}

interface NodeState {
  id: string
  maxContexts: number
  draining: boolean
  lastSeen: number
  /** Null while the node's control socket is down; its contexts are kept until it has been silent for nodeTimeoutMs. */
  link: NodeLink | null
  slots: Set<string>
  /** Creates sent to the node and not yet answered; they count against its capacity. */
  reserved: number
}

interface SlotState {
  slotId: string
  runId: string
  nodeId: string
  tokenHash: string
  createdAt: number
  /** When the node last confirmed (or the relay adopted) this context; heartbeats cannot contradict it before then. */
  confirmedAt: number
}

interface PendingCreate {
  nodeId: string
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface RegistryOptions {
  now?: () => number
  /** How long a node has to confirm a context it was asked to create. */
  createTimeoutMs?: number
  /** A node silent for this long is dropped, and its runs with it. */
  nodeTimeoutMs?: number
  /** A context the relay holds but a node's heartbeat omits is only dropped once it has been confirmed this long. */
  reconcileGraceMs?: number
  /** Called whenever a slot stops existing (released, lost with its node, or contradicted by its node). */
  onSlotRemoved?: (slotId: string, reason: string) => void
  /** How long the relay remembers a slot it ended, so a node that still holds the context is told to close it. */
  tombstoneMs?: number
  /** Called when a node refuses, fails or never answers a create, so these are never silently swallowed. */
  onCreateFailed?: (nodeId: string, error: unknown) => void
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Constant-time check of a presented run token against a stored sha256 hex hash. */
export function tokenMatchesHash(token: string, tokenHash: string) {
  const presented = Buffer.from(hashToken(token), 'hex')
  const stored = Buffer.from(tokenHash, 'hex')
  return presented.length === stored.length && timingSafeEqual(presented, stored)
}

/**
 * The relay's table of connected nodes and the run slots on them, and the scheduler over it.
 *
 * It is in memory on purpose: a node's sockets live on this process, and a restart is recovered from the nodes
 * themselves, which list their contexts (with the run token's hash) in their hello and every heartbeat. The interface
 * is the seam for a shared store if the relay is ever sharded.
 */
export function createNodeRegistry(options: RegistryOptions = {}) {
  const now = options.now ?? Date.now
  const createTimeoutMs = options.createTimeoutMs ?? 15_000
  const nodeTimeoutMs = options.nodeTimeoutMs ?? 15_000
  const reconcileGraceMs = options.reconcileGraceMs ?? 15_000
  const tombstoneMs = options.tombstoneMs ?? 2 * 60 * 60_000

  const nodes = new Map<string, NodeState>()
  const slots = new Map<string, SlotState>()
  const pendingCreates = new Map<string, PendingCreate>()
  const capacityWaiters = new Set<() => void>()
  /** slotId -> when to forget it. Slots the relay ended, which a node may still report until it has closed them. */
  const tombstones = new Map<string, number>()

  const notifyCapacity = () => {
    for (const wake of [...capacityWaiters]) wake()
  }

  function dropSlot(slotId: string, reason: string, tellNode: boolean) {
    const slot = slots.get(slotId)
    if (!slot) return false
    slots.delete(slotId)
    tombstones.set(slotId, now() + tombstoneMs)
    const node = nodes.get(slot.nodeId)
    node?.slots.delete(slotId)
    if (tellNode) node?.link?.send({ t: 'context.release', slotId })
    options.onSlotRemoved?.(slotId, reason)
    notifyCapacity()
    return true
  }

  function removeNode(node: NodeState, reason: string) {
    nodes.delete(node.id)
    for (const slotId of [...node.slots]) dropSlot(slotId, reason, false)
    failPendingCreates(node.id, reason)
    notifyCapacity()
  }

  function failPendingCreates(nodeId: string, reason: string) {
    for (const [reqId, pending] of pendingCreates) {
      if (pending.nodeId !== nodeId) continue
      clearTimeout(pending.timer)
      pendingCreates.delete(reqId)
      pending.reject(new Error(reason))
    }
  }

  function adopt(node: NodeState, report: NodeContextReport) {
    // A slot the relay ended (released, or lost with a silent node) is not brought back by the node still holding its
    // context: the node is told to close it. Only a slot this relay never knew (a restart) is adopted.
    const forgetAt = tombstones.get(report.slotId)
    if (forgetAt !== undefined && forgetAt > now()) {
      node.link?.send({ t: 'context.release', slotId: report.slotId })
      return
    }
    const existing = slots.get(report.slotId)
    if (existing && existing.nodeId !== node.id) dropSlot(report.slotId, 'moved to another node', false)
    if (slots.has(report.slotId)) return
    const createdAt = Date.parse(report.createdAt)
    slots.set(report.slotId, {
      slotId: report.slotId,
      runId: report.runId,
      nodeId: node.id,
      tokenHash: report.tokenHash,
      createdAt: Number.isFinite(createdAt) ? createdAt : now(),
      confirmedAt: now()
    })
    node.slots.add(report.slotId)
  }

  /** Makes the relay's view of a node's slots agree with what the node says it holds. */
  function reconcile(node: NodeState, contexts: NodeContextReport[]) {
    const reported = new Set(contexts.map((context) => context.slotId))
    for (const report of contexts) adopt(node, report)
    for (const slotId of [...node.slots]) {
      const slot = slots.get(slotId)
      if (!slot || reported.has(slotId)) continue
      if (now() - slot.confirmedAt < reconcileGraceMs) continue
      dropSlot(slotId, 'the node no longer holds this context', false)
    }
  }

  function pick(exclude: Set<string>) {
    let best: NodeState | undefined
    let bestLoad = Infinity
    for (const node of nodes.values()) {
      if (node.draining || !node.link || exclude.has(node.id)) continue
      const used = node.slots.size + node.reserved
      if (used >= node.maxContexts) continue
      const load = used / node.maxContexts
      if (load < bestLoad) {
        best = node
        bestLoad = load
      }
    }
    return best
  }

  function waitForCapacity(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        capacityWaiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      capacityWaiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  async function createOn(node: NodeState, input: { runId: string; maxLifetimeSeconds: number }) {
    const slotId = `s${randomBytes(12).toString('hex')}`
    const token = randomBytes(24).toString('base64url')
    const tokenHash = hashToken(token)
    const reqId = randomBytes(8).toString('hex')
    /**
     * The relay is giving up on this slot, but a node that did not answer in time (or lost its connection mid-create)
     * may have made the context anyway, and will report it on its next heartbeat. Remember the id as not ours, so that
     * report is not adopted as a slot nobody holds the token for, and tell the node to close what it made.
     */
    const abandon = (holder: NodeState | undefined) => {
      tombstones.set(slotId, now() + tombstoneMs)
      holder?.link?.send({ t: 'context.release', slotId })
    }
    node.reserved++
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingCreates.delete(reqId)
          reject(new Error('The node did not confirm the new context in time'))
        }, createTimeoutMs)
        pendingCreates.set(reqId, { nodeId: node.id, resolve, reject, timer })
        node.link!.send({
          t: 'context.create',
          reqId,
          slotId,
          runId: input.runId,
          tokenHash,
          maxLifetimeSeconds: input.maxLifetimeSeconds
        })
      })
    } catch (error) {
      abandon(node)
      throw error
    } finally {
      node.reserved--
    }
    // The node may have been dropped while we waited; its slots were cleared with it.
    if (nodes.get(node.id) !== node) {
      abandon(nodes.get(node.id))
      throw new Error('The node went away')
    }
    slots.set(slotId, { slotId, runId: input.runId, nodeId: node.id, tokenHash, createdAt: now(), confirmedAt: now() })
    node.slots.add(slotId)
    return { slotId, token, nodeId: node.id }
  }

  return {
    /**
     * A node connected and authenticated. A node reconnecting under the same id replaces its old connection (which is
     * closed) and keeps the contexts it still reports; a restarted relay adopts everything the node reports.
     */
    registerNode(input: { id: string; maxContexts: number; link: NodeLink; contexts: NodeContextReport[] }) {
      const previous = nodes.get(input.id)
      const node: NodeState = {
        id: input.id,
        maxContexts: input.maxContexts,
        draining: false,
        lastSeen: now(),
        link: input.link,
        slots: new Set(previous?.slots),
        reserved: 0
      }
      if (previous) {
        previous.link?.close(CLOSE.replaced, 'This node connected again')
        failPendingCreates(input.id, 'The node reconnected')
      }
      nodes.set(input.id, node)
      reconcile(node, input.contexts)
      notifyCapacity()
      return node
    },

    /**
     * The node's control socket closed. Its contexts are kept: a blip must not end runs that are waiting on a person.
     * They are dropped by sweep() if the node does not come back. A connection that was already replaced is ignored.
     */
    unregisterNode(id: string, link: NodeLink) {
      const node = nodes.get(id)
      if (!node || node.link !== link) return
      node.link = null
      failPendingCreates(id, 'The node disconnected')
      notifyCapacity()
    },

    heartbeat(id: string, link: NodeLink, input: { draining: boolean; contexts: NodeContextReport[] }) {
      const node = nodes.get(id)
      if (!node || node.link !== link) return
      node.lastSeen = now()
      node.draining = input.draining
      reconcile(node, input.contexts)
      notifyCapacity()
    },

    /** The node answered a context.create. */
    answerCreate(id: string, reqId: string, error?: string) {
      const pending = pendingCreates.get(reqId)
      if (!pending || pending.nodeId !== id) return
      clearTimeout(pending.timer)
      pendingCreates.delete(reqId)
      if (error) pending.reject(new Error(error))
      else pending.resolve()
    },

    /**
     * Reserves a slot on the least-loaded node that has room, waiting up to `waitMs` for one to free up. The token it
     * returns is the only time it exists in the clear.
     */
    async allocate(input: { runId: string; maxLifetimeSeconds: number; waitMs: number; signal?: AbortSignal }) {
      const { signal } = input
      const deadline = now() + input.waitMs
      const failed = new Set<string>()
      for (;;) {
        if (signal?.aborted) throw new AllocationAbortedError()
        const node = pick(failed)
        if (node) {
          try {
            const slot = await createOn(node, input)
            if (signal?.aborted) {
              // The caller left while the node was creating it: nobody will ever use or release this slot.
              dropSlot(slot.slotId, 'the request was abandoned', true)
              throw new AllocationAbortedError()
            }
            return slot
          } catch (error) {
            if (error instanceof AllocationAbortedError) throw error
            // This node refused or vanished; try another before waiting.
            options.onCreateFailed?.(node.id, error)
            failed.add(node.id)
            continue
          }
        }
        const remaining = deadline - now()
        if (remaining <= 0) throw new NoCapacityError()
        await waitForCapacity(remaining, signal)
        failed.clear()
      }
    },

    release(slotId: string) {
      return dropSlot(slotId, 'released', true)
    },

    /** The slot, only for the holder of its run token. */
    authorize(slotId: string, token: string | undefined) {
      const slot = slots.get(slotId)
      if (!slot || !token || !tokenMatchesHash(token, slot.tokenHash)) return null
      return slot
    },

    /** The live connection of the node holding a slot, or null if it is gone. */
    linkFor(slotId: string) {
      const slot = slots.get(slotId)
      return slot ? (nodes.get(slot.nodeId)?.link ?? null) : null
    },

    /** Drops nodes that stopped heartbeating, with their slots, and forgets slots ended long enough ago. */
    sweep() {
      for (const [slotId, forgetAt] of tombstones) if (forgetAt <= now()) tombstones.delete(slotId)
      for (const node of [...nodes.values()]) {
        if (now() - node.lastSeen <= nodeTimeoutMs) continue
        node.link?.close(CLOSE.nodeTimeout, 'No heartbeat')
        removeNode(node, 'the node stopped heartbeating')
      }
    },

    listSlots(): SlotSummary[] {
      return [...slots.values()].map((slot) => ({
        slotId: slot.slotId,
        runId: slot.runId,
        nodeId: slot.nodeId,
        createdAt: new Date(slot.createdAt).toISOString()
      }))
    },

    getSlot(slotId: string): SlotSummary | null {
      const slot = slots.get(slotId)
      return slot
        ? { slotId, runId: slot.runId, nodeId: slot.nodeId, createdAt: new Date(slot.createdAt).toISOString() }
        : null
    },

    listNodes(): NodeSummary[] {
      return [...nodes.values()].map((node) => ({
        nodeId: node.id,
        maxContexts: node.maxContexts,
        contexts: node.slots.size,
        draining: node.draining,
        lastSeenAt: new Date(node.lastSeen).toISOString()
      }))
    }
  }
}

export type NodeRegistry = ReturnType<typeof createNodeRegistry>
