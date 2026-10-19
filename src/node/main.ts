/**
 * Runs a node as a process: `browserbay node`. One shared Chromium, one BrowserContext per slot, reached only through
 * the relay. Configuration (all environment variables):
 *
 *   BROWSERBAY_RELAY_URL           required  the relay's base URL, e.g. https://relay.example.com
 *   BROWSERBAY_ENROLLMENT_SECRET   required  this node's enrollment secret (the relay holds its sha256)
 *   BROWSERBAY_ALLOW_INSECURE_RELAY          'true' lets the relay address be plain http:// or ws:// when it is on a private
 *                                            network (a private IP range, a single-label name, .svc/.internal/.local). The
 *                                            enrollment secret then crosses that network without TLS: only for one you
 *                                            trust, such as a Kubernetes cluster's own network. A public address is still
 *                                            refused (default: off)
 *   BROWSERBAY_NODE_ID                       a name for this node, unique per replica (default: the hostname)
 *   BROWSERBAY_MAX_CONTEXTS                  concurrent slots on this node (default 5; size it to the node's memory)
 *   BROWSERBAY_DRAIN_SECONDS                 how long a stopping node waits for its slots (default 120)
 *   BROWSERBAY_ISOLATION                     'context' (default): one shared Chromium, a BrowserContext per slot;
 *                                            'process': a Chromium per slot (more memory, stronger isolation, and a
 *                                            slot's client gets page.pdf(), tracing and browser.newContext())
 *   BROWSERBAY_CHROMIUM_SANDBOX              'true' keeps Chromium's own sandbox on (needs user namespaces)
 *   BROWSERBAY_HEADLESS                      'true' (default): no display, `--headless=new`. 'xvfb': a headful browser on
 *                                            a virtual display the node starts (the image's default; needs Xvfb, and
 *                                            drops the HeadlessChrome user agent). 'false': a headful browser on the
 *                                            display the environment names (DISPLAY)
 *   BROWSERBAY_NODE_LABELS                   comma-separated names for this node (`residential,eu`): a slot can ask for them with
 *                                            `nodeLabels`, and only a node that has them all gets it
 *   BROWSERBAY_NODE_EXCLUSIVE                'true': only slots that ask for one of this node's labels are placed on it, so
 *                                            ordinary slots do not fill (say) a machine on a home connection
 *   BROWSERBAY_WEB_BOT_AUTH                  'off' (default), 'optional' (sign the slots that ask with `signRequests: true`) or
 *                                            'always' (sign every slot's requests, as Web Bot Auth). Needs the next two
 *   BROWSERBAY_WEB_BOT_AUTH_KEY              the private Ed25519 key, as a JWK in JSON (`browserbay web-bot-auth`)
 *   BROWSERBAY_WEB_BOT_AUTH_AGENT            where this box says it is: the https address the relay is served at
 *   BROWSERBAY_WEB_BOT_AUTH_FORMAT           'legacy' (default: the spelling Cloudflare verifies) or 'dictionary' (the IETF draft's)
 *   BROWSERBAY_WEB_BOT_AUTH_TTL_SECONDS      how long a signature is good for (default 60)
 *   BROWSERBAY_WEBDRIVER_FLAG                'hide' (default) turns navigator.webdriver off, which driving a browser over
 *                                            DevTools would otherwise turn on; 'keep' leaves it on
 *   BROWSERBAY_PROFILE_DIR                   Chromium's profile (default: a fresh temporary directory); with
 *                                            BROWSERBAY_ISOLATION=process, where each slot's profile is made
 *   BROWSERBAY_CHROMIUM_EXECUTABLE           a Chromium other than the one in the image
 *   BROWSERBAY_CHROMIUM_ENV_PASSTHROUGH      comma-separated names of environment variables the browser should also see
 *                                            (it gets only an allowlist otherwise; never BROWSERBAY_* ones)
 *
 * The process leaves when Chromium does, so give it a restart policy of "always".
 */
import { hostname } from 'node:os'
import { errorMessage } from '../errors.js'
import { LABEL_LIMITS, NAME_PATTERN, NODE_LIMITS } from '../protocol.js'
import type { AgentLogger } from './agent.js'
import { ConfigError, startBrowserNode, type BrowserNode, type Isolation } from './browser-node.js'
import type { Display } from './chromium.js'
import { parseAgent, parseSigningKey } from '../web-bot-auth.js'
import type { WebBotAuthSettings } from './signing.js'

