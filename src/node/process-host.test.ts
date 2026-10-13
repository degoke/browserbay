import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
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
const until = async (condition: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(condition(), `timed out waiting for ${what}`)
}

test('process host: every slot gets its own browser and profile, started with the node’s fenced environment', async () => {
  const launcher = fakeLauncher()
  const processes = host(launcher, { headless: true })
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
