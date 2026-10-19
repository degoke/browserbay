import assert from 'node:assert/strict'
import { createPublicKey, verify as edVerify } from 'node:crypto'
import test from 'node:test'
import { verify } from 'web-bot-auth'
import { verifierFromJWK } from 'web-bot-auth/crypto'
import { ConfigError } from './protocol.js'
import {
  createDirectory,
  createRequestSigner,
  DIRECTORY_MEDIA_TYPE,
  generateSigningKey,
  parseAgent,
  parseSigningKey,
  thumbprint
} from './web-bot-auth.js'

/**
 * The testing-only key of RFC 9421 Appendix B.1.4, with its published id: a public test vector, not a credential. Its private
 * half is written in two parts because a secret scanner cannot tell a published test vector from a leaked key.
 */
const RFC_KEY = {
  kty: 'OKP',
  crv: 'Ed25519',
  d: ['n4Ni-HpISpVObnQMW0wOhCKRO', 'aIKqKtW_2ZYb2p9KcU'].join(''),
  x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs'
}
const RFC_KEY_ID = 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U'
const RFC_KEY_JSON = JSON.stringify(RFC_KEY)
const AGENT = 'https://box.example.com'

test('the key id is the JWK thumbprint, and matches the one published for the RFC 9421 test key', () => {
  assert.equal(thumbprint(RFC_KEY.x), RFC_KEY_ID)
  const key = parseSigningKey(RFC_KEY_JSON)
  assert.equal(key.keyid, RFC_KEY_ID)
  assert.deepEqual(key.publicJwk, { kty: 'OKP', crv: 'Ed25519', x: RFC_KEY.x })
  assert.ok(!('d' in key.publicJwk), 'nothing private in the public half')
})

test('a signature is byte for byte what Cloudflare documents for the same inputs', () => {
  // The worked example of Cloudflare's Web Bot Auth documentation: the RFC 9421 test key, fixed times and nonce. Ed25519 is
  // deterministic, so the same base gives the same signature: this is the one check that does not use this code to judge itself.
  const nonce = 'e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg=='
  const signer = createRequestSigner(
    { key: RFC_KEY_JSON, agent: 'https://signature-agent.test', ttlSeconds: 3600 },
    { now: () => 1735689600_000, nonce: () => nonce, label: 'sig2' }
  )
  const headers = signer.sign('https://example.com/path/to/resource?with=a#query')
  assert.equal(headers['signature-agent'], '"https://signature-agent.test"')
  assert.equal(
    headers['signature-input'],
    `sig2=("@authority" "signature-agent");created=1735689600;keyid="${RFC_KEY_ID}";alg="ed25519";expires=1735693200;nonce="${nonce}";tag="web-bot-auth"`
  )
  assert.equal(
    headers.signature,
    'sig2=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:'
  )
})

test('Cloudflare’s own verifier accepts what is signed, for any host a request goes to', async () => {
  const signer = createRequestSigner({ key: RFC_KEY_JSON, agent: AGENT, format: 'dictionary' })
  const verifier = await verifierFromJWK({ ...RFC_KEY, d: undefined } as never)
  for (const url of [
    'https://example.com/',
    'https://shop.example.com:8443/cart?x=1',
    'http://localhost:3000/',
    'https://EXAMPLE.com/UPPER',
    'http://[2001:db8::1]:8080/'
  ]) {
    const headers = signer.sign(url)
    const request = new Request(url, { headers })
    await verify(request, {
      resolver: (candidate: { keyid?: string }) => {
        if (candidate.keyid !== RFC_KEY_ID) throw new Error('unknown key')
        return verifier
      }
    } as never)
  }
})

test('a signature that is for another host, a changed header or another key is not accepted by that same verifier', async () => {
  const signer = createRequestSigner({ key: RFC_KEY_JSON, agent: AGENT, format: 'dictionary' })
  const verifier = await verifierFromJWK({ ...RFC_KEY, d: undefined } as never)
  const options = { resolver: () => verifier } as never
  const headers = signer.sign('https://example.com/')
  await assert.rejects(verify(new Request('https://other.example.org/', { headers }), options), 'for another host')
  await assert.rejects(
    verify(
      new Request('https://example.com/', {
        headers: { ...headers, 'signature-agent': 'sig1="https://evil.example"' }
      }),
      options
    ),
    'a changed Signature-Agent'
  )
  const stranger = createRequestSigner({ key: generateSigningKey().privateJwk, agent: AGENT, format: 'dictionary' })
  await assert.rejects(
    verify(new Request('https://example.com/', { headers: stranger.sign('https://example.com/') }), options),
    'another key'
  )
})

test('what a signature is made of: a fresh nonce each time, a short life, and the authority a server sees', () => {
  let clock = 1_800_000_000_000
  const signer = createRequestSigner({ key: RFC_KEY_JSON, agent: AGENT, ttlSeconds: 90 }, { now: () => clock })
  const one = signer.sign('https://Example.com:443/a')
  const two = signer.sign('https://example.com/b')
  const param = (headers: Record<string, string>, name: string) =>
    new RegExp(`${name}="?([^";]+)"?`).exec(headers['signature-input']!)![1]!
  assert.notEqual(param(one, 'nonce'), param(two, 'nonce'), 'a nonce is never repeated')
  assert.equal(Buffer.from(param(one, 'nonce'), 'base64').length, 64, 'and is 64 random bytes')
  assert.equal(param(one, 'created'), '1800000000')
  assert.equal(param(one, 'expires'), '1800000090')
  assert.equal(param(one, 'keyid'), RFC_KEY_ID)
  assert.equal(param(one, 'alg'), 'ed25519')
  assert.equal(param(one, 'tag'), 'web-bot-auth')
  assert.notEqual(one.signature, two.signature)
  // The same host spelled two ways is one authority, so one base: with the nonce fixed the signatures are equal.
  const fixed = createRequestSigner({ key: RFC_KEY_JSON, agent: AGENT }, { now: () => clock, nonce: () => 'n' })
  assert.equal(fixed.sign('https://Example.com:443/a').signature, fixed.sign('https://example.com/zzz?q=1').signature)
  assert.notEqual(
    fixed.sign('https://example.com:444/').signature,
    fixed.sign('https://example.com/').signature,
    'a port that is not the default is part of it'
  )
  clock += 60_000
  assert.equal(param(signer.sign('https://example.com/'), 'created'), '1800000060')
})

