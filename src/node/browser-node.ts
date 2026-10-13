/**
 * One browser node: a Chromium whose DevTools is a pair of pipes (so there is no DevTools port), the scope hub in front
 * of it, and the agent that dials the relay. Everything here is outbound.
 *
 * With `isolation: 'process'` there is no shared Chromium: each slot gets a Chromium of its own, started with the slot and
 * ended with it (process-host.ts), and the node is only over when it is told to stop.
 *
 * `startBrowserNode` does no process-level work (no signal handlers, no `process.exit`), so the node can run as its own
 * process (main.ts) or inside the all-in-one `browserbay start` (box/start.ts).
 *
 * The node is over when Chromium is: every context died with it, so `exited` resolves and the caller is expected to
 * leave, and the platform's restart policy brings back a node that registers again with no contexts. The relay then
 * drops the slots that were on it, and clients get a fresh browser for their next attempt.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { errorMessage } from '../errors.js'
import { ConfigError } from '../protocol.js'
import { assertSecureRelayUrl, startAgent, type Agent, type AgentLogger } from './agent.js'
import { chromiumArgs, chromiumEnv, findChromium } from './chromium.js'
import { createPipeUpstream } from './pipe-upstream.js'
import { createProcessHost, removeStaleProfiles, type ProcessHost } from './process-host.js'
import { createCdpScope } from './scope.js'

export { ConfigError }

/** `context`: one shared Chromium, a BrowserContext per slot. `process`: a Chromium per slot. */
export type Isolation = 'context' | 'process'

const CHROMIUM_START_TIMEOUT_MS = 30_000
const CHROMIUM_STOP_GRACE_MS = 3000
const CONNECT_REPORT_MS = 15_000

export interface BrowserNodeOptions {
  relayUrl: string
  enrollmentSecret: string
  nodeId: string
  maxContexts?: number
  /**
   * Chromium's profile. A fresh temporary directory (removed on exit) when omitted. With process isolation it is the
   * directory each slot's profile is made in (as `<dir>/<slot id>`, removed with the slot).
   */
  profileDir?: string
  isolation?: Isolation
  headless?: boolean
  /** Keep Chromium's own sandbox on (needs user namespaces). */
  sandbox?: boolean
  /** Defaults to the Chromium in the image (or BROWSERBAY_CHROMIUM_EXECUTABLE). */
  executable?: string
  logger?: AgentLogger
}

export interface NodeExit {
  reason: string
  /** Chromium died (or could not start), as opposed to the node being told to stop. */
  crashed: boolean
}

export interface BrowserNode {
  /** Resolves when the node is over: every context died with Chromium, so the caller is expected to leave. */
  exited: Promise<NodeExit>
  /** Stops taking slots, gives the current ones up to `ms` to finish, then stops. */
  drain(ms?: number): Promise<void>
  close(reason?: string): Promise<void>
}

