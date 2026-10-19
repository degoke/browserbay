import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { generateSigningKey, createRequestSigner } from '../web-bot-auth.js'
import { createFakeChromium } from './fake-chromium.js'
import { createProcessHost, removeStaleProfiles, type ProcessHostOptions } from './process-host.js'

/**
 * A "Chromium" for the host to start: a child process that is a fake browser on the other end of the two pipes. `die`
 * ends it the way a crash does; `silent` never answers on its pipe.
 */
function fakeLauncher({ silent = false, dieOnStart = false } = {}) {
  const started: Array<{
    args: string[]
    env: Record<string, string | undefined>
    fake: ReturnType<typeof createFakeChromium>
    signals: string[]
    die(signal?: NodeJS.Signals): void
    profileDir: string
  }> = []
  const spawnChromium = ((_exe: string, args: string[], options: { env: Record<string, string | undefined> }) => {
    const fake = createFakeChromium()
    const toBrowser = new PassThrough()
    const fromBrowser = new PassThrough()
    let pending = ''
    toBrowser.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      for (let end = pending.indexOf('\0'); end !== -1; end = pending.indexOf('\0')) {
        const text = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (!silent) fake.receive(text)
      }
    })
    fake.onMessage((text) => fromBrowser.write(`${text}\0`))
    const child: any = new EventEmitter()
    child.stdio = [null, null, null, toBrowser, fromBrowser]
    child.exitCode = null
    child.signalCode = null
    const signals: string[] = []
    const die = (signal: NodeJS.Signals | null = 'SIGKILL') => {
      if (child.signalCode || child.exitCode !== null) return
      child.signalCode = signal
      fromBrowser.end()
      child.emit('exit', null, signal)
    }
    child.kill = (signal: string) => {
      signals.push(signal)
      queueMicrotask(() => die(signal as NodeJS.Signals))
      return true
    }
    const profileDir = args.find((arg) => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length)
    started.push({ args, env: options.env, fake, signals, die, profileDir })
    if (dieOnStart) setImmediate(() => die('SIGABRT'))
    return child
  }) as unknown as NonNullable<ProcessHostOptions['spawnChromium']>
  return { spawnChromium, started }
}

const host = (launcher: ReturnType<typeof fakeLauncher>, options: Partial<ProcessHostOptions> = {}) =>
  createProcessHost({ executable: '/chromium', spawnChromium: launcher.spawnChromium, stopGraceMs: 50, ...options })

/** An "Xvfb" for the host to start: it reports a display number on fd 3, as the real one does, and can be made to die. */
function fakeXvfb({ failToStart = false } = {}) {
  const started: Array<{ args: string[]; display: string; signals: string[]; die(signal?: NodeJS.Signals): void }> = []
  let next = 10
  const spawnXvfb = ((_exe: string, args: string[]) => {
    const child: any = new EventEmitter()
    const report = new PassThrough()
    child.stdio = [null, null, new PassThrough(), report]
    child.stderr = child.stdio[2]
    child.exitCode = null
    child.signalCode = null
    const signals: string[] = []
    const die = (signal: NodeJS.Signals | null = 'SIGKILL') => {
      if (child.signalCode || child.exitCode !== null) return
      child.signalCode = signal
      child.emit('exit', null, signal)
    }
    child.kill = (signal: string) => {
      signals.push(signal)
      queueMicrotask(() => die(signal as NodeJS.Signals))
      return true
    }
    const number = next++
    started.push({ args, display: `:${number}`, signals, die })
    if (failToStart) setImmediate(() => die('SIGABRT'))
    else queueMicrotask(() => report.write(`${number}\n`))
    return child
  }) as unknown as NonNullable<ProcessHostOptions['xvfb']>['spawnXvfb']
  return { options: { executable: 'Xvfb', spawnXvfb }, started }
}
const until = async (condition: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(condition(), `timed out waiting for ${what}`)
}

