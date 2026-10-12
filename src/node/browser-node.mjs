/**
 * One browser node: a Chromium whose DevTools is a pair of pipes (so there is no DevTools port), the scope hub in front
 * of it, and the agent that dials the relay. Everything here is outbound.
 *
 * `startBrowserNode` does no process-level work (no signal handlers, no `process.exit`), so the node can run as its own
 * process (main.mjs) or inside the all-in-one `browserbox start` (box/start.mjs).
 *
 * The node is over when Chromium is: every context died with it, so `exited` resolves and the caller is expected to
 * leave, and the platform's restart policy brings back a node that registers again with no contexts. The relay then
 * drops the slots that were on it, and clients get a fresh browser for their next attempt.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError } from '../protocol.js'
import { assertSecureRelayUrl, startAgent } from './agent.mjs'
import { chromiumArgs, chromiumEnv, findChromium } from './chromium.mjs'
import { createPipeUpstream } from './pipe-upstream.mjs'
import { createCdpScope } from './scope.mjs'

export { ConfigError }

const CHROMIUM_START_TIMEOUT_MS = 30_000
const CHROMIUM_STOP_GRACE_MS = 3000
const CONNECT_REPORT_MS = 15_000

/**
 * @param {object} options
 * @param {string} options.relayUrl
 * @param {string} options.enrollmentSecret
 * @param {string} options.nodeId
 * @param {number} [options.maxContexts]
 * @param {string} [options.profileDir] Chromium's profile. A fresh temporary directory (removed on exit) when omitted.
 * @param {boolean} [options.headless]
 * @param {boolean} [options.sandbox] Keep Chromium's own sandbox on (needs user namespaces).
 * @param {string} [options.executable] Defaults to the Chromium in the image (or BROWSERBOX_CHROMIUM_EXECUTABLE).
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @returns {Promise<{ exited: Promise<{ reason: string, crashed: boolean }>, drain(ms?: number): Promise<void>, close(reason?: string): Promise<void> }>}
 */
export async function startBrowserNode(options) {
  const { relayUrl, enrollmentSecret, nodeId, maxContexts = 5, headless = true, sandbox = false, logger = {} } = options
  const executable = options.executable ?? findChromium()
  if (!executable) {
    throw new ConfigError('Chromium was not found. Use the browserbox image, or set BROWSERBOX_CHROMIUM_EXECUTABLE.')
  }
  try {
    assertSecureRelayUrl(relayUrl)
  } catch (error) {
    throw new ConfigError(`The relay URL is not usable: ${error.message}`)
  }

  const ownsProfile = !options.profileDir
  const profileDir = options.profileDir ?? (await mkdtemp(join(tmpdir(), 'browserbox-profile-')))

  // DevTools over a pipe (fds 3 and 4): no port, and no size limit on what a screenshot or an evaluate result may be.
  const chromium = spawn(executable, chromiumArgs({ profileDir, headless, sandbox }), {
    stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'],
    // Not the node's own environment: it holds this box's secrets, and pages the browser runs are not trusted with them.
    env: chromiumEnv()
  })

  let agent
  let stopping = false
  let finish
  const exited = new Promise((resolve) => {
    finish = resolve
  })

  function stop(reason, crashed) {
    if (stopping) return exited
    stopping = true
    logger.info?.(`node stopping: ${reason}`)
    void agent?.close()
    const done = async () => {
      if (ownsProfile) await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
      finish({ reason, crashed })
    }
    if (chromium.exitCode !== null || chromium.signalCode !== null) {
      void done()
    } else {
      chromium.once('exit', () => void done())
      chromium.kill('SIGTERM')
      setTimeout(() => chromium.kill('SIGKILL'), CHROMIUM_STOP_GRACE_MS).unref()
    }
    return exited
  }

  chromium.on('exit', (code, signal) => void stop(`Chromium exited (${signal ?? code})`, true))
  chromium.on('error', (error) => void stop(`Chromium could not start: ${error.message}`, true))

  try {
    const pipe = createPipeUpstream({
      input: chromium.stdio[4],
      output: chromium.stdio[3],
      onMessage: (text) => scope.onUpstreamMessage(text),
      onClose: () => {
        scope.onUpstreamClosed()
        void stop('The DevTools pipe closed', true)
      }
    })
    const scope = createCdpScope({ upstream: { send: (text) => pipe.send(text) }, logger })
    await Promise.race([
      scope.start(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Chromium did not answer on its DevTools pipe')),
          CHROMIUM_START_TIMEOUT_MS
        ).unref()
      )
    ])
    agent = startAgent({ relayUrl, enrollmentSecret, nodeId, scope, maxContexts, logger })
  } catch (error) {
    await stop(error.message, true)
    throw error
  }

  // Not "ready" until the relay has accepted this node: a node that cannot join gives every client "no capacity".
  agent
    .whenConnected(CONNECT_REPORT_MS)
    .then(() => logger.info?.(`node ${nodeId} ready: up to ${maxContexts} slots, relay ${new URL(relayUrl).origin}`))
    .catch(() => {
      // Closed before it ever joined is not worth a warning: the node was told to stop.
      if (stopping) return
      logger.warn?.(
        `node ${nodeId} is running but not yet accepted by the relay at ${new URL(relayUrl).origin}: still trying (check the relay address and the enrollment secret)`
      )
    })

  return {
    exited,
    /** Stops taking slots, gives the current ones up to `ms` to finish, then stops. */
    async drain(ms = 120_000) {
      logger.info?.(`node draining for up to ${Math.round(ms / 1000)}s`)
      await agent?.drain(ms)
      await stop('drained', false)
    },
    close: (reason = 'closed') => stop(reason, false).then(() => undefined)
  }
}
