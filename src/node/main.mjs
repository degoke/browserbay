/**
 * Runs a node as a process: `browserbox node`. One shared Chromium, one BrowserContext per slot, reached only through
 * the relay. Configuration (all environment variables):
 *
 *   BROWSERBOX_RELAY_URL           required  the relay's base URL, e.g. https://relay.example.com
 *   BROWSERBOX_ENROLLMENT_SECRET   required  this node's enrollment secret (the relay holds its sha256)
 *   BROWSERBOX_NODE_ID                       a name for this node, unique per replica (default: the hostname)
 *   BROWSERBOX_MAX_CONTEXTS                  concurrent slots on this node (default 5; size it to the node's memory)
 *   BROWSERBOX_DRAIN_SECONDS                 how long a stopping node waits for its slots (default 120)
 *   BROWSERBOX_CHROMIUM_SANDBOX              'true' keeps Chromium's own sandbox on (needs user namespaces)
 *   BROWSERBOX_HEADLESS                      'false' for a headful browser (needs a display)
 *   BROWSERBOX_PROFILE_DIR                   Chromium's profile (default: a fresh temporary directory)
 *   BROWSERBOX_CHROMIUM_EXECUTABLE           a Chromium other than the one in the image
 *   BROWSERBOX_CHROMIUM_ENV_PASSTHROUGH      comma-separated names of environment variables the browser should also see
 *                                            (it gets only an allowlist otherwise; never BROWSERBOX_* ones)
 *
 * The process leaves when Chromium does, so give it a restart policy of "always".
 */
import { hostname } from 'node:os'
import { NODE_LIMITS } from '../protocol.js'
import { ConfigError, startBrowserNode } from './browser-node.mjs'

/** The settings of the browser itself, shared by `browserbox node` and the all-in-one `browserbox start`. */
export function parseNodeSettings(env = process.env) {
  const maxContexts = Number(env.BROWSERBOX_MAX_CONTEXTS || 5)
  if (!Number.isInteger(maxContexts) || maxContexts < 1 || maxContexts > NODE_LIMITS.maxContexts) {
    throw new Error(`BROWSERBOX_MAX_CONTEXTS must be a whole number from 1 to ${NODE_LIMITS.maxContexts}.`)
  }
  // The hostname is only a default: make it fit rather than refuse to start on a machine with an unusual one.
  const nodeId =
    env.BROWSERBOX_NODE_ID ||
    hostname()
      .replace(/[^\w.-]/g, '-')
      .slice(0, 100) ||
    'node'
  if (!NODE_LIMITS.nodeIdPattern.test(nodeId)) {
    throw new Error('BROWSERBOX_NODE_ID may only contain letters, digits, "_", "." and "-" (up to 100 characters).')
  }
  // Empty or blank means "not set", as it does for the other settings (platforms and Compose pass empty variables).
  const drainText = (env.BROWSERBOX_DRAIN_SECONDS ?? '').trim()
  const drainSeconds = drainText === '' ? 120 : Number(drainText)
  if (!Number.isFinite(drainSeconds) || drainSeconds < 0) {
    throw new Error('BROWSERBOX_DRAIN_SECONDS must be a number of seconds, 0 or more.')
  }
  return {
    nodeId,
    maxContexts,
    drainSeconds,
    profileDir: env.BROWSERBOX_PROFILE_DIR || undefined,
    headless: env.BROWSERBOX_HEADLESS !== 'false',
    sandbox: env.BROWSERBOX_CHROMIUM_SANDBOX === 'true'
  }
}

/** Reads a stand-alone node's settings from the environment. Throws an Error whose message says what to fix. */
export function parseNodeEnv(env = process.env) {
  const relayUrl = env.BROWSERBOX_RELAY_URL ?? ''
  const enrollmentSecret = env.BROWSERBOX_ENROLLMENT_SECRET ?? ''
  if (!relayUrl || enrollmentSecret.length < 16) {
    throw new Error('BROWSERBOX_RELAY_URL and BROWSERBOX_ENROLLMENT_SECRET (at least 16 characters) are required.')
  }
  return { relayUrl, enrollmentSecret, ...parseNodeSettings(env) }
}

export const consoleLogger = {
  info: (message, fields) => console.error(`node: ${message}`, fields ? JSON.stringify(fields) : ''),
  warn: (message, fields) => console.error(`node: WARN ${message}`, fields ? JSON.stringify(fields) : '')
}

/**
 * Leaves the process when the node ends (non-zero when Chromium died), drains on SIGTERM and stops on SIGINT.
 * Shared with `browserbox start`, which passes what else has to be closed first.
 */
export function superviseNode(node, { drainSeconds, beforeExit }) {
  let leaving = false
  const leave = async (code) => {
    if (leaving) return
    leaving = true
    await beforeExit?.()
    process.exit(code)
  }
  void node.exited.then(({ crashed }) => leave(crashed ? 1 : 0))
  process.on('SIGINT', () => void node.close('SIGINT'))
  process.on('SIGTERM', () => void node.drain(drainSeconds * 1000))
}

export async function runNode(env = process.env) {
  let config
  try {
    config = parseNodeEnv(env)
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  let node
  try {
    node = await startBrowserNode({ ...config, logger: consoleLogger })
  } catch (error) {
    console.error(`node: ${error.message}`)
    process.exit(error instanceof ConfigError ? 2 : 1)
  }
  superviseNode(node, { drainSeconds: config.drainSeconds })
}
