/**
 * What a node with one shared Chromium gives its agent: a `RunHost` over the scope hub (scope.ts).
 *
 * The hub makes a browser context per slot and knows nothing about sockets. A slot that asked for a proxy gets, here, a
 * forwarder of its own (proxy-forwarder.ts), and the hub makes its context with the forwarder's address. The forwarder lives
 * as long as the slot: it is closed when the slot's browser is.
 *
 * A shared Chromium takes a proxy per context but a time zone and a language only per browser, so it cannot do those for one
 * slot. It does not advertise the feature that asks for them, and refuses them here too, so a slot is never made without
 * what it was asked for.
 */
import type { SlotOptions } from '../protocol.js'
import { SlotRefusedError } from '../slot-options.js'
import { runContext, startProxyForwarder, type ProxyForwarder, type ProxyForwarderOptions } from './proxy-forwarder.js'
import type { CdpScope, RunHost } from './scope.js'
import { signerFor, type SigningHost } from './signing.js'

export interface ScopeHostOptions extends ProxyForwarderOptions {
  /** For tests: how a slot's forwarder is started. */
  startForwarder?: typeof startProxyForwarder
  /** How this node signs requests, when it does. */
  signing?: SigningHost
}

export function createScopeHost(scope: CdpScope, options: ScopeHostOptions = {}): RunHost {
  const { startForwarder = startProxyForwarder, signing, ...forwarderOptions } = options
  const forwarders = new Map<string, ProxyForwarder>()

  return {
    async createRun(runKey: string, slot?: SlotOptions) {
      if (slot?.timezone !== undefined || slot?.locale !== undefined) {
        throw new SlotRefusedError('A shared browser cannot set a time zone or a language for one slot')
      }
      const signer = signerFor(slot ?? {}, signing)
      const forwarder = slot?.proxy ? await startForwarder(slot.proxy, forwarderOptions) : undefined
      try {
        const result = await scope.createRun(runKey, runContext(forwarder, slot?.proxy, signer))
        if (forwarder) forwarders.set(runKey, forwarder)
        return result
      } catch (error) {
        await forwarder?.close()
        throw error
      }
    },
    async disposeRun(runKey: string) {
      try {
        await scope.disposeRun(runKey)
      } finally {
        const forwarder = forwarders.get(runKey)
        forwarders.delete(runKey)
        await forwarder?.close()
      }
    },
    connect: (runKey, transport) => scope.connect(runKey, transport)
  }
}
