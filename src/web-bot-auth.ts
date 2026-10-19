/**
 * Web Bot Auth: a box saying who it is.
 *
 * A site that blocks bots can also choose to let known ones in, and the way a bot makes itself known is to sign its requests
 * (HTTP Message Signatures, RFC 9421) with a key whose public half it publishes at a well-known address. This is that, and
 * only that: the signing of a request, and the document that publishes the key. It does not hide anything: a signed browser
 * says plainly that it is a bot, and whose.
 *
 *   Signature-Agent:  "https://box.example.com"
 *   Signature-Input:  sig1=("@authority" "signature-agent");created=...;keyid="...";alg="ed25519";expires=...;nonce="...";tag="web-bot-auth"
 *   Signature:        sig1=:...:
 *
 * The key is Ed25519, and its id is the JWK thumbprint (RFC 7638) of the public key, which is what verifiers look it up by.
 * The relay serves the key directory (`/.well-known/http-message-signatures-directory`), and each node signs with the private key.
 * It uses `node:crypto` and nothing else, so it adds no dependency; the tests check it against Cloudflare's own library.
 *
 * `Signature-Agent` has two spellings. The IETF draft moved it to a dictionary (`sig1="https://..."`, covered as
 * `"signature-agent";key="sig1"`). Cloudflare's verifier, as of October 2026, still wants the older quoted string and rejects
 * the dictionary. The format is a setting, and the default is the one that verifies.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject
} from 'node:crypto'
import { ConfigError } from './protocol.js'

export type SignatureAgentFormat = 'legacy' | 'dictionary'

/** The media type a key directory is served as. */
export const DIRECTORY_MEDIA_TYPE = 'application/http-message-signatures-directory+json'
export const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory'

const LABEL = 'sig1'
const TAG = 'web-bot-auth'
const DIRECTORY_TAG = 'http-message-signatures-directory'

export interface SigningKey {
  privateKey: KeyObject
  /** The public half as a JWK, with nothing private in it. */
  publicJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string }
  /** The JWK thumbprint of the public key (RFC 7638): how a verifier finds the key. */
  keyid: string
}

const b64url = (bytes: Buffer) => bytes.toString('base64url')

/** The RFC 7638 thumbprint of an Ed25519 public key: SHA-256 of the three members, in order, with no spaces. */
export function thumbprint(x: string): string {
  return b64url(createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest())
}

/** Reads a private key written as a JWK. Throws a ConfigError that says what is wrong, and never repeats the key. */
export function parseSigningKey(text: string): SigningKey {
  let jwk: Record<string, unknown>
  try {
    jwk = JSON.parse(text)
  } catch {
    throw new ConfigError(
      'The Web Bot Auth key must be a JSON Web Key (a JSON object). Make one with `browserbay web-bot-auth`.'
    )
  }
  if (typeof jwk !== 'object' || jwk === null || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
    throw new ConfigError('The Web Bot Auth key must be an Ed25519 key: a JWK with "kty": "OKP" and "crv": "Ed25519".')
  }
  if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string') {
    throw new ConfigError('The Web Bot Auth key must be a private key: it needs both "d" and "x".')
  }
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x }, format: 'jwk' })
  } catch {
    throw new ConfigError('The Web Bot Auth key is not a usable Ed25519 private key.')
  }
  const derived = createPublicKey(privateKey).export({ format: 'jwk' }).x
  if (derived !== jwk.x)
    throw new ConfigError('The Web Bot Auth key is inconsistent: its "x" is not the public half of its "d".')
  return { privateKey, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: derived }, keyid: thumbprint(derived) }
}

/** A new key, as the JSON to give `BROWSERBAY_WEB_BOT_AUTH_KEY`, and what identifies it. */
export function generateSigningKey(): {
  privateJwk: string
  keyid: string
  publicJwk: SigningKey['publicJwk'] & { kid: string }
} {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string }
  const keyid = thumbprint(jwk.x)
  return {
    privateJwk: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x, kid: keyid }),
    keyid,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: keyid }
  }
}

/** Where a box says it is: an https origin, such as `https://browsers.example.com`, with no path. */
export function parseAgent(value: unknown): string {
  let url: URL | undefined
  try {
    url = typeof value === 'string' ? new URL(value) : undefined
  } catch {
    url = undefined
  }
  if (!url || url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
    throw new ConfigError(
      'The Web Bot Auth agent must be the https address your relay is served at, as an origin with no path or trailing slash, such as https://browsers.example.com.'
    )
  }
  return url.origin
}

