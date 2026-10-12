/**
 * The all-in-one box: `browserbox start`. The relay and a browser node in one process, for the common case of "give me a
 * browser service on this machine". One setting is required:
 *
 *   BROWSERBOX_API_KEY     at least 16 characters; what your services present to create and release browsers
 *
 * Everything else has a default (PORT 8788, BROWSERBOX_MAX_CONTEXTS 5; the node settings are in node/main.mjs). The node
 * joins the relay over loopback with an enrollment secret made up for this run, so there is nothing else to configure.
 *
 * To add capacity later, set BROWSERBOX_ENROLLMENT_SECRETS here (the same `name:sha256` list the relay takes) and run
 * `browserbox node` elsewhere with the matching secret: remote nodes dial this box like any other relay.
 *
 * The relay is TypeScript and is compiled to dist/ by `pnpm build` (the image does this).
 */
import { createHash, randomBytes } from 'node:crypto'
import { ConfigError, startBrowserNode } from '../node/browser-node.mjs'
import { consoleLogger, parseNodeSettings, superviseNode } from '../node/main.mjs'

const jsonLog = (level) => (message, fields) => console.log(JSON.stringify({ level, message, ...fields }))

export async function runBox(env = process.env) {
  let relayModule
  let configModule
  try {
    relayModule = await import('../../dist/relay/server.js')
    configModule = await import('../../dist/relay/config.js')
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    console.error('The relay is not built. Run `pnpm build` first (the Docker image does this for you).')
    process.exit(2)
  }

  let config
  let settings
  try {
    config = configModule.parseBoxConfig(env)
    settings = parseNodeSettings(env)
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }

  const localSecret = randomBytes(24).toString('base64url')
  const relay = relayModule.createRelayServer({
    apiKey: config.apiKey,
    enrollmentSecrets: [
      { id: 'local', sha256: createHash('sha256').update(localSecret).digest('hex') },
      ...config.remoteEnrollmentSecrets
    ],
    maxAcquireWaitMs: config.maxAcquireWaitMs,
    logger: { info: jsonLog('info'), warn: jsonLog('warn') }
  })
  const port = await relay.listen(config.port)
  jsonLog('info')('browserbox listening', {
    port,
    remoteNodes: config.remoteEnrollmentSecrets.map((entry) => entry.id)
  })

  let node
  try {
    node = await startBrowserNode({
      ...settings,
      relayUrl: `http://127.0.0.1:${port}`,
      enrollmentSecret: localSecret,
      logger: consoleLogger
    })
  } catch (error) {
    console.error(`node: ${error.message}`)
    await relay.close()
    process.exit(error instanceof ConfigError ? 2 : 1)
  }
  superviseNode(node, { drainSeconds: settings.drainSeconds, beforeExit: () => relay.close() })
  return { relay, node, port }
}
