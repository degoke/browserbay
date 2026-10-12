import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConfigError, startBrowserNode } from './browser-node.mjs'
import { parseNodeEnv, parseNodeSettings } from './main.mjs'

const SECRET = 'a-node-enrollment-secret'

test('node settings: the defaults, and each of the node’s own settings read from its variable', () => {
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

test('node settings: what the relay would refuse is refused here, at startup, with the setting named', () => {
  // The relay accepts 1 to 100 slots and a node id of letters, digits and _ . - : anything else is refused on connect.
  for (const value of ['0', '-1', '2.5', 'many', '101', '150']) {
    assert.throws(
      () => parseNodeSettings({ BROWSERBOX_MAX_CONTEXTS: value }),
      /BROWSERBOX_MAX_CONTEXTS.*1 to 100/,
      value
    )
  }
  assert.equal(parseNodeSettings({ BROWSERBOX_MAX_CONTEXTS: '100' }).maxContexts, 100)

  for (const value of ['my laptop', 'a/b', 'node:1', 'é', 'x'.repeat(101)]) {
    assert.throws(() => parseNodeSettings({ BROWSERBOX_NODE_ID: value }), /BROWSERBOX_NODE_ID/, value)
  }
  assert.equal(parseNodeSettings({ BROWSERBOX_NODE_ID: 'eu-west_1.node' }).nodeId, 'eu-west_1.node')
  assert.ok(/^[\w.-]{1,100}$/.test(parseNodeSettings({}).nodeId), 'the default, from the hostname, always fits')

  for (const value of ['abc', '-5', 'Infinity', '1e999']) {
    assert.throws(() => parseNodeSettings({ BROWSERBOX_DRAIN_SECONDS: value }), /BROWSERBOX_DRAIN_SECONDS/, value)
  }
  assert.equal(parseNodeSettings({ BROWSERBOX_DRAIN_SECONDS: '0' }).drainSeconds, 0, 'zero is "do not wait"')
  // Empty or blank is "not set", like an empty BROWSERBOX_MAX_CONTEXTS: platforms and Compose pass empty variables.
  for (const value of ['', '   ']) {
    assert.equal(parseNodeSettings({ BROWSERBOX_DRAIN_SECONDS: value }).drainSeconds, 120, JSON.stringify(value))
  }
  assert.equal(parseNodeSettings({ BROWSERBOX_MAX_CONTEXTS: '' }).maxContexts, 5)
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
