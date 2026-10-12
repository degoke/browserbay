import { parseRelayConfig } from './config.js'
import { createRelayServer } from './server.js'

const log = (level: string) => (message: string, fields?: Record<string, unknown>) =>
  console.log(JSON.stringify({ level, message, ...fields }))

/**
 * Runs the relay as a process: `browserbox relay`. It needs no database, cache or browser, only BROWSERBOX_API_KEY and
 * BROWSERBOX_ENROLLMENT_SECRETS (and PORT). Run it as a single instance: the nodes' sockets live in this process.
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
  log('info')('browserbox relay listening', { port, enrollments: config.enrollmentSecrets.map((entry) => entry.id) })

  const shutdown = async () => {
    await relay.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  return relay
}
