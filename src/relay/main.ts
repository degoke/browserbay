import { jsonLog as log } from '../log.js'
import { parseRelayConfig } from './config.js'
import { createRelayServer } from './server.js'

/**
 * Runs the relay as a process: `browserbay relay`. It needs no database, cache or browser, only BROWSERBAY_API_KEY and
 * BROWSERBAY_ENROLLMENT_SECRETS (and PORT). Run it as a single instance: the nodes' sockets live in this process.
 */
export async function runRelay(env: NodeJS.ProcessEnv = process.env) {
  const config = parseRelayConfig(env)
  const relay = createRelayServer({
    apiKey: config.apiKey,
    enrollmentSecrets: config.enrollmentSecrets,
    maxAcquireWaitMs: config.maxAcquireWaitMs,
    logger: { info: log('info'), warn: log('warn') }
  })
  const port = await relay.listen(config.port)
  log('info')('browserbay relay listening', { port, enrollments: config.enrollmentSecrets.map((entry) => entry.id) })

  const shutdown = async () => {
    await relay.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  return relay
}