test('process host: every slot gets its own browser and profile, started with the node’s fenced environment', async () => {
  const launcher = fakeLauncher()
  const processes = host(launcher, { display: 'headless' })
  process.env.BROWSERBAY_API_KEY_FOR_TEST = 'secret'
  try {
    await processes.createRun('s1')
    await processes.createRun('s2')
    const [one, two] = launcher.started
    assert.equal(launcher.started.length, 2, 'a Chromium each')
    assert.notEqual(one!.profileDir, two!.profileDir)
    assert.ok(existsSync(one!.profileDir) && existsSync(two!.profileDir))
    assert.ok(one!.args.includes('--remote-debugging-pipe'))
    assert.ok(
      !JSON.stringify(one!.env).includes('BROWSERBAY_API_KEY_FOR_TEST'),
      'the browser does not see the node’s secrets'
    )
    assert.equal(processes.size(), 2)
    // Each browser holds exactly its own slot's context, and its own client is dedicated to it.
    assert.equal(one!.fake.contexts.size, 2, 'the default context and the slot’s')
    assert.equal(two!.fake.contexts.size, 2)
  } finally {
    delete process.env.BROWSERBAY_API_KEY_FOR_TEST
    await processes.close()
  }
})

test('process host: a slot’s client talks to its own browser, with the browser-wide commands a shared one refuses', async () => {
  const launcher = fakeLauncher()
  const processes = host(launcher)
  try {
    await processes.createRun('s1')
    const replies: any[] = []
    const client = processes.connect('s1', { send: (text) => replies.push(JSON.parse(text)) })
    client.handleMessage(JSON.stringify({ id: 1, method: 'Target.createBrowserContext', params: {} }))
    client.handleMessage(JSON.stringify({ id: 2, method: 'Tracing.start', params: {} }))
    await until(() => replies.length === 2, 'both answers')
    assert.ok(
      replies.every((reply) => reply.error === undefined),
      JSON.stringify(replies)
    )
    client.close()
    assert.throws(() => processes.connect('nope', { send: () => undefined }), /Unknown slot/)
  } finally {
    await processes.close()
  }
})

test('process host: releasing a slot ends its browser and removes its profile, and no other slot’s', async () => {
  const launcher = fakeLauncher()
  const processes = host(launcher)
  try {
    await processes.createRun('s1')
    await processes.createRun('s2')
    const [one, two] = launcher.started
    await processes.disposeRun('s1')
    assert.deepEqual(one!.signals, ['SIGTERM'])
    assert.ok(!existsSync(one!.profileDir), 'the profile is gone')
    assert.deepEqual(two!.signals, [], 'the other browser is left alone')
    assert.ok(existsSync(two!.profileDir))
    assert.equal(processes.size(), 1)
    await processes.disposeRun('s1') // twice is fine
    assert.throws(() => processes.connect('s1', { send: () => undefined }), /Unknown slot/)
  } finally {
    await processes.close()
  }
  assert.ok(!existsSync(launcher.started[1]!.profileDir), 'closing the host removes the rest')
})

test('process host: a browser that dies on its own ends only its slot, and the node is told', async () => {
  const launcher = fakeLauncher()
  const processes = host(launcher)
  const ended: Array<[string, string]> = []
  processes.onRunEnded((runKey, reason) => ended.push([runKey, reason]))
  try {
    await processes.createRun('s1')
    await processes.createRun('s2')
    const closes: Array<number | undefined> = []
    processes.connect('s1', { send: () => undefined, close: (code) => closes.push(code) })
    launcher.started[0]!.die('SIGSEGV')
    await until(() => ended.length === 1, 'the slot to be reported ended')
    assert.equal(ended[0]![0], 's1')
    assert.match(ended[0]![1], /its browser ended.*SIGSEGV/)
    assert.deepEqual(closes, [1011], 'its client is closed with the “browser closed” code')
    assert.ok(!existsSync(launcher.started[0]!.profileDir))
    assert.equal(processes.size(), 1, 'the other slot carries on')
    assert.ok(processes.connect('s2', { send: () => undefined }))
  } finally {
    await processes.close()
  }
})

