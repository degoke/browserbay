import assert from 'node:assert/strict'
import test from 'node:test'
import { generateSigningKey, createRequestSigner } from '../web-bot-auth.js'
import { signerFor, signingFeatures, type SigningHost } from './signing.js'

const key = generateSigningKey()
const host = (mode: SigningHost['mode']): SigningHost => ({
  mode,
  signer: createRequestSigner({ key: key.privateJwk, agent: 'https://box.example.com' })
})

test('what a node says it can do about signing: a way to sign with its key, and a way not to when its mode allows', () => {
  assert.deepEqual(signingFeatures(undefined), ['unsigned'])
  assert.deepEqual(signingFeatures(host('optional')), ['sign', `wba-key:${key.keyid}`, 'unsigned'])
  assert.deepEqual(
    signingFeatures(host('always')),
    ['sign', `wba-key:${key.keyid}`],
    'a node that always signs cannot leave one unsigned'
  )
})

test('whether a slot is signed: asked for, the node’s own default, or refused as the node cannot', () => {
  const optional = host('optional')
  const always = host('always')
  assert.equal(signerFor({ signRequests: true }, optional), optional.signer)
  assert.equal(signerFor({ signRequests: true }, always), always.signer)
  assert.equal(signerFor({}, optional), undefined, 'optional: only the slots that ask')
  assert.equal(signerFor({}, always), always.signer, 'always: every slot')
  assert.equal(signerFor({ signRequests: false }, optional), undefined)
  assert.equal(signerFor({}, undefined), undefined, 'a node that does not sign leaves every slot as it is')
  assert.equal(signerFor({ signRequests: false }, undefined), undefined)

  assert.throws(
    () => signerFor({ signRequests: true }, undefined),
    /does not sign requests/,
    'never a slot asked to be signed with no signer'
  )
  assert.throws(
    () => signerFor({ signRequests: false }, always),
    /cannot leave one unsigned/,
    'nor one asked not to be with one'
  )
})
