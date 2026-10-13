/**
 * Runs a node as a process: `browserbay node`. One shared Chromium, one BrowserContext per slot, reached only through
 * the relay. Configuration (all environment variables):
 *
 *   BROWSERBAY_RELAY_URL           required  the relay's base URL, e.g. https://relay.example.com
 *   BROWSERBAY_ENROLLMENT_SECRET   required  this node's enrollment secret (the relay holds its sha256)
 *   BROWSERBAY_NODE_ID                       a name for this node, unique per replica (default: the hostname)
 *   BROWSERBAY_MAX_CONTEXTS                  concurrent slots on this node (default 5; size it to the node's memory)
 *   BROWSERBAY_DRAIN_SECONDS                 how long a stopping node waits for its slots (default 120)
 *   BROWSERBAY_CHROMIUM_SANDBOX              'true' keeps Chromium's own sandbox on (needs user namespaces)
 *   BROWSERBAY_HEADLESS                      'false' for a headful browser (needs a display)
 *   BROWSERBAY_PROFILE_DIR                   Chromium's profile (default: a fresh temporary directory)
 *   BROWSERBAY_CHROMIUM_EXECUTABLE           a Chromium other than the one in the image
 *   BROWSERBAY_CHROMIUM_ENV_PASSTHROUGH      comma-separated names of environment variables the browser should also see
 *                                            (it gets only an allowlist otherwise; never BROWSERBAY_* ones)
 *
 * The process leaves when Chromium does, so give it a restart policy of "always".
 */
import { hostname } from 'node:os'
import { errorMessage } from '../errors.js'
import { NODE_LIMITS } from '../protocol.js'
import type { AgentLogger } from './agent.js'
import { ConfigError, startBrowserNode, type BrowserNode } from './browser-node.js'

export interface NodeSettings {
  nodeId: string
  maxContexts: number
  drainSeconds: number
  profileDir: string | undefined
  headless: boolean
  sandbox: boolean
}

/** The settings of the browser itself, shared by `browserbay node` and the all-in-one `browserbay start`. */
export function parseNodeSettings(env: NodeJS.ProcessEnv = process.env): NodeSettings {
  const maxContexts = Number(env.BROWSERBAY_MAX_CONTEXTS || 5)
  if (!Number.isInteger(maxContexts) || maxContexts < 1 || maxContexts > NODE_LIMITS.maxContexts) {
    throw new Error(`BROWSERBAY_MAX_CONTEXTS must be a whole number from 1 to ${NODE_LIMITS.maxContexts}.`)
  }
  // The hostname is only a default: make it fit rather than refuse to start on a machine with an unusual one.
  const nodeId =
    env.BROWSERBAY_NODE_ID ||
    hostname()
      .replace(/[^\w.-]/g, '-')
      .slice(0, 100) ||
    'node'
  if (!NODE_LIMITS.nodeIdPattern.test(nodeId)) {
    throw new Error('BROWSERBAY_NODE_ID may only contain letters, digits, "_", "." and "-" (up to 100 characters).')
  }
  // Empty or blank means "not set", as it does for the other settings (platforms and Compose pass empty variables).
  const drainText = (env.BROWSERBAY_DRAIN_SECONDS ?? '').trim()
  const drainSeconds = drainText === '' ? 120 : Number(drainText)
  if (!Number.isFinite(drainSeconds) || drainSeconds < 0) {
    throw new Error('BROWSERBAY_DRAIN_SECONDS must be a number of seconds, 0 or more.')
  }
  return {
    nodeId,
    maxContexts,
    drainSeconds,
    profileDir: env.BROWSERBAY_PROFILE_DIR || undefined,
    headless: env.BROWSERBAY_HEADLESS !== 'false',
    sandbox: env.BROWSERBAY_CHROMIUM_SANDBOX === 'true'
  }
}

/** Reads a stand-alone node's settings from the environment. Throws an Error whose message says what to fix. */
export function parseNodeEnv(env: NodeJS.ProcessEnv = process.env) {
  const relayUrl = env.BROWSERBAY_RELAY_URL ?? ''
  const enrollmentSecret = env.BROWSERBAY_ENROLLMENT_SECRET ?? ''
  if (!relayUrl || enrollmentSecret.length < 16) {
    throw new Error('BROWSERBAY_RELAY_URL and BROWSERBAY_ENROLLMENT_SECRET (at least 16 characters) are required.')
  }
  return { relayUrl, enrollmentSecret, ...parseNodeSettings(env) }
}

export const consoleLogger: AgentLogger = {
  info: (message, fields) => console.error(`node: ${message}`, fields ? JSON.stringify(fields) : ''),
  warn: (message, fields) => console.error(`node: WARN ${message}`, fields ? JSON.stringify(fields) : '')
}

/**
 * Leaves the process when the node ends (non-zero when Chromium died), drains on SIGTERM and stops on SIGINT.
 * Shared with `browserbay start`, which passes what else has to be closed first.
 */
export function superviseNode(
  node: BrowserNode,
  { drainSeconds, beforeExit }: { drainSeconds: number; beforeExit?: () => Promise<void> | void }
) {
  let leaving = false
  const leave = async (code: number) => {
    if (leaving) return
    leaving = true
    await beforeExit?.()
    process.exit(code)
  }
  void node.exited.then(({ crashed }) => leave(crashed ? 1 : 0))
  process.on('SIGINT', () => void node.close('SIGINT'))
  process.on('SIGTERM', () => void node.drain(drainSeconds * 1000))
}

export async function runNode(env: NodeJS.ProcessEnv = process.env) {
  let config: ReturnType<typeof parseNodeEnv>
  try {
    config = parseNodeEnv(env)
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(2)
  }
  let node: BrowserNode
  try {
    node = await startBrowserNode({ ...config, logger: consoleLogger })
  } catch (error) {
    console.error(`node: ${errorMessage(error)}`)
    process.exit(error instanceof ConfigError ? 2 : 1)
  }
  superviseNode(node, { drainSeconds: config.drainSeconds })
}