export interface RequestSigner {
  /** The id of the key requests are signed with. */
  keyid: string
  /** The headers to add to a request for `url`: `signature-agent`, `signature-input` and `signature`. */
  sign(url: string): Record<string, string>
}

export interface SignerOptions {
  /** The private key, as a JWK in JSON. */
  key: string
  /** Where the box says it is (see `parseAgent`). */
  agent: string
  /** Default `legacy`: the spelling Cloudflare's verifier accepts. */
  format?: SignatureAgentFormat
  /** How long a signature is good for, in seconds (default 60). Sites want it short. */
  ttlSeconds?: number
}

/** For tests: the clock, the nonce and the label are the only things a signature is not made of. */
export interface SignerHooks {
  now?: () => number
  nonce?: () => string
  label?: string
}

export function createRequestSigner(options: SignerOptions, hooks: SignerHooks = {}): RequestSigner {
  const key = parseSigningKey(options.key)
  const agent = parseAgent(options.agent)
  const format = options.format ?? 'legacy'
  const ttl = options.ttlSeconds ?? 60
  if (format !== 'legacy' && format !== 'dictionary')
    throw new ConfigError('The Web Bot Auth format must be "legacy" or "dictionary".')
  if (!Number.isInteger(ttl) || ttl < 10 || ttl > 86_400) {
    throw new ConfigError('The Web Bot Auth signature lifetime must be a whole number of seconds from 10 to 86400.')
  }
  const { now = Date.now, label = LABEL } = hooks
  // 64 random bytes, as the draft recommended and as verifiers that check a nonce expect.
  const nonce = hooks.nonce ?? (() => randomBytes(64).toString('base64'))
  const components =
    format === 'dictionary' ? `("@authority" "signature-agent";key="${label}")` : '("@authority" "signature-agent")'
  const agentValue = format === 'dictionary' ? `${label}="${agent}"` : `"${agent}"`
  // What the signature covers for `signature-agent`: the header as sent, or (dictionary) the member of it, quoted.
  const coveredAgent =
    format === 'dictionary' ? `"signature-agent";key="${label}": "${agent}"` : `"signature-agent": ${agentValue}`

  return {
    keyid: key.keyid,
    sign(url) {
      // `host` is the authority a server sees: lower case, with the port only when it is not the scheme's own.
      const authority = new URL(url).host
      const created = Math.floor(now() / 1000)
      const params = `${components};created=${created};keyid="${key.keyid}";alg="ed25519";expires=${created + ttl};nonce="${nonce()}";tag="${TAG}"`
      const base = `"@authority": ${authority}\n${coveredAgent}\n"@signature-params": ${params}`
      const signature = sign(null, Buffer.from(base), key.privateKey).toString('base64')
      return {
        'signature-agent': agentValue,
        'signature-input': `${label}=${params}`,
        signature: `${label}=:${signature}:`
      }
    }
  }
}

/**
 * The key directory, and the headers of the response that serves it. Verifiers fetch it from the address a bot gives in
 * `Signature-Agent`, and some (Cloudflare's, to register a bot) want the response itself signed, over the authority of the
 * request it answers. So the headers are made per request, for the host that was asked.
 */
export function createDirectory(keyText: string, hooks: { now?: () => number } = {}) {
  const key = parseSigningKey(keyText)
  const now = hooks.now ?? Date.now
  const body = JSON.stringify({ keys: [{ ...key.publicJwk, kid: key.keyid }] })
  return {
    keyid: key.keyid,
    body,
    /** The headers for a response to a request for `authority` (its Host header). */
    headers(authority: string): Record<string, string> {
      const created = Math.floor(now() / 1000)
      const params = `("@authority";req);created=${created};expires=${created + 300};keyid="${key.keyid}";alg="ed25519";tag="${DIRECTORY_TAG}"`
      const base = `"@authority";req: ${authority.toLowerCase()}\n"@signature-params": ${params}`
      const signature = sign(null, Buffer.from(base), key.privateKey).toString('base64')
      return {
        'content-type': DIRECTORY_MEDIA_TYPE,
        // The signature expires in 300 s, so a cache must not hand it out for longer than that: it is made fresh per request.
        'cache-control': 'no-store',
        'signature-input': `${LABEL}=${params}`,
        signature: `${LABEL}=:${signature}:`
      }
    }
  }
}

export type Directory = ReturnType<typeof createDirectory>