test('process host: a browser that cannot start fails the create, leaves nothing behind, and is not reported as a lost slot', async () => {
  const dies = fakeLauncher({ silent: true, dieOnStart: true })
  const processes = host(dies)
  const ended: string[] = []
  processes.onRunEnded((runKey) => ended.push(runKey))
  await assert.rejects(processes.createRun('s1'), /Chromium exited \(SIGABRT\)/)
  assert.equal(processes.size(), 0)
  assert.ok(!existsSync(dies.started[0]!.profileDir))
  assert.deepEqual(ended, [])

  const silent = fakeLauncher({ silent: true })
  const slow = host(silent, { startTimeoutMs: 100 })
  await assert.rejects(slow.createRun('s1'), /did not answer/)
  assert.deepEqual(silent.started[0]!.signals, ['SIGTERM'], 'a browser that never answers is ended, not leaked')
  assert.ok(!existsSync(silent.started[0]!.profileDir))
})

test('process host: a slot id is never used as a path, and a slot has one browser', async () => {
  const launcher = fakeLauncher()
  const processes = host(launcher)
  try {
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(101)])
      await assert.rejects(processes.createRun(bad), /valid slot id/, bad)
    assert.equal(launcher.started.length, 0, 'nothing was started for them')
    await processes.createRun('s1')
    await assert.rejects(processes.createRun('s1'), /already has a browser/)
    assert.equal(launcher.started.length, 1)
  } finally {
    await processes.close()
  }
})