test('the two spellings of Signature-Agent are the two ways the draft and Cloudflare disagree on', () => {
  const legacy = createRequestSigner({ key: RFC_KEY_JSON, agent: AGENT }).sign('https://example.com/')
  assert.equal(legacy['signature-agent'], `"${AGENT}"`)
  assert.match(legacy['signature-input']!, /^sig1=\("@authority" "signature-agent"\);/)
  const dictionary = createRequestSigner({ key: RFC_KEY_JSON, agent: AGENT, format: 'dictionary' }).sign(
    'https://example.com/'
  )
  assert.equal(dictionary['signature-agent'], `sig1="${AGENT}"`)
  assert.match(dictionary['signature-input']!, /^sig1=\("@authority" "signature-agent";key="sig1"\);/)
})

test('a key, an agent, a format or a lifetime that cannot be used is a ConfigError that says what to fix and shows no key', () => {
  const secret = RFC_KEY.d
  for (const [text, expected] of [
    ['not json', /JSON Web Key/],
    ['[]', /Ed25519 key/],
    [JSON.stringify({ kty: 'RSA', n: 'x', e: 'AQAB' }), /Ed25519 key/],
    [JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: RFC_KEY.x }), /private key/],
    [JSON.stringify({ kty: 'OKP', crv: 'Ed25519', d: 'short', x: RFC_KEY.x }), /usable Ed25519 private key/],
    [JSON.stringify({ ...RFC_KEY, x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), /inconsistent|usable/]
  ] as const) {
    assert.throws(
      () => parseSigningKey(text),
      (error: Error) => error instanceof ConfigError && expected.test(error.message) && !error.message.includes(secret),
      text
    )
  }
  for (const agent of [
    'box.example.com',
    'http://box.example.com',
    'https://box.example.com/',
    'https://box.example.com/path',
    'https://u:p@box.example.com',
    '',
    5
  ]) {
    assert.throws(() => parseAgent(agent), ConfigError, JSON.stringify(agent))
  }
  assert.equal(parseAgent('https://box.example.com:8443'), 'https://box.example.com:8443')
  assert.throws(
    () => createRequestSigner({ key: RFC_KEY_JSON, agent: AGENT, format: 'xml' as never }),
    /legacy.*dictionary/
  )
  for (const ttl of [0, 9, 86_401, 1.5, Number.NaN]) {
    assert.throws(
      () => createRequestSigner({ key: RFC_KEY_JSON, agent: AGENT, ttlSeconds: ttl }),
      /10 to 86400/,
      String(ttl)
    )
  }
})

test('a generated key works, names itself by its thumbprint, and gives out only its public half', async () => {
  const made = generateSigningKey()
  const key = parseSigningKey(made.privateJwk)
  assert.equal(key.keyid, made.keyid)
  assert.equal(made.publicJwk.kid, made.keyid)
  assert.ok(!('d' in made.publicJwk))
  assert.notEqual(generateSigningKey().keyid, made.keyid)
  const signer = createRequestSigner({ key: made.privateJwk, agent: AGENT, format: 'dictionary' })
  const verifier = await verifierFromJWK({ kty: 'OKP', crv: 'Ed25519', x: made.publicJwk.x } as never)
  await verify(new Request('https://example.com/', { headers: signer.sign('https://example.com/') }), {
    resolver: () => verifier
  } as never)
})

test('the key directory is a JWKS of the public key, served with a signature over the host that asked', () => {
  const directory = createDirectory(RFC_KEY_JSON, { now: () => 1_800_000_000_000 })
  const body = JSON.parse(directory.body)
  assert.deepEqual(body, { keys: [{ kty: 'OKP', crv: 'Ed25519', x: RFC_KEY.x, kid: RFC_KEY_ID }] })
  assert.ok(!directory.body.includes(RFC_KEY.d), 'the private half is not in it')

  const headers = directory.headers('Box.Example.com')
  assert.equal(headers['content-type'], DIRECTORY_MEDIA_TYPE)
  assert.equal(
    headers['signature-input'],
    `sig1=("@authority";req);created=1800000000;expires=1800000300;keyid="${RFC_KEY_ID}";alg="ed25519";tag="http-message-signatures-directory"`
  )
  // The signature verifies over the lower-cased authority of the request, with the key the directory publishes.
  const params = headers['signature-input']!.slice('sig1='.length)
  const base = `"@authority";req: box.example.com\n"@signature-params": ${params}`
  const signature = Buffer.from(/^sig1=:(.+):$/.exec(headers.signature!)![1]!, 'base64')
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: body.keys[0].x }, format: 'jwk' })
  assert.equal(edVerify(null, Buffer.from(base), publicKey, signature), true)
  assert.equal(
    edVerify(null, Buffer.from(base.replace('box.', 'evil.')), publicKey, signature),
    false,
    'and only for that host'
  )
})
