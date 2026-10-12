import { z } from 'zod'
import type { EnrollmentSecret } from './server.js'

/** A setting the operator has to fix. The CLI exits with status 2 for it, as it does for a node's. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

/**
 * `name:sha256hex` pairs, comma-separated: one per node (or group of nodes) allowed to join. Generate an entry with
 * `browserbox secret` and give the node the secret and the relay the hash.
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
      if (separator < 1 || !/^[\w.-]+$/.test(id) || !/^[0-9a-f]{64}$/i.test(sha256)) {
        throw new ConfigError('BROWSERBOX_ENROLLMENT_SECRETS must be comma-separated name:sha256hex pairs')
      }
      return { id, sha256: sha256.toLowerCase() }
    })
  if (entries.length === 0 && !allowEmpty)
    throw new ConfigError('BROWSERBOX_ENROLLMENT_SECRETS needs at least one entry')
  return entries
}

const relayEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  BROWSERBOX_API_KEY: z.string().min(16),
  BROWSERBOX_ENROLLMENT_SECRETS: z.string().min(1),
  BROWSERBOX_MAX_ACQUIRE_WAIT_MS: z.coerce.number().int().min(0).max(300_000).default(60_000)
})

/** The relay's own settings. It has no database, cache or auth of its own: only these. */
export function parseRelayConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = relayEnvSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new ConfigError(`Invalid relay configuration: ${problems}`)
  }
  return {
    port: parsed.data.PORT,
    apiKey: parsed.data.BROWSERBOX_API_KEY,
    enrollmentSecrets: parseEnrollmentSecrets(parsed.data.BROWSERBOX_ENROLLMENT_SECRETS),
    maxAcquireWaitMs: parsed.data.BROWSERBOX_MAX_ACQUIRE_WAIT_MS
  }
}

const boxEnvSchema = relayEnvSchema.extend({
  /** Optional here: a box has its own node, so remote nodes are an extra, not a requirement. */
  BROWSERBOX_ENROLLMENT_SECRETS: z.string().default('')
})

/** The all-in-one box's relay settings: the relay's, with remote nodes optional (`browserbox start`). */
export function parseBoxConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = boxEnvSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new ConfigError(`Invalid configuration: ${problems}`)
  }
  return {
    port: parsed.data.PORT,
    apiKey: parsed.data.BROWSERBOX_API_KEY,
    remoteEnrollmentSecrets: parseEnrollmentSecrets(parsed.data.BROWSERBOX_ENROLLMENT_SECRETS, { allowEmpty: true }),
    maxAcquireWaitMs: parsed.data.BROWSERBOX_MAX_ACQUIRE_WAIT_MS
  }
}
