import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConfigError, startBrowserNode } from './browser-node.js'
import { parseNodeEnv, parseNodeSettings } from './main.js'

const SECRET = 'a-node-enrollment-secret'

test('node settings: the defaults, and each of the node’s own settings read from its variable', () => {
  const defaults = parseNodeSettings({})
  assert.equal(defaults.maxContexts, 5)
  assert.equal(defaults.drainSeconds, 120)
  assert.equal(defaults.display, 'headless', 'no display unless asked for')
  assert.equal(defaults.hideWebdriver, true)
  assert.equal(defaults.sandbox, false)
  assert.equal(defaults.profileDir, undefined, 'a fresh temporary profile unless one is named')
  assert.ok(defaults.nodeId, 'the hostname names a node that has no name')

  const set = parseNodeSettings({
    BROWSERBAY_NODE_ID: 'laptop',
    BROWSERBAY_MAX_CONTEXTS: '8',
    BROWSERBAY_DRAIN_SECONDS: '30',
    BROWSERBAY_PROFILE_DIR: '/data/profile',
    BROWSERBAY_HEADLESS: 'false',
    BROWSERBAY_CHROMIUM_SANDBOX: 'true',
    BROWSERBAY_ISOLATION: 'process'
  })
  assert.deepEqual(set, {
    nodeId: 'laptop',
    maxContexts: 8,
    drainSeconds: 30,
    profileDir: '/data/profile',
    display: 'host',
    hideWebdriver: true,
    labels: [],
    exclusive: false,
    sandbox: true,
    isolation: 'process'
  })
  assert.equal(defaults.isolation, 'context', 'a shared Chromium unless asked otherwise')
  assert.equal(parseNodeSettings({ BROWSERBAY_ISOLATION: '' }).isolation, 'context', 'empty is not set')
  for (const value of ['Process', 'vm', 'per-slot']) {
    assert.throws(() => parseNodeSettings({ BROWSERBAY_ISOLATION: value }), /BROWSERBAY_ISOLATION must be/, value)
  }
})

test('node settings: BROWSERBAY_HEADLESS picks the display, BROWSERBAY_WEBDRIVER_FLAG whether webdriver is hidden', () => {
  for (const [value, display] of [
    ['true', 'headless'],
    ['false', 'host'],
    ['xvfb', 'xvfb'],
    ['XVFB', 'xvfb'],
    ['', 'headless'],
    ['  ', 'headless']
  ] as const) {
    assert.equal(parseNodeSettings({ BROWSERBAY_HEADLESS: value }).display, display, JSON.stringify(value))
  }
  for (const value of ['yes', '1', 'xvfb-run', 'constructor', 'toString']) {
    assert.throws(() => parseNodeSettings({ BROWSERBAY_HEADLESS: value }), /BROWSERBAY_HEADLESS must be/, value)
  }
  assert.equal(parseNodeSettings({ BROWSERBAY_WEBDRIVER_FLAG: 'keep' }).hideWebdriver, false)
  assert.equal(parseNodeSettings({ BROWSERBAY_WEBDRIVER_FLAG: 'hide' }).hideWebdriver, true)
  assert.equal(parseNodeSettings({ BROWSERBAY_WEBDRIVER_FLAG: '' }).hideWebdriver, true, 'empty is not set')
  assert.throws(() => parseNodeSettings({ BROWSERBAY_WEBDRIVER_FLAG: 'off' }), /BROWSERBAY_WEBDRIVER_FLAG must be/)
})

test('node settings: labels name a node, and an exclusive node must have one', () => {
  assert.deepEqual(parseNodeSettings({}).labels, [])
  assert.equal(parseNodeSettings({}).exclusive, false)
  assert.deepEqual(parseNodeSettings({ BROWSERBAY_NODE_LABELS: 'residential, eu-west ,residential,' }).labels, [
    'residential',
    'eu-west'
  ])
  assert.deepEqual(parseNodeSettings({ BROWSERBAY_NODE_LABELS: '   ' }).labels, [], 'blank is not set')
  const exclusive = parseNodeSettings({ BROWSERBAY_NODE_LABELS: 'home', BROWSERBAY_NODE_EXCLUSIVE: 'true' })
  assert.equal(exclusive.exclusive, true)
  for (const notTrue of ['', 'false', 'TRUE', 'yes', '1']) {
    assert.equal(
      parseNodeSettings({ BROWSERBAY_NODE_LABELS: 'home', BROWSERBAY_NODE_EXCLUSIVE: notTrue }).exclusive,
      false,
      `only the exact word "true" turns it on, not ${JSON.stringify(notTrue)}`
    )
  }
  for (const value of ['a b', 'a/b', 'é', 'x'.repeat(64)]) {
    assert.throws(() => parseNodeSettings({ BROWSERBAY_NODE_LABELS: value }), /BROWSERBAY_NODE_LABELS/, value)
  }
  assert.throws(
    () => parseNodeSettings({ BROWSERBAY_NODE_LABELS: Array.from({ length: 17 }, (_, i) => `l${i}`).join(',') }),
    /at most 16 labels/
  )
  assert.throws(
    () => parseNodeSettings({ BROWSERBAY_NODE_EXCLUSIVE: 'true' }),
    /BROWSERBAY_NODE_EXCLUSIVE needs BROWSERBAY_NODE_LABELS/
  )
})

