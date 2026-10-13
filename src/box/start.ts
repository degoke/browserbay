/**
 * The all-in-one box: `browserbay start`. The relay and a browser node in one process, for the common case of "give me a
 * browser service on this machine". One setting is required:
 *
 *   BROWSERBAY_API_KEY     at least 16 characters; what your services present to create and release browsers
 *                          (or BROWSERBAY_API_KEYS: one key per service, each optionally confined to a namespace)
 *
 * Everything else has a default (PORT 8788, BROWSERBAY_MAX_CONTEXTS 5; the node settings are in node/main.ts). The node
 * joins the relay over loopback with an enrollment secret made up for this run, so there is nothing else to configure.
 *
 * To add capacity later, set BROWSERBAY_ENROLLMENT_SECRETS here (the same `name:sha256` list the relay takes) and run
 * `browserbay node` elsewhere with the matching secret: remote nodes dial this box like any other relay.
 */
import { createHash, randomBytes } from 'node:crypto'
import { errorMessage } from '../errors.js'
import { jsonLog } from '../log.js'
import { ConfigError, startBrowserNode, type BrowserNode } from '../node/browser-node.js'
import { consoleLogger, parseNodeSettings, superviseNode, type NodeSettings } from '../node/main.js'
import { parseBoxConfig } from '../relay/config.js'
import { createRelayServer } from '../relay/server.js'

export async function runBox(env: NodeJS.ProcessEnv = process.env) {
  let config: ReturnType<typeof parseBoxConfig>
  let settings: NodeSettings
  try {
    config = parseBoxConfig(env)
    settings = parseNodeSettings(env)
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(2)
  }

  const localSecret = randomBytes(24).toString('base64url')
  const relay = createRelayServer({
    apiKeys: config.apiKeys,
    enrollmentSecrets: [
      { id: 'local', sha256: createHash('sha256').update(localSecret).digest('hex') },
      ...config.remoteEnrollmentSecrets
    ],
    maxAcquireWaitMs: config.maxAcquireWaitMs,
    logger: { info: jsonLog('info'), warn: jsonLog('warn') }
  })
  const port = await relay.listen(config.port)
  jsonLog('info')('browserbay listening', {
    port,
    remoteNodes: config.remoteEnrollmentSecrets.map((entry) => entry.id)
  })

  let node: BrowserNode
  try {
    node = await startBrowserNode({
      ...settings,
      relayUrl: `http://127.0.0.1:${port}`,
      enrollmentSecret: localSecret,
      logger: consoleLogger
    })
  } catch (error) {
    console.error(`node: ${errorMessage(error)}`)
    await relay.close()
    process.exit(error instanceof ConfigError ? 2 : 1)
  }
  superviseNode(node, { drainSeconds: settings.drainSeconds, beforeExit: () => relay.close() })
  return { relay, node, port }
}
