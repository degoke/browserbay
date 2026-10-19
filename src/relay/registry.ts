import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  CLOSE,
  type NodeContextReport,
  type NodeSummary,
  type RelayToNode,
  type SlotOptions,
  type SlotSummary
} from '../protocol.js'

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

/**
 * Nodes are connected, and none of them could ever serve this request: none has a feature it needs, or carries a label it
 * asks for, or they all only take labelled slots. Waiting would not change that, so it is said at once (422) and not after
 * the whole wait as `no capacity`.
 */
export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedError'
  }
}

/** The caller of allocate() went away before a slot was ready; nobody is left to hand it to. */
export class AllocationAbortedError extends Error {
  constructor() {
    super('The request for a browser was abandoned')
    this.name = 'AllocationAbortedError'
  }
}

export interface NodeState {
  id: string
  maxContexts: number
  draining: boolean
  lastSeen: number
  /** Null while the node's control socket is down; its contexts are kept until it has been silent for nodeTimeoutMs. */
  link: NodeLink | null
  slots: Set<string>
  /** Creates sent to the node and not yet answered; they count against its capacity. */
  reserved: number
  /** What the node can do for a slot beyond giving it a browser (NODE_FEATURE). */
  features: Set<string>
  /** What its operator calls it: a slot can ask for them. */
  labels: Set<string>
  /** Only slots that ask for one of its labels are placed on it. */
  exclusive: boolean
}

/** What a slot asks of the node it is placed on. A slot with none can go anywhere that is not exclusive. */
export interface SlotNeeds {
  features: string[]
  labels: string[]
}

const NO_NEEDS: SlotNeeds = { features: [], labels: [] }

export interface SlotState {
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
  /**
   * After the relay starts, and after each new node joins, a request that no connected node could serve waits like any other:
   * the nodes that could have may still be reconnecting. Once this has passed with no new node it is `unsupported` at once.
   * Default 15 s.
   */
  unsupportedGraceMs?: number
}