test('process host: with a profile root, each slot’s profile is a directory in it, removed with the slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browserbay-root-'))
  const launcher = fakeLauncher()
  const processes = host(launcher, { profileRoot: root })
  try {
    await processes.createRun('s1')
    assert.equal(launcher.started[0]!.profileDir, join(root, 's1'))
    assert.ok(existsSync(join(root, 's1')))
    await processes.disposeRun('s1')
    assert.ok(!existsSync(join(root, 's1')))
    assert.ok(existsSync(root), 'the root itself is the operator’s and stays')
  } finally {
    await processes.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('process host: two creates for one slot start one browser, and a browser that cannot be spawned leaves no profile', async () => {
  const launcher = fakeLauncher()
  const processes = host(launcher)
  try {
    const results = await Promise.allSettled([processes.createRun('s1'), processes.createRun('s1')])
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected'])
    assert.equal(launcher.started.length, 1, 'one Chromium, not two with one of them lost')
  } finally {
    await processes.close()
  }

  const root = await mkdtemp(join(tmpdir(), 'browserbay-root-'))
  const failing = createProcessHost({
    executable: '/chromium',
    profileRoot: root,
    spawnChromium: (() => {
      throw new Error('spawn EACCES')
    }) as unknown as NonNullable<ProcessHostOptions['spawnChromium']>
  })
  try {
    await assert.rejects(failing.createRun('s1'), /spawn EACCES/)
    assert.ok(!existsSync(join(root, 's1')), 'the directory made for it is removed')
    assert.equal(failing.size(), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('process host: profiles a killed node left under its root are removed, and nothing else there is touched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browserbay-root-'))
  try {
    const stale = ['s' + 'a'.repeat(24), 's' + '0123456789abcdef01234567']
    const kept = ['my-data', 'snapshots', 'sXYZ']
    for (const name of [...stale, ...kept]) await mkdir(join(root, name))
    await removeStaleProfiles(root)
    for (const name of stale) assert.ok(!existsSync(join(root, name)), `${name} is removed`)
    for (const name of kept) assert.ok(existsSync(join(root, name)), `${name} is not ours`)
    await removeStaleProfiles(join(root, 'missing')) // a root that does not exist yet is fine
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('process host: on xvfb every slot gets a display of its own, and a browser that sees only that one', async () => {
  const saved = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }
  process.env.DISPLAY = ':0'
  process.env.WAYLAND_DISPLAY = 'wayland-0'
  const launcher = fakeLauncher()
  const displays = fakeXvfb()
  const processes = host(launcher, { display: 'xvfb', xvfb: displays.options })
  try {
    await processes.createRun('s1')
    await processes.createRun('s2')
    assert.equal(displays.started.length, 2, 'a display each: clipboards and crashes are not shared')
    const [one, two] = launcher.started
    assert.equal(one!.env.DISPLAY, displays.started[0]!.display)
    assert.equal(two!.env.DISPLAY, displays.started[1]!.display)
    assert.notEqual(one!.env.DISPLAY, two!.env.DISPLAY)
    assert.match(String(one!.env.XAUTHORITY), /Xauthority$/, 'the browser is given the cookie file')
    assert.notEqual(one!.env.XAUTHORITY, two!.env.XAUTHORITY)
    assert.ok(!('WAYLAND_DISPLAY' in one!.env), 'never the host compositor')
    assert.ok(one!.args.includes('--ozone-platform=x11'))
    assert.ok(!one!.args.some((arg) => arg.startsWith('--headless')))
  } finally {
    await processes.close()
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('process host: releasing a slot ends its display and no other slot’s', async () => {
  const launcher = fakeLauncher()
  const displays = fakeXvfb()
  const processes = host(launcher, { display: 'xvfb', xvfb: displays.options })
  try {
    await processes.createRun('s1')
    await processes.createRun('s2')
    await processes.disposeRun('s1')
    const [first, second] = displays.started
    assert.deepEqual(first!.signals, ['SIGTERM'], 'its display is stopped with its browser')
    assert.deepEqual(second!.signals, [], 'the other slot’s display is left alone')
  } finally {
    await processes.close()
  }
  assert.deepEqual(displays.started[1]!.signals, ['SIGTERM'], 'closing the host stops the rest')
})

test('process host: a display that dies takes only its slot’s browser with it, and the node is told', async () => {
  const launcher = fakeLauncher()
  const displays = fakeXvfb()
  const processes = host(launcher, { display: 'xvfb', xvfb: displays.options })
  const ended: Array<[string, string]> = []
  processes.onRunEnded((runKey, reason) => ended.push([runKey, reason]))
  try {
    await processes.createRun('s1')
    await processes.createRun('s2')
    displays.started[0]!.die('SIGSEGV')
    await until(() => ended.length === 1, 'the slot to be reported ended')
    assert.equal(ended[0]![0], 's1')
    assert.match(ended[0]![1], /its browser ended \(Xvfb exited \(SIGSEGV\)\)/)
    assert.deepEqual(launcher.started[0]!.signals, ['SIGKILL'], 'a browser cannot outlive its display')
    assert.deepEqual(launcher.started[1]!.signals, [], 'the other slot carries on')
    assert.equal(processes.size(), 1)
  } finally {
    await processes.close()
  }
})

test('process host: a display that cannot start fails the create without starting a browser or leaving a profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browserbay-root-'))
  const launcher = fakeLauncher()
  const processes = host(launcher, {
    display: 'xvfb',
    xvfb: fakeXvfb({ failToStart: true }).options,
    profileRoot: root
  })
  try {
    await assert.rejects(processes.createRun('s1'), /Xvfb exited \(SIGABRT\) before it was ready/)
    assert.equal(launcher.started.length, 0, 'no browser without a display')
    assert.ok(!existsSync(join(root, 's1')), 'the profile made for it is removed')
    assert.equal(processes.size(), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('process host: headless slots start no display and their browser keeps the node’s own', async () => {
  const launcher = fakeLauncher()
  const displays = fakeXvfb()
  const processes = host(launcher, { display: 'headless', xvfb: displays.options })
  try {
    await processes.createRun('s1')
    assert.equal(displays.started.length, 0)
    assert.ok(launcher.started[0]!.args.includes('--headless=new'))
    assert.ok(launcher.started[0]!.args.includes('--screen-info={1920x1080}'))
  } finally {
    await processes.close()
  }
})

// ---- what a slot asked for: its proxy, time zone and language ----------------------------------------------------------

/** A forwarder for the host to start: it records what it was given and whether it was closed. */
function fakeForwarders({ failToStart = false } = {}) {
  const started: Array<{ settings: any; url: string; closed: number }> = []
  const start = (async (settings: unknown) => {
    if (failToStart) throw new Error('could not listen')
    const entry = { settings, url: `socks5://127.9.9.${started.length + 1}:4000`, closed: 0 }
    started.push(entry)
    return { url: entry.url, close: async () => void entry.closed++ }
  }) as unknown as NonNullable<ProcessHostOptions['forwarder']>['start']
  return { options: { start }, started }
}

const PROXY = {
  server: 'http://proxy.example.com:8080',
  username: 'user',
  password: 'process-host-secret',
  bypass: 'a.test'
}

test('process host: a proxied slot’s browser is made with its forwarder, kept off WebRTC’s own paths, and told no credentials', async () => {
  const launcher = fakeLauncher()
  const forwarders = fakeForwarders()
  const processes = host(launcher, { forwarder: forwarders.options })
  try {
    await processes.createRun('s1', { proxy: PROXY })
    await processes.createRun('s2')
    assert.equal(forwarders.started.length, 1, 'only the proxied slot has one')
    assert.deepEqual(forwarders.started[0]!.settings, PROXY)
    const [proxied, plain] = launcher.started
    assert.deepEqual(proxied!.fake.commands('Target.createBrowserContext').at(-1)!.params, {
      disposeOnDetach: false,
      proxyServer: forwarders.started[0]!.url,
      proxyBypassList: '<-loopback>;a.test'
    })
    assert.ok(proxied!.args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'))
    assert.ok(!plain!.args.some((arg) => arg.includes('webrtc')), 'a plain slot keeps WebRTC as it is')
    assert.ok(
      !JSON.stringify([proxied!.args, proxied!.env, proxied!.fake.log]).includes('process-host-secret'),
      'the browser never sees the password'
    )
    assert.ok(!JSON.stringify(proxied!.args).includes('proxy.example.com'), 'nor the real proxy')

    await processes.disposeRun('s1')
    assert.equal(forwarders.started[0]!.closed, 1, 'the forwarder is closed with the slot')
  } finally {
    await processes.close()
  }
})

test('process host: a slot’s own browser is started in its time zone and language', async () => {
  const launcher = fakeLauncher()
  const processes = host(launcher)
  try {
    await processes.createRun('s1', { timezone: 'Europe/Berlin', locale: 'de-DE' })
    await processes.createRun('s2', { locale: 'fr' })
    await processes.createRun('s3')
    const [german, french, plain] = launcher.started
    assert.equal(german!.env.TZ, 'Europe/Berlin')
    assert.deepEqual(
      [german!.env.LANG, german!.env.LC_ALL, german!.env.LANGUAGE],
      ['de_DE.UTF-8', 'de_DE.UTF-8', 'de_DE:de'],
      'Linux Chromium reads the language from the environment'
    )
    assert.ok(german!.args.includes('--lang=de-DE') && german!.args.includes('--accept-lang=de-DE,de'))
    assert.deepEqual([french!.env.LANGUAGE, french!.args.includes('--accept-lang=fr')], ['fr', true])
    assert.equal(french!.env.TZ, undefined, 'only what was asked for is set')
    assert.ok(!('TZ' in plain!.env) && !plain!.args.some((arg) => arg.startsWith('--lang')))
    assert.ok(
      plain!.args.at(-1) === 'about:blank' && german!.args.at(-1) === 'about:blank',
      'the start page stays last'
    )
  } finally {
    await processes.close()
  }
})

test('process host: options the node cannot honour fail the create before anything is made', async () => {
  const launcher = fakeLauncher()
  const forwarders = fakeForwarders()
  const processes = host(launcher, { forwarder: forwarders.options })
  try {
    await assert.rejects(processes.createRun('s1', { surprise: 1 } as never), /does not know the option/)
    await assert.rejects(processes.createRun('s2', { timezone: 'Mars/Olympus' }), /timezone/)
    await assert.rejects(processes.createRun('s3', { proxy: { server: 'http://127.0.0.1:1' } }), /loopback/)
    assert.equal(launcher.started.length, 0)
    assert.equal(forwarders.started.length, 0)
    assert.equal(processes.size(), 0)
  } finally {
    await processes.close()
  }
})

test('process host: a forwarder is never left behind when its slot cannot be made', async () => {
  // The forwarder cannot start: no browser, no profile.
  const root = await mkdtemp(join(tmpdir(), 'browserbay-root-'))
  const launcher = fakeLauncher()
  const broken = host(launcher, { profileRoot: root, forwarder: fakeForwarders({ failToStart: true }).options })
  await assert.rejects(broken.createRun('s1', { proxy: PROXY }), /could not listen/)
  assert.equal(launcher.started.length, 0)
  assert.ok(!existsSync(join(root, 's1')))

  // The browser cannot be spawned: the forwarder that was started is closed, and so is the profile.
  const forwarders = fakeForwarders()
  const failing = createProcessHost({
    executable: '/chromium',
    profileRoot: root,
    forwarder: forwarders.options,
    spawnChromium: (() => {
      throw new Error('spawn EACCES')
    }) as unknown as NonNullable<ProcessHostOptions['spawnChromium']>
  })
  await assert.rejects(failing.createRun('s2', { proxy: PROXY }), /spawn EACCES/)
  assert.equal(forwarders.started[0]!.closed, 1)
  assert.ok(!existsSync(join(root, 's2')))

  // The browser starts and never answers: ended, and the forwarder with it.
  const silentForwarders = fakeForwarders()
  const silent = host(fakeLauncher({ silent: true }), { startTimeoutMs: 100, forwarder: silentForwarders.options })
  await assert.rejects(silent.createRun('s3', { proxy: PROXY }), /did not answer/)
  assert.equal(silentForwarders.started[0]!.closed, 1)
  await rm(root, { recursive: true, force: true })
})

test('process host: a proxied slot whose browser dies on its own loses its forwarder too', async () => {
  const launcher = fakeLauncher()
  const forwarders = fakeForwarders()
  const processes = host(launcher, { forwarder: forwarders.options })
  const ended: string[] = []
  processes.onRunEnded((runKey) => ended.push(runKey))
  try {
    await processes.createRun('s1', { proxy: PROXY })
    launcher.started[0]!.die('SIGSEGV')
    await until(() => ended.length === 1, 'the slot to be reported ended')
    await until(() => forwarders.started[0]!.closed === 1, 'its forwarder to be closed')
  } finally {
    await processes.close()
  }
})

// ---- signing ----------------------------------------------------------------------------------------------------------

test('process host: a slot is signed when it asks or the node always signs, and the context is made with the signer', async () => {
  const key = generateSigningKey()
  const signing = (mode: 'optional' | 'always') => ({
    mode,
    signer: createRequestSigner({ key: key.privateJwk, agent: 'https://box.example.com' })
  })

  const launcher = fakeLauncher()
  const optional = host(launcher, { signing: signing('optional') })
  try {
    await optional.createRun('plain')
    await optional.createRun('signed', { signRequests: true })
    // What signs is the hub: for a run made with a signer it attaches a session of its own to every tab and turns request
    // interception on there (scope.test.ts has the detail). So, seen from the browser: open a tab in the slot's context, and ask
    // whether the hub intercepted it.
    const interceptsATab = async (browser: (typeof launcher.started)[number]) => {
      const context = [...browser.fake.contexts.keys()].at(-1)!
      browser.fake.createTarget({ url: 'about:blank', browserContextId: context })
      await browser.fake.flush()
      return browser.fake.commands('Fetch.enable').length > 0
    }
    assert.equal(await interceptsATab(launcher.started[0]!), false, 'a slot that did not ask is not intercepted')
    assert.equal(await interceptsATab(launcher.started[1]!), true, 'one that asked is')
  } finally {
    await optional.close()
  }

  const always = host(fakeLauncher(), { signing: signing('always') })
  await assert.rejects(always.createRun('s', { signRequests: false }), /cannot leave one unsigned/)
  await always.close()

  const off = fakeLauncher()
  const none = host(off)
  await assert.rejects(none.createRun('s', { signRequests: true }), /does not sign requests/)
  assert.equal(off.started.length, 0, 'nothing was started for a slot that could not be made as asked')
  await none.close()
})
