import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseNodeEnv } from './node/main.js'
import { parseEnrollmentSecrets } from './relay/config.js'

// The built CLI, as `bin` runs it: `pnpm test` builds first.
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })

test('cli: `key` makes a different key each time, long enough for the relay', () => {
  const [a, b] = [cli(['key']), cli(['key'])]
  assert.equal(a.status, 0)
  assert.ok(a.stdout.trim().length >= 16, 'the relay refuses a shorter API key')
  assert.notEqual(a.stdout, b.stdout)
})

test('cli: `secret` prints a pair the node and the relay both accept, and that match each other', () => {
  const out = cli(['secret', 'edge']).stdout
  const secret = /BROWSERBAY_ENROLLMENT_SECRET=(\S+)/.exec(out)?.[1]
  const entry = /BROWSERBAY_ENROLLMENT_SECRETS=(\S+)/.exec(out)?.[1]
  assert.ok(secret && entry, out)

  const [parsed] = parseEnrollmentSecrets(entry)
  assert.equal(parsed.id, 'edge', 'the name given on the command line')
  assert.equal(
    parsed.sha256,
    createHash('sha256').update(secret).digest('hex'),
    'the relay holds the hash of the secret'
  )
  assert.equal(
    parseNodeEnv({ BROWSERBAY_RELAY_URL: 'https://r.example.com', BROWSERBAY_ENROLLMENT_SECRET: secret })
      .enrollmentSecret,
    secret,
    'and the node accepts the secret as printed'
  )
  assert.equal(cli(['secret']).stdout.includes('=node:'), true, 'the entry is named `node` unless told otherwise')
})

test('cli: `secret` refuses a name the relay would refuse, so the printed entry is always usable', () => {
  for (const name of ['my laptop', 'a:b', 'a,b', 'é']) {
    const result = cli(['secret', name])
    assert.equal(result.status, 2, name)
    assert.equal(result.stdout, '', 'nothing printed that could be pasted')
    assert.match(result.stderr, /may only contain letters/)
  }
  assert.equal(cli(['secret', 'eu-west_1.edge']).status, 0)
})

test('cli: help, and an unknown command is an error that shows the help', () => {
  const help = cli(['--help'])
  assert.equal(help.status, 0)
  for (const command of ['start', 'relay', 'node', 'secret', 'key']) assert.match(help.stdout, new RegExp(command))
  assert.equal(cli([]).status, 0)

  const unknown = cli(['bogus'])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /Unknown command: bogus/)
  assert.match(unknown.stderr, /browserbay start/)
})

test('cli: a bad setting is a sentence and a non-zero exit, never a stack trace', () => {
  const relay = cli(['relay'])
  assert.equal(relay.status, 2)
  assert.match(relay.stderr, /Invalid relay configuration: BROWSERBAY_API_KEY/)
  assert.doesNotMatch(relay.stderr, /\n\s+at /, 'no stack')

  const box = cli(['start'], { BROWSERBAY_API_KEY: 'short' })
  assert.equal(box.status, 2)
  assert.match(box.stderr, /Invalid configuration: BROWSERBAY_API_KEY/)

  const node = cli(['node'])
  assert.equal(node.status, 2)
  assert.match(node.stderr, /BROWSERBAY_RELAY_URL and BROWSERBAY_ENROLLMENT_SECRET/)
})