export async function startBrowserNode(options: BrowserNodeOptions): Promise<BrowserNode> {
  const {
    relayUrl,
    enrollmentSecret,
    nodeId,
    maxContexts = 5,
    headless = true,
    sandbox = false,
    isolation = 'context',
    logger = {}
  } = options
  const executable = options.executable ?? findChromium()
  if (!executable) {
    throw new ConfigError('Chromium was not found. Use the browserbay image, or set BROWSERBAY_CHROMIUM_EXECUTABLE.')
  }
  try {
    assertSecureRelayUrl(relayUrl)
  } catch (error) {
    throw new ConfigError(`The relay URL is not usable: ${errorMessage(error)}`)
  }

  // Process isolation has no browser until a slot asks for one, so a Chromium that cannot start would otherwise only show
  // up as every client being told there is no capacity.
  // Only a path can be checked: a bare name (`chromium`) is found through PATH by spawn, as it is in context mode.
  if (isolation === 'process' && /[\\/]/.test(executable) && !existsSync(executable)) {
    throw new ConfigError(`Chromium was not found at ${executable}.`)
  }

  const ownsProfile = isolation === 'context' && !options.profileDir
  const profileDir =
    isolation === 'context' ? (options.profileDir ?? (await mkdtemp(join(tmpdir(), 'browserbay-profile-')))) : ''
  if (isolation === 'process' && options.profileDir) await removeStaleProfiles(options.profileDir)
  const processHost: ProcessHost | undefined =
    isolation === 'process'
      ? createProcessHost({ executable, headless, sandbox, profileRoot: options.profileDir, logger })
      : undefined

  // DevTools over a pipe (fds 3 and 4): no port, and no size limit on what a screenshot or an evaluate result may be.
  const chromium = processHost
    ? undefined
    : spawn(executable, chromiumArgs({ profileDir, headless, sandbox }), {
        stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'],
        // Not the node's own environment: it holds this box's secrets, and pages the browser runs are not trusted with them.
        env: chromiumEnv()
      })

  let agent: Agent | undefined
  let stopping = false
  let finish: (exit: NodeExit) => void = () => undefined
  const exited = new Promise<NodeExit>((resolve) => {
    finish = resolve
  })

  function stop(reason: string, crashed: boolean) {
    if (stopping) return exited
    stopping = true
    logger.info?.(`node stopping: ${reason}`)
    void agent?.close()
    const done = async () => {
      if (ownsProfile) await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
      finish({ reason, crashed })
    }
    if (processHost) {
      void processHost.close().then(done)
    } else if (!chromium || chromium.exitCode !== null || chromium.signalCode !== null) {
      void done()
    } else {
      chromium.once('exit', () => void done())
      chromium.kill('SIGTERM')
      setTimeout(() => chromium.kill('SIGKILL'), CHROMIUM_STOP_GRACE_MS).unref()
    }
    return exited
  }

  chromium?.on('exit', (code, signal) => void stop(`Chromium exited (${signal ?? code})`, true))
  chromium?.on('error', (error) => void stop(`Chromium could not start: ${error.message}`, true))

  try {
    if (processHost) {
      agent = startAgent({ relayUrl, enrollmentSecret, nodeId, scope: processHost, maxContexts, logger })
    } else {
      const pipe = createPipeUpstream({
        input: chromium!.stdio[4] as Readable,
        output: chromium!.stdio[3] as Writable,
        onMessage: (text) => scope.onUpstreamMessage(text),
        onClose: () => {
          scope.onUpstreamClosed()
          void stop('The DevTools pipe closed', true)
        }
      })
      const scope = createCdpScope({ upstream: { send: (text) => pipe.send(text) }, logger })
      await Promise.race([
        scope.start(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Chromium did not answer on its DevTools pipe')),
            CHROMIUM_START_TIMEOUT_MS
          ).unref()
        )
      ])
      agent = startAgent({ relayUrl, enrollmentSecret, nodeId, scope, maxContexts, logger })
    }
  } catch (error) {
    await stop(errorMessage(error), true)
    throw error
  }

  // Not "ready" until the relay has accepted this node: a node that cannot join gives every client "no capacity".
  agent
    .whenConnected(CONNECT_REPORT_MS)
    .then(() =>
      logger.info?.(
        `node ${nodeId} ready: up to ${maxContexts} slots${isolation === 'process' ? ' (a Chromium each)' : ''}, relay ${new URL(relayUrl).origin}`
      )
    )
    .catch(() => {
      // Closed before it ever joined is not worth a warning: the node was told to stop.
      if (stopping) return
      logger.warn?.(
        `node ${nodeId} is running but not yet accepted by the relay at ${new URL(relayUrl).origin}: still trying (check the relay address and the enrollment secret)`
      )
    })

  return {
    exited,
    async drain(ms = 120_000) {
      logger.info?.(`node draining for up to ${Math.round(ms / 1000)}s`)
      await agent?.drain(ms)
      await stop('drained', false)
    },
    close: (reason = 'closed') => stop(reason, false).then(() => undefined)
  }
}
