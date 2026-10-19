import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseNodeEnv } from './node/main.js'
import { parseApiKeys, parseEnrollmentSecrets, parseRelayConfig } from './relay/config.js'
import { parseSigningKey } from './web-bot-auth.js'

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

test('cli: `key <name>` also prints the relay entry for it, with its namespace and quota', () => {
  const plain = cli(['key', 'ci']).stdout
  const key = /BROWSERBAY_API_KEY=(\S+)/.exec(plain)?.[1]
  const entry = /BROWSERBAY_API_KEYS=(\S+)/.exec(plain)?.[1]
  assert.ok(key && entry, plain)
  assert.deepEqual(parseApiKeys(entry), [{ id: 'ci', sha256: createHash('sha256').update(key).digest('hex') }])

  const confined = cli(['key', 'billing', '--namespace', 'billing', '--quota', '5']).stdout
  const confinedEntry = /BROWSERBAY_API_KEYS=(\S+)/.exec(confined)?.[1]
  assert.deepEqual(parseApiKeys(confinedEntry!), [
    { id: 'billing', sha256: parseApiKeys(confinedEntry!)[0]!.sha256, namespace: 'billing', maxSlots: 5 }
  ])

  for (const bad of [
    ['key', 'bad name'],
    ['key', 'x', '--quota', '5'],
    ['key', 'x', '--bogus', '1'],
    ['key', 'x', '--namespace']
  ]) {
    const result = cli(bad)
    assert.equal(result.status, 2, bad.join(' '))
    assert.equal(result.stdout, '', 'a refused request prints no key')
  }
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

test('cli: `web-bot-auth` prints a private key a node accepts, whose public half the relay publishes, and names it by its thumbprint', () => {
  const out = cli(['web-bot-auth']).stdout
  const key = /BROWSERBAY_WEB_BOT_AUTH_KEY='(\{.*\})'/.exec(out)?.[1]
  const keyid = /looks the key up by:\s+(\S+)/.exec(out)?.[1]
  assert.ok(key && keyid, out)
  assert.equal(parseSigningKey(key).keyid, keyid, 'the id it prints is the one the key has')
  assert.equal(
    parseNodeEnv({
      BROWSERBAY_RELAY_URL: 'https://r.example.com',
      BROWSERBAY_ENROLLMENT_SECRET: 'x'.repeat(16),
      BROWSERBAY_WEB_BOT_AUTH: 'optional',
      BROWSERBAY_WEB_BOT_AUTH_KEY: key,
      BROWSERBAY_WEB_BOT_AUTH_AGENT: 'https://box.example.com'
    }).webBotAuth?.mode,
    'optional',
    'a node takes it as printed'
  )
  assert.equal(
    parseRelayConfig({
      BROWSERBAY_API_KEY: 'k'.repeat(16),
      BROWSERBAY_ENROLLMENT_SECRETS: 'n:' + '0'.repeat(64),
      BROWSERBAY_WEB_BOT_AUTH_KEY: key
    }).webBotAuthKey,
    key,
    'and so does the relay'
  )
  assert.match(out, /\/\.well-known\/http-message-signatures-directory/)
  assert.notEqual(cli(['web-bot-auth']).stdout, out, 'a different key each time')
  assert.ok(cli(['help']).stdout.includes('web-bot-auth'), 'and the help lists it')
})