test('node settings: what the relay would refuse is refused here, at startup, with the setting named', () => {
  // The relay accepts 1 to 100 slots and a node id of letters, digits and _ . - : anything else is refused on connect.
  for (const value of ['0', '-1', '2.5', 'many', '101', '150']) {
    assert.throws(
      () => parseNodeSettings({ BROWSERBAY_MAX_CONTEXTS: value }),
      /BROWSERBAY_MAX_CONTEXTS.*1 to 100/,
      value
    )
  }
  assert.equal(parseNodeSettings({ BROWSERBAY_MAX_CONTEXTS: '100' }).maxContexts, 100)

  for (const value of ['my laptop', 'a/b', 'node:1', 'é', 'x'.repeat(101)]) {
    assert.throws(() => parseNodeSettings({ BROWSERBAY_NODE_ID: value }), /BROWSERBAY_NODE_ID/, value)
  }
  assert.equal(parseNodeSettings({ BROWSERBAY_NODE_ID: 'eu-west_1.node' }).nodeId, 'eu-west_1.node')
  assert.ok(/^[\w.-]{1,100}$/.test(parseNodeSettings({}).nodeId), 'the default, from the hostname, always fits')

  for (const value of ['abc', '-5', 'Infinity', '1e999']) {
    assert.throws(() => parseNodeSettings({ BROWSERBAY_DRAIN_SECONDS: value }), /BROWSERBAY_DRAIN_SECONDS/, value)
  }
  assert.equal(parseNodeSettings({ BROWSERBAY_DRAIN_SECONDS: '0' }).drainSeconds, 0, 'zero is "do not wait"')
  // Empty or blank is "not set", like an empty BROWSERBAY_MAX_CONTEXTS: platforms and Compose pass empty variables.
  for (const value of ['', '   ']) {
    assert.equal(parseNodeSettings({ BROWSERBAY_DRAIN_SECONDS: value }).drainSeconds, 120, JSON.stringify(value))
  }
  assert.equal(parseNodeSettings({ BROWSERBAY_MAX_CONTEXTS: '' }).maxContexts, 5)
})

test('a stand-alone node needs the relay address and a long enough enrollment secret', () => {
  const ok = parseNodeEnv({ BROWSERBAY_RELAY_URL: 'https://relay.example.com', BROWSERBAY_ENROLLMENT_SECRET: SECRET })
  assert.equal(ok.relayUrl, 'https://relay.example.com')
  assert.equal(ok.enrollmentSecret, SECRET)
  assert.equal(ok.maxContexts, 5)
  assert.equal(ok.allowInsecureRelay, false, 'plain http to another machine is off unless asked for')

  const base = { BROWSERBAY_RELAY_URL: 'http://relay.ns.svc:8788', BROWSERBAY_ENROLLMENT_SECRET: SECRET }
  assert.equal(parseNodeEnv({ ...base, BROWSERBAY_ALLOW_INSECURE_RELAY: 'true' }).allowInsecureRelay, true)
  for (const notTrue of ['', 'false', 'TRUE', 'yes', '1']) {
    assert.equal(
      parseNodeEnv({ ...base, BROWSERBAY_ALLOW_INSECURE_RELAY: notTrue }).allowInsecureRelay,
      false,
      `only the exact word "true" turns it on, not ${JSON.stringify(notTrue)}`
    )
  }

  assert.throws(() => parseNodeEnv({}), /BROWSERBAY_RELAY_URL and BROWSERBAY_ENROLLMENT_SECRET/)
  assert.throws(() => parseNodeEnv({ BROWSERBAY_RELAY_URL: 'https://relay.example.com' }), /ENROLLMENT_SECRET/)
  assert.throws(
    () => parseNodeEnv({ BROWSERBAY_RELAY_URL: 'https://relay.example.com', BROWSERBAY_ENROLLMENT_SECRET: 'short' }),
    /at least 16 characters/
  )
})

test('process isolation checks a Chromium path exists, but leaves a bare command name to PATH as context mode does', async () => {
  const missing = join(tmpdir(), 'browserbay-no-such-chrome')
  await assert.rejects(
    startBrowserNode({
      relayUrl: 'https://relay.example.com',
      enrollmentSecret: SECRET,
      nodeId: 'n',
      isolation: 'process',
      executable: missing
    }),
    (error) => error instanceof ConfigError && /Chromium was not found at/.test(error.message)
  )
  // `chromium` or `google-chrome` is found by spawn through PATH, so it is not refused up front.
  const node = await startBrowserNode({
    relayUrl: 'https://relay.example.com',
    enrollmentSecret: SECRET,
    nodeId: 'n',
    isolation: 'process',
    executable: 'chromium-found-through-path'
  })
  await node.close()
})

test('starting a node refuses, before anything is launched, what the operator has to fix', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'browserbay-no-chromium-'))
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
    delete process.env.BROWSERBAY_CHROMIUM_EXECUTABLE
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

test('a node on xvfb refuses to start when Xvfb cannot run, in either isolation mode, and leaves nothing behind', async () => {
  // A temporary directory of its own, so what is left in it can only be this node's (other test files run alongside).
  const scratch = await mkdtemp(join(tmpdir(), 'browserbay-scratch-'))
  const saved = process.env.TMPDIR
  process.env.TMPDIR = scratch
  try {
    for (const isolation of ['context', 'process'] as const) {
      await assert.rejects(
        startBrowserNode({
          relayUrl: 'https://relay.example.com',
          enrollmentSecret: SECRET,
          nodeId: 'n',
          isolation,
          display: 'xvfb',
          executable: process.execPath,
          xvfb: { executable: join(scratch, 'no-such-xvfb') }
        }),
        (error) => error instanceof ConfigError && /Xvfb was not found/.test(error.message),
        isolation
      )
    }
    assert.deepEqual(await readdir(scratch), [], 'neither a profile nor a display directory is left behind')
  } finally {
    if (saved === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = saved
    await rm(scratch, { recursive: true, force: true })
  }
})
