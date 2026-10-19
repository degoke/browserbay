/**
 * Whether a slot's requests are signed (Web Bot Auth), and by what.
 *
 * A node is set to `off` (never), `optional` (only a slot that asks with `signRequests: true`) or `always` (every slot). The
 * relay already placed a slot on a node that can do what it asks, and the agent refused a slot the node cannot serve, so this is
 * the last say: it never makes a slot that was asked to be signed without a signer, or one that was asked not to be with one.
 */
import { NODE_FEATURE, SIGNING_KEY_FEATURE, type SlotOptions } from '../protocol.js'
import { SlotRefusedError } from '../slot-options.js'
import type { RequestSigner, SignatureAgentFormat } from '../web-bot-auth.js'

/** What a node that signs needs: the key, where the box says it is, and how. Checked, so a bad one stops the node at start-up. */
export interface WebBotAuthSettings {
  mode: 'optional' | 'always'
  key: string
  agent: string
  format: SignatureAgentFormat
  ttlSeconds: number
}

export interface SigningHost {
  mode: 'optional' | 'always'
  signer: RequestSigner
}

/** The signer for a slot, or undefined when its requests are not to be signed. */
export function signerFor(slot: SlotOptions, signing?: SigningHost): RequestSigner | undefined {
  if (slot.signRequests === false) {
    if (signing?.mode === 'always')
      throw new SlotRefusedError('This node signs every slot, so it cannot leave one unsigned')
    return undefined
  }
  const wanted = slot.signRequests === true || (slot.signRequests === undefined && signing?.mode === 'always')
  if (!wanted) return undefined
  if (!signing) throw new SlotRefusedError('This node does not sign requests')
  return signing.signer
}

/** What a node says it can do about signing: a way to sign, and a way not to, as its mode allows. */
export function signingFeatures(signing?: SigningHost): string[] {
  if (!signing) return [NODE_FEATURE.unsigned]
  return [
    NODE_FEATURE.sign,
    `${SIGNING_KEY_FEATURE}${signing.signer.keyid}`,
    ...(signing.mode === 'optional' ? [NODE_FEATURE.unsigned] : [])
  ]
}