/** What a node said when it refused a slot, as the relay passes it on: attributed, printable ASCII, bounded. */
function refusalMessage(said: string) {
  const reason = said
    .replace(/[^\x20-\x7e]+/g, ' ')
    .trim()
    .slice(0, 200)
  return `A node cannot make this slot as asked${reason ? `: "${reason}"` : ''}`
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
  const unsupportedGraceMs = options.unsupportedGraceMs ?? 15_000
  /** When the registry began, or a node new to it last joined: nodes coming back after a restart arrive one after another. */
  let lastJoinAt = now()

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

  /** Whether a node could ever serve a slot with these needs, whatever its load. */
  function serves(node: NodeState, need: SlotNeeds) {
    if (need.features.some((feature) => !node.features.has(feature))) return false
    if (need.labels.some((label) => !node.labels.has(label))) return false
    // An exclusive node is kept for the slots that ask for it by label.
    return !node.exclusive || need.labels.length > 0
  }

  /** Why no connected node serves a request, in a sentence. */
  function explainUnsupported(need: SlotNeeds) {
    const all = [...nodes.values()]
    const reasons: string[] = []
    const noFeature = need.features.filter((feature) => !all.some((node) => node.features.has(feature)))
    if (noFeature.length > 0) reasons.push(`no node offers ${noFeature.join(', ')}`)
    const noLabel = need.labels.filter((label) => !all.some((node) => node.labels.has(label)))
    if (noLabel.length > 0) reasons.push(`no node carries the label ${noLabel.join(', ')}`)
    if (reasons.length === 0) {
      reasons.push(
        need.labels.length > 0 || need.features.length > 0
          ? 'no single node has all of this: the features and the labels together'
          : 'every node only takes slots that ask for one of its labels (nodeLabels)'
      )
    }
    const text = reasons.join('; ')
    return text[0]!.toUpperCase() + text.slice(1)
  }

  function pick(exclude: Set<string>, need: SlotNeeds) {
    let best: NodeState | undefined
    let bestLoad = Infinity
    for (const node of nodes.values()) {
      if (node.draining || !node.link || exclude.has(node.id) || !serves(node, need)) continue
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

  async function createOn(
    node: NodeState,
    input: { runId: string; maxLifetimeSeconds: number; options?: SlotOptions }
  ) {
    const slotId = `s${randomBytes(12).toString('hex')}`
    const token = randomBytes(24).toString('base64url')
    const tokenHash = hashToken(token)
    const reqId = randomBytes(8).toString('hex')
    /**
     * The relay is giving up on this slot, but a node that did not answer in time (or lost its connection mid-create)
     * may have made the context anyway, and will report it on its next heartbeat. Remember the id as not ours, so that
     * report is not adopted as a slot nobody holds the token for, and tell the node to close what it made.
     *
     * A node that reconnected meanwhile may already have had the context adopted from its new hello (registerNode runs
     * before this create is seen to fail), so end it if it is there, and tell the node's CURRENT connection: the one
     * this create was sent on is closed.
     */
    const abandon = () => {
      tombstones.set(slotId, now() + tombstoneMs)
      if (!dropSlot(slotId, 'the create was abandoned', true))
        nodes.get(node.id)?.link?.send({ t: 'context.release', slotId })
    }
    node.reserved++
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingCreates.delete(reqId)
          reject(new Error('The node did not confirm the new context in time'))
        }, createTimeoutMs)
        pendingCreates.set(reqId, { nodeId: node.id, resolve, reject, timer })
        // A plain slot's frame is what it always was, so a node that predates options reads it as it always did.
        const slotOptions = input.options && Object.keys(input.options).length > 0 ? input.options : undefined
        node.link!.send({
          t: 'context.create',
          reqId,
          slotId,
          runId: input.runId,
          tokenHash,
          maxLifetimeSeconds: input.maxLifetimeSeconds,
          ...(slotOptions ? { options: slotOptions } : {})
        })
      })
    } catch (error) {
      abandon()
      throw error
    } finally {
      node.reserved--
    }
    // The node may have been dropped while we waited; its slots were cleared with it.
    if (nodes.get(node.id) !== node) {
      abandon()
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
    registerNode(input: {
      id: string
      maxContexts: number
      link: NodeLink
      contexts: NodeContextReport[]
      features?: string[]
      labels?: string[]
      exclusive?: boolean
    }) {
      const previous = nodes.get(input.id)
      // A node that is new to this relay restarts the grace: the others of a restart come back one after another. One that
      // reconnects under its own id (a bad connection) does not, or it would postpone the answer for as long as it flapped.
      if (!previous) lastJoinAt = now()
      const node: NodeState = {
        id: input.id,
        maxContexts: input.maxContexts,
        draining: false,
        lastSeen: now(),
        link: input.link,
        slots: new Set(previous?.slots),
        reserved: 0,
        features: new Set(input.features),
        labels: new Set(input.labels),
        exclusive: Boolean(input.exclusive)
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
    answerCreate(id: string, reqId: string, error?: string, refused = false) {
      const pending = pendingCreates.get(reqId)
      if (!pending || pending.nodeId !== id) return
      clearTimeout(pending.timer)
      pendingCreates.delete(reqId)
      // A node that says it cannot make this slot is not one that is merely busy: the person who asked is told why. What the node
      // said is quoted in the relay's own sentence, as plain printable text and no longer than a short reason, so a node cannot
      // make its words read as the relay's.
      if (error) pending.reject(refused ? new UnsupportedError(refusalMessage(error)) : new Error(error))
      else pending.resolve()
    },

    /**
     * Reserves a slot on the least-loaded node that has room, waiting up to `waitMs` for one to free up. The token it
     * returns is the only time it exists in the clear.
     */
    async allocate(input: {
      runId: string
      maxLifetimeSeconds: number
      waitMs: number
      signal?: AbortSignal
      /** What the slot needs of its node (a feature, a label): only a node that has all of it is used. */
      need?: SlotNeeds
      /** What the node is told to do for the slot. Not kept: the registry holds no option, and a proxy's password is one. */
      options?: SlotOptions
    }) {
      const { signal } = input
      const need = input.need ?? NO_NEEDS
      const deadline = now() + input.waitMs
      const failed = new Set<string>()
      /** Why the nodes that refused this slot did, by node: what asking again would get. */
      const refusals = new Map<string, string>()
      for (;;) {
        if (signal?.aborted) throw new AllocationAbortedError()
        // Nodes are here and none could ever do this: waiting is pointless. Nodes are not here yet (a restart): wait.
        if (
          nodes.size > 0 &&
          now() - lastJoinAt >= unsupportedGraceMs &&
          ![...nodes.values()].some((n) => serves(n, need))
        ) {
          throw new UnsupportedError(explainUnsupported(need))
        }
        const node = pick(failed, need)
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
            if (error instanceof UnsupportedError) refusals.set(node.id, error.message)
            continue
          }
        }
        // Every node that could serve this slot refused it: waiting would only ask them again.
        // (A node that is draining or disconnected could not be tried: it is not one that was asked and said no.)
        const refusing = [...nodes.values()].filter((n) => n.link && !n.draining && serves(n, need))
        if (refusals.size > 0 && refusing.length > 0 && refusing.every((n) => refusals.has(n.id))) {
          throw new UnsupportedError([...new Set(refusing.map((n) => refusals.get(n.id)!))].join('; '))
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

    /** A node says a context it held ended on its own. Only the node that holds a slot can end it this way. */
    endFromNode(nodeId: string, slotId: string, reason: string) {
      if (slots.get(slotId)?.nodeId !== nodeId) return false
      return dropSlot(slotId, reason, false)
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

    /** Slots, optionally only those whose run id `include` accepts (so another namespace's are never summarised). */
    listSlots(include?: (runId: string) => boolean): SlotSummary[] {
      return [...slots.values()]
        .filter((slot) => !include || include(slot.runId))
        .map((slot) => ({
          slotId: slot.slotId,
          runId: slot.runId,
          nodeId: slot.nodeId,
          createdAt: new Date(slot.createdAt).toISOString()
        }))
    },

    /** How many slots have a run id `include` accepts, without building summaries. */
    countSlots(include: (runId: string) => boolean) {
      let count = 0
      for (const slot of slots.values()) if (include(slot.runId)) count++
      return count
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
        lastSeenAt: new Date(node.lastSeen).toISOString(),
        features: [...node.features],
        labels: [...node.labels],
        exclusive: node.exclusive
      }))
    }
  }
}

export type NodeRegistry = ReturnType<typeof createNodeRegistry>
