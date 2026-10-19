import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConfigError } from '../protocol.js'
import { startXvfb, xauthorityEntry } from './xvfb.js'

/** An "Xvfb": a script that says what a real one does on fd 3, or fails the way a broken one does. */
async function stub(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'browserbay-xvfb-test-'))
  const path = join(dir, 'Xvfb')
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('xauthority: one MIT-MAGIC-COOKIE-1 entry for any display, byte for byte', () => {
  const cookie = Buffer.from('0123456789abcdef')
  const expected = Buffer.concat([
    Buffer.from([0xff, 0xff]), // family: wild, matches any host
    Buffer.from([0x00, 0x00]), // address: empty
    Buffer.from([0x00, 0x00]), // display number: empty, so any
    Buffer.from([0x00, 0x12]),
    Buffer.from('MIT-MAGIC-COOKIE-1'),
    Buffer.from([0x00, 0x10]),
    cookie
  ])
  assert.deepEqual(xauthorityEntry(cookie), expected)
})

test('xvfb: the display number comes from -displayfd, and the display is closed to anything without the cookie file', async () => {
  const fake = await stub('echo 7 >&3; exec sleep 30')
  const recorded: string[][] = []
  const xvfb = await startXvfb({
    executable: fake.path,
    spawnXvfb: ((exe: string, args: string[], options: object) => {
      recorded.push(args)
      return spawn(exe, args, options as never)
    }) as typeof spawn
  })
  try {
    assert.equal(xvfb.display, ':7')
    assert.deepEqual(xvfb.env, { DISPLAY: ':7', XAUTHORITY: xvfb.xauthority })
    const args = recorded[0]!
    assert.deepEqual(args.slice(0, 2), ['-displayfd', '3'], 'the server picks a free display and says which')
    assert.equal(args[args.indexOf('-auth') + 1], xvfb.xauthority, 'access control on: a client needs the cookie')
    assert.ok(args.includes('-nolisten') && args[args.indexOf('-nolisten') + 1] === 'tcp', 'a local socket only')
    assert.equal(args[args.indexOf('-screen') + 2], '1920x1080x24')

    const mode = (await stat(xvfb.xauthority)).mode & 0o777
    assert.equal(mode, 0o600, 'only this process can read the cookie')
    assert.equal((await readFile(xvfb.xauthority)).subarray(0, 2).toString('hex'), 'ffff')
    const second = await startXvfb({ executable: fake.path })
    try {
      assert.notDeepEqual(
        await readFile(second.xauthority),
        await readFile(xvfb.xauthority),
        'a fresh cookie each time'
      )
    } finally {
      await second.close()
    }
  } finally {
    await xvfb.close()
    await fake.cleanup()
  }
  assert.ok(!existsSync(xvfb.xauthority), 'closing removes the cookie')
  await xvfb.close() // twice is fine
})

test('xvfb: a missing Xvfb is a configuration error that names the way out', async () => {
  await assert.rejects(
    startXvfb({ executable: '/no/such/Xvfb' }),
    (error: Error) => error instanceof ConfigError && /Xvfb was not found.*BROWSERBAY_HEADLESS/.test(error.message)
  )
})

test('xvfb: one that fails to start says why, and one that never answers is given up on', async () => {
  const broken = await stub('echo "no screen available" >&2; exit 1')
  const silent = await stub('exec sleep 30')
  try {
    await assert.rejects(
      startXvfb({ executable: broken.path }),
      /exited \(1\) before it was ready: no screen available/
    )
    await assert.rejects(startXvfb({ executable: silent.path, startTimeoutMs: 200 }), /did not report a display within/)
  } finally {
    await broken.cleanup()
    await silent.cleanup()
  }
})

test('xvfb: `exited` says when the display went away on its own, and close() waits for the process', async () => {
  const dying = await stub('echo 3 >&3; exec sleep 0.2')
  const lasting = await stub('echo 4 >&3; exec sleep 30')
  try {
    const short = await startXvfb({ executable: dying.path })
    assert.match(await short.exited, /^exited \(0\)$/)
    await short.close()

    const long = await startXvfb({ executable: lasting.path })
    let said = ''
    void long.exited.then((why) => (said = why))
    await long.close()
    assert.match(said, /exited \(SIGTERM\)/, 'close() returns once the process is gone')
  } finally {
    await dying.cleanup()
    await lasting.cleanup()
  }
})
