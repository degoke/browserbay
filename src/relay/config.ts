import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ConfigError, NAME_PATTERN, quotaProblem } from '../protocol.js'
import { parseSigningKey } from '../web-bot-auth.js'
import type { ApiKeyEntry, EnrollmentSecret } from './server.js'

/**
 * `name:sha256hex` pairs, comma-separated: one per node (or group of nodes) allowed to join. Generate an entry with
 * `browserbay secret` and give the node the secret and the relay the hash.
 *
 * `allowEmpty` is for a box that runs its own node and has no remote ones; a standalone relay needs at least one.
 */
export function parseEnrollmentSecrets(value: string, { allowEmpty = false } = {}): EnrollmentSecret[] {
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.lastIndexOf(':')
      const id = part.slice(0, separator).trim()
      const sha256 = part.slice(separator + 1).trim()
      if (separator < 1 || !NAME_PATTERN.test(id) || !/^[0-9a-f]{64}$/i.test(sha256)) {
        throw new ConfigError('BROWSERBAY_ENROLLMENT_SECRETS must be comma-separated name:sha256hex pairs')
      }
      return { id, sha256: sha256.toLowerCase() }
    })
  if (entries.length === 0 && !allowEmpty)
    throw new ConfigError('BROWSERBAY_ENROLLMENT_SECRETS needs at least one entry')
  return entries
}

/**
 * `name:sha256hex[:namespace[:quota]]`, comma-separated: one per service allowed to create browsers. Make an entry with
 * `browserbay key <name>`. A key with a `namespace` can only create, see and release slots whose run id starts with
 * `<namespace>:`; `quota` caps how many slots that namespace holds at once, so it needs a namespace to count in
 * (`name:hash::5` is refused). Names, hashes and namespaces must each be unique across the entries.
 */
export function parseApiKeys(value: string): ApiKeyEntry[] {
  const bad = (why: string) =>
    new ConfigError(`BROWSERBAY_API_KEYS must be comma-separated name:sha256hex[:namespace[:quota]] entries (${why})`)
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): ApiKeyEntry => {
      const [id = '', sha256 = '', namespace = '', quota = '', ...extra] = part.split(':').map((field) => field.trim())
      if (extra.length > 0) throw bad(`too many fields in "${id}"`)
      if (!NAME_PATTERN.test(id)) throw bad(`"${id}" is not a valid name`)
      if (!/^[0-9a-f]{64}$/i.test(sha256)) throw bad(`the hash for "${id}" is not a sha256 in hex`)
      if (namespace && !NAME_PATTERN.test(namespace)) throw bad(`"${namespace}" is not a valid namespace`)
      const quotaIssue = quota ? quotaProblem(quota, namespace) : undefined
      if (quotaIssue) throw bad(`"${id}": ${quotaIssue}`)
      return {
        id,
        sha256: sha256.toLowerCase(),
        ...(namespace ? { namespace } : {}),
        ...(quota ? { maxSlots: Number(quota) } : {})
      }
    })
  assertDistinct(entries)
  return entries
}

/** Two keys with the same name, hash or namespace could not be told apart in logs, quotas or access checks. */
function assertDistinct(entries: ApiKeyEntry[]) {
  for (const field of ['id', 'sha256', 'namespace'] as const) {
    const seen = new Set<string>()
    for (const entry of entries) {
      const value = entry[field]
      if (value === undefined) continue
      if (seen.has(value))
        throw new ConfigError(`BROWSERBAY_API_KEYS: more than one entry has the same ${field}: ${value}`)
      seen.add(value)
    }
  }
}

const NO_KEY_PROBLEM = 'BROWSERBAY_API_KEY: Required (or BROWSERBAY_API_KEYS, to give each service its own)'

/**
 * Every key the relay accepts: BROWSERBAY_API_KEY (unrestricted, named `default`) and the BROWSERBAY_API_KEYS entries.
 * `prefix` is how the caller's error message starts, so each command words a missing setting the way it always did.
 */