export interface NodeSettings {
  nodeId: string
  maxContexts: number
  drainSeconds: number
  profileDir: string | undefined
  display: Display
  hideWebdriver: boolean
  labels: string[]
  exclusive: boolean
  /** Left out when the node does not sign. */
  webBotAuth?: WebBotAuthSettings
  sandbox: boolean
  isolation: Isolation
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
  const isolation = (env.BROWSERBAY_ISOLATION ?? '').trim() || 'context'
  if (isolation !== 'context' && isolation !== 'process') {
    throw new Error('BROWSERBAY_ISOLATION must be "context" or "process".')
  }
  const displayText = (env.BROWSERBAY_HEADLESS ?? '').trim().toLowerCase() || 'true'
  if (displayText !== 'true' && displayText !== 'false' && displayText !== 'xvfb') {
    throw new Error('BROWSERBAY_HEADLESS must be "true", "false" or "xvfb".')
  }
  const display: Display = displayText === 'true' ? 'headless' : displayText === 'false' ? 'host' : 'xvfb'
  const webdriver = (env.BROWSERBAY_WEBDRIVER_FLAG ?? '').trim().toLowerCase() || 'hide'
  if (webdriver !== 'hide' && webdriver !== 'keep')
    throw new Error('BROWSERBAY_WEBDRIVER_FLAG must be "hide" or "keep".')
  // Empty or blank is "not set", as everywhere else; the relay would drop a label it cannot use, so refuse it here.
  const labels = (env.BROWSERBAY_NODE_LABELS ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
  if (labels.length > LABEL_LIMITS.maxPerNode) {
    throw new Error(`BROWSERBAY_NODE_LABELS may name at most ${LABEL_LIMITS.maxPerNode} labels.`)
  }
  for (const label of labels) {
    if (label.length > LABEL_LIMITS.maxLength || !NAME_PATTERN.test(label)) {
      throw new Error(
        `BROWSERBAY_NODE_LABELS: a label may only contain letters, digits, "_", "." and "-" (up to ${LABEL_LIMITS.maxLength} characters).`
      )
    }
  }
  const signingMode = (env.BROWSERBAY_WEB_BOT_AUTH ?? '').trim().toLowerCase() || 'off'
  if (signingMode !== 'off' && signingMode !== 'optional' && signingMode !== 'always') {
    throw new Error('BROWSERBAY_WEB_BOT_AUTH must be "off", "optional" or "always".')
  }
  let webBotAuth: WebBotAuthSettings | undefined
  if (signingMode !== 'off') {
    const key = (env.BROWSERBAY_WEB_BOT_AUTH_KEY ?? '').trim()
    if (!key)
      throw new Error(
        `BROWSERBAY_WEB_BOT_AUTH=${signingMode} needs BROWSERBAY_WEB_BOT_AUTH_KEY (make one with \`browserbay web-bot-auth\`).`
      )
    parseSigningKey(key)
    const agentText = (env.BROWSERBAY_WEB_BOT_AUTH_AGENT ?? '').trim()
    if (!agentText)
      throw new Error(
        `BROWSERBAY_WEB_BOT_AUTH=${signingMode} needs BROWSERBAY_WEB_BOT_AUTH_AGENT: the https address your relay is served at.`
      )
    const agent = parseAgent(agentText)
    const format = (env.BROWSERBAY_WEB_BOT_AUTH_FORMAT ?? '').trim().toLowerCase() || 'legacy'
    if (format !== 'legacy' && format !== 'dictionary')
      throw new Error('BROWSERBAY_WEB_BOT_AUTH_FORMAT must be "legacy" or "dictionary".')
    const ttlText = (env.BROWSERBAY_WEB_BOT_AUTH_TTL_SECONDS ?? '').trim()
    const ttlSeconds = ttlText === '' ? 60 : Number(ttlText)
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 86_400) {
      throw new Error('BROWSERBAY_WEB_BOT_AUTH_TTL_SECONDS must be a whole number of seconds from 10 to 86400.')
    }
    webBotAuth = { mode: signingMode, key, agent, format, ttlSeconds }
  }
  const exclusive = env.BROWSERBAY_NODE_EXCLUSIVE === 'true'
  if (exclusive && labels.length === 0) {
    throw new Error(
      'BROWSERBAY_NODE_EXCLUSIVE needs BROWSERBAY_NODE_LABELS: a node with no label could never be asked for.'
    )
  }
  return {
    nodeId,
    maxContexts,
    drainSeconds,
    isolation,
    profileDir: env.BROWSERBAY_PROFILE_DIR || undefined,
    display,
    hideWebdriver: webdriver === 'hide',
    labels: [...new Set(labels)],
    exclusive,
    ...(webBotAuth ? { webBotAuth } : {}),
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
  return {
    relayUrl,
    allowInsecureRelay: env.BROWSERBAY_ALLOW_INSECURE_RELAY === 'true',
    enrollmentSecret,
    ...parseNodeSettings(env)
  }
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
