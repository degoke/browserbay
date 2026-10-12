import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConfigError, startBrowserNode } from './browser-node.mjs'
import { parseNodeEnv, parseNodeSettings } from './main.mjs'

const SECRET = 'a-node-enrollment-secret'

test('node settings: defaults, and every BROWSERBOX_ variable it reads', () => {
  const defaults = parseNodeSettings({})
  assert.equal(defaults.maxContexts, 5)
  assert.equal(defaults.drainSeconds, 120)
  assert.equal(defaults.headless, true)
  assert.equal(defaults.sandbox, false)
  assert.equal(defaults.profileDir, undefined, 'a fresh temporary profile unless one is named')
  assert.ok(defaults.nodeId, 'the hostname names a node that has no name')

  const set = parseNodeSettings({
    BROWSERBOX_NODE_ID: 'laptop',
    BROWSERBOX_MAX_CONTEXTS: '8',
    BROWSERBOX_DRAIN_SECONDS: '30',
    BROWSERBOX_PROFILE_DIR: '/data/profile',
    BROWSERBOX_HEADLESS: 'false',
    BROWSERBOX_CHROMIUM_SANDBOX: 'true'
  })
  assert.deepEqual(set, {
    nodeId: 'laptop',
    maxContexts: 8,
    drainSeconds: 30,
    profileDir: '/data/profile',
    headless: false,
    sandbox: true
  })
})

test('node settings: a slot count that is not a whole number of at least one is refused', () => {
  for (const value of ['0', '-1', '2.5', 'many']) {
    assert.throws(() => parseNodeSettings({ BROWSERBOX_MAX_CONTEXTS: value }), /BROWSERBOX_MAX_CONTEXTS/, value)
  }
})

test('a stand-alone node needs the relay address and a long enough enrollment secret', () => {
  const ok = parseNodeEnv({ BROWSERBOX_RELAY_URL: 'https://relay.example.com', BROWSERBOX_ENROLLMENT_SECRET: SECRET })
  assert.equal(ok.relayUrl, 'https://relay.example.com')
  assert.equal(ok.enrollmentSecret, SECRET)
  assert.equal(ok.maxContexts, 5)

  assert.throws(() => parseNodeEnv({}), /BROWSERBOX_RELAY_URL and BROWSERBOX_ENROLLMENT_SECRET/)
  assert.throws(() => parseNodeEnv({ BROWSERBOX_RELAY_URL: 'https://relay.example.com' }), /ENROLLMENT_SECRET/)
  assert.throws(
    () => parseNodeEnv({ BROWSERBOX_RELAY_URL: 'https://relay.example.com', BROWSERBOX_ENROLLMENT_SECRET: 'short' }),
    /at least 16 characters/
  )
})

test('starting a node refuses, before anything is launched, what the operator has to fix', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'browserbox-no-chromium-'))
  try {
    // The enrollment secret would travel in the clear to a relay that is not on this machine.
    await assert.rejects(
      startBrowserNode({
        relayUrl: 'http://relay.example.com',
        enrollmentSecret: SECRET,
        nodeId: 'n',
        executable: process.execPath
      }),
      (error) => error instanceof ConfigError && /must use https/.test(error.message)
    )
    await assert.rejects(
      startBrowserNode({ relayUrl: 'not a url', enrollmentSecret: SECRET, nodeId: 'n', executable: process.execPath }),
      (error) => error instanceof ConfigError
    )

    // No Chromium in the place the image keeps it, and none named.
    const saved = { ...process.env }
    process.env.PLAYWRIGHT_BROWSERS_PATH = empty
    delete process.env.BROWSERBOX_CHROMIUM_EXECUTABLE
    try {
      await assert.rejects(
        startBrowserNode({ relayUrl: 'https://relay.example.com', enrollmentSecret: SECRET, nodeId: 'n' }),
        (error) => error instanceof ConfigError && /Chromium was not found/.test(error.message)
      )
    } finally {
      process.env = saved
    }
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})