function collectApiKeys(data: { BROWSERBAY_API_KEY?: string; BROWSERBAY_API_KEYS: string }, prefix: string) {
  const keys = parseApiKeys(data.BROWSERBAY_API_KEYS)
  if (data.BROWSERBAY_API_KEY) {
    keys.unshift({ id: 'default', sha256: createHash('sha256').update(data.BROWSERBAY_API_KEY).digest('hex') })
    assertDistinct(keys)
  }
  if (keys.length === 0) {
    throw new ConfigError(`${prefix}: ${NO_KEY_PROBLEM}`)
  }
  return keys
}

/** What is wrong, as one line. A missing API key comes first: it is the setting everyone has to make. */
function problemsOf(error: z.ZodError, env: NodeJS.ProcessEnv) {
  const problems = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
  if (!env.BROWSERBAY_API_KEY && !env.BROWSERBAY_API_KEYS?.trim()) problems.unshift(NO_KEY_PROBLEM)
  return problems.join('; ')
}

const relayEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  /** Optional on its own: BROWSERBAY_API_KEYS may be all there is. At least one of the two is checked after parsing. */
  BROWSERBAY_API_KEY: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(16).optional()),
  BROWSERBAY_API_KEYS: z.string().default(''),
  BROWSERBAY_ENROLLMENT_SECRETS: z.string().min(1),
  BROWSERBAY_MAX_ACQUIRE_WAIT_MS: z.coerce.number().int().min(0).max(300_000).default(60_000),
  /** The private key (a JWK) whose public half the relay publishes for Web Bot Auth. Empty means it publishes none. */
  BROWSERBAY_WEB_BOT_AUTH_KEY: z.string().default('')
})

/** The Web Bot Auth key, checked now so a bad one stops the process at start-up, or undefined for none. */
function webBotAuthKeyOf(text: string) {
  const key = text.trim()
  if (!key) return undefined
  parseSigningKey(key)
  return key
}

/** The relay's own settings. It has no database, cache or auth of its own: only these. */
export function parseRelayConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = relayEnvSchema.safeParse(env)
  if (!parsed.success) throw new ConfigError(`Invalid relay configuration: ${problemsOf(parsed.error, env)}`)
  return {
    port: parsed.data.PORT,
    apiKeys: collectApiKeys(parsed.data, 'Invalid relay configuration'),
    enrollmentSecrets: parseEnrollmentSecrets(parsed.data.BROWSERBAY_ENROLLMENT_SECRETS),
    maxAcquireWaitMs: parsed.data.BROWSERBAY_MAX_ACQUIRE_WAIT_MS,
    webBotAuthKey: webBotAuthKeyOf(parsed.data.BROWSERBAY_WEB_BOT_AUTH_KEY)
  }
}

const boxEnvSchema = relayEnvSchema.extend({
  /** Optional here: a box has its own node, so remote nodes are an extra, not a requirement. */
  BROWSERBAY_ENROLLMENT_SECRETS: z.string().default('')
})

/** The all-in-one box's relay settings: the relay's, with remote nodes optional (`browserbay start`). */
export function parseBoxConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = boxEnvSchema.safeParse(env)
  if (!parsed.success) throw new ConfigError(`Invalid configuration: ${problemsOf(parsed.error, env)}`)
  return {
    port: parsed.data.PORT,
    apiKeys: collectApiKeys(parsed.data, 'Invalid configuration'),
    remoteEnrollmentSecrets: parseEnrollmentSecrets(parsed.data.BROWSERBAY_ENROLLMENT_SECRETS, { allowEmpty: true }),
    maxAcquireWaitMs: parsed.data.BROWSERBAY_MAX_ACQUIRE_WAIT_MS,
    webBotAuthKey: webBotAuthKeyOf(parsed.data.BROWSERBAY_WEB_BOT_AUTH_KEY)
  }
}
