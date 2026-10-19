import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appliedNames,
  featuresFor,
  OPTION_FIELDS,
  REQUEST_FIELDS,
  parseLocale,
  parseNodeLabels,
  parseNodeSlotOptions,
  parseProxySettings,
  parseSlotOptions,
  parseTimezone,
  sanitizeFeatures,
  sanitizeLabels
} from './slot-options.js'

const problem = <T>(result: { ok: true; value: T } | { ok: false; message: string }) => {
  assert.equal(result.ok, false)
  return (result as { ok: false; message: string }).message
}

test('a proxy: a server, optionally with credentials and a bypass list', () => {
  const plain = parseProxySettings({ server: 'http://proxy.example.com:8080' })
  assert.deepEqual(plain, { ok: true, value: { server: 'http://proxy.example.com:8080' } })

  const full = parseProxySettings({
    server: 'socks5://10.0.0.7:1080',
    username: 'user',
    password: 'p:a ss/w@rd',
    bypass: '*.internal.example.com;10.0.0.0/8'
  })
  assert.deepEqual(full, {
    ok: true,
    value: {
      server: 'socks5://10.0.0.7:1080',
      username: 'user',
      password: 'p:a ss/w@rd',
      bypass: '*.internal.example.com;10.0.0.0/8'
    }
  })
  assert.deepEqual(parseProxySettings({ server: 'http://p.example:1', username: 'only-a-name' }), {
    ok: true,
    value: { server: 'http://p.example:1', username: 'only-a-name' }
  })
})

test('a proxy that is wrong is refused with what is wrong, and never repeats a credential', () => {
  const secret = 'hunter2-the-password'
  for (const [value, expected] of [
    [undefined, /must be an object/],
    ['http://p.example:1', /must be an object/],
    [[], /must be an object/],
    [{}, /proxy\.server must be/],
    [{ server: 'p.example:1' }, /proxy\.server must be/],
    [{ server: `http://user:${secret}@p.example:1` }, /proxy\.server must be/],
    [{ server: 'http://127.0.0.1:8080' }, /loopback/],
    [{ server: 'http://0x7f000001:8080' }, /loopback/],
    [{ server: 'socks5://localhost:1080' }, /loopback/],
    [{ server: 'http://169.254.169.254:80' }, /link-local/],
    [{ server: 'http://p.example:1', extra: 1 }, /no field "extra"/],
    [{ server: 'http://p.example:1', username: 5 }, /username must be text/],
    [{ server: 'http://p.example:1', username: 'u\nx' }, /username must be text/],
    [{ server: 'http://p.example:1', username: 'u', password: `${secret}\r\n` }, /password must be text/],
    [{ server: 'http://p.example:1', username: 'u', password: 'x'.repeat(256) }, /at most 255 bytes/],
    [{ server: 'http://p.example:1', username: 'é'.repeat(128) }, /at most 255 bytes/],
    [{ server: 'http://p.example:1', password: secret }, /needs proxy\.username/],
    [{ server: 'http://p.example:1', username: 'a:b' }, /colon/],
    [{ server: 'http://p.example:1', bypass: 'x'.repeat(1025) }, /bypass must be/],
    [{ server: 'http://p.example:1', bypass: 'a\0b' }, /bypass must be/]
  ] as const) {
    const message = problem(parseProxySettings(value))
    assert.match(message, expected, JSON.stringify(value))
    assert.ok(!message.includes(secret), `the message repeats a credential: ${message}`)
  }
  const longName = problem(parseProxySettings({ server: 'http://p.example:1', ['x'.repeat(100)]: 1 }))
  assert.ok(!longName.includes('x'.repeat(50)), 'a long field name is cut')
})

test('time zones and locales are checked and put in the spelling the system uses', () => {
  assert.deepEqual(parseTimezone('Europe/Berlin'), { ok: true, value: 'Europe/Berlin' })
  assert.deepEqual(parseTimezone('europe/berlin'), { ok: true, value: 'Europe/Berlin' }, 'TZ is case-sensitive')
  assert.deepEqual(parseTimezone('UTC'), { ok: true, value: 'UTC' })
  assert.deepEqual(parseTimezone('America/Argentina/Buenos_Aires'), {
    ok: true,
    value: 'America/Argentina/Buenos_Aires'
  })
  for (const value of [
    '',
    'Mars/Olympus',
    '../etc/passwd',
    'Europe/Berlin\n',
    ':Europe/Berlin',
    'x'.repeat(65),
    5,
    undefined
  ]) {
    assert.match(problem(parseTimezone(value)), /timezone/, JSON.stringify(value))
  }

  assert.deepEqual(parseLocale('en-US'), { ok: true, value: 'en-US' })
  assert.deepEqual(parseLocale('de-de'), { ok: true, value: 'de-DE' })
  assert.deepEqual(parseLocale('fr'), { ok: true, value: 'fr' })
  for (const value of ['', 'x', 'en_US', 'en US', 'toolongtobealanguagetag-and-more-and-more', '--', 5, undefined]) {
    assert.match(problem(parseLocale(value)), /locale/, JSON.stringify(value))
  }
})

test('node labels: names, up to a few, without repeats', () => {
  assert.deepEqual(parseNodeLabels(['residential', 'eu-west']), { ok: true, value: ['residential', 'eu-west'] })
  assert.deepEqual(parseNodeLabels(['a', 'a', 'b']), { ok: true, value: ['a', 'b'] })
  assert.deepEqual(parseNodeLabels([]), { ok: true, value: [] })
  for (const value of [
    'residential',
    [1],
    ['a b'],
    ['a/b'],
    [''],
    ['x'.repeat(64)],
    Array.from({ length: 9 }, (_, i) => `l${i}`)
  ]) {
    problem(parseNodeLabels(value))
  }
})

test('slot options: the three a node acts on, and a node refuses one it does not know', () => {
  assert.deepEqual(parseSlotOptions({}), { ok: true, value: {} })
  assert.deepEqual(
    parseSlotOptions({
      proxy: { server: 'http://p.example:1' },
      timezone: 'europe/paris',
      locale: 'fr-fr',
      runId: 'ignored'
    }),
    { ok: true, value: { proxy: { server: 'http://p.example:1' }, timezone: 'Europe/Paris', locale: 'fr-FR' } }
  )
  assert.match(problem(parseSlotOptions({ timezone: 'nope' })), /timezone/)

  assert.deepEqual(parseNodeSlotOptions(undefined), { ok: true, value: {} })
  assert.deepEqual(parseNodeSlotOptions({ timezone: 'UTC' }), { ok: true, value: { timezone: 'UTC' } })
  assert.match(
    problem(parseNodeSlotOptions({ timezone: 'UTC', surprise: true })),
    /does not know the option "surprise"/
  )
  assert.match(problem(parseNodeSlotOptions('proxy')), /must be an object/)
  assert.match(
    problem(parseNodeSlotOptions({ proxy: { server: 'http://127.0.0.1:1' } })),
    /loopback/,
    'the node checks again'
  )
})

test('what a set of options needs of a node, and what it is reported as having', () => {
  assert.deepEqual(featuresFor({}), [])
  assert.deepEqual(featuresFor({ proxy: { server: 'http://p.example:1' } }), ['proxy'])
  assert.deepEqual(featuresFor({ timezone: 'UTC' }), ['locale'])
  assert.deepEqual(featuresFor({ locale: 'fr', timezone: 'UTC', proxy: { server: 'http://p.example:1' } }).sort(), [
    'locale',
    'proxy'
  ])

  assert.deepEqual(appliedNames({}, []), [])
  assert.deepEqual(appliedNames({ proxy: { server: 'http://p.example:1' }, locale: 'fr' }, ['eu']), [
    'proxy',
    'locale',
    'nodeLabels'
  ])
})

test('what a node says in its hello is cleaned before the relay keeps it', () => {
  assert.deepEqual(sanitizeLabels(['a', 'b', 'a', 7, 'no good', 'x'.repeat(64)]), ['a', 'b'])
  assert.deepEqual(sanitizeLabels('residential'), [])
  assert.equal(sanitizeLabels(Array.from({ length: 40 }, (_, i) => `l${i}`)).length, 16)
  assert.deepEqual(sanitizeFeatures(['proxy', 'locale', 'proxy', 'a b', 5, 'future-feature:1']), [
    'proxy',
    'locale',
    'future-feature:1'
  ])
  assert.deepEqual(sanitizeFeatures(undefined), [])
})

test('every option is a request field, an applied name and something a node is asked for, so one cannot be left out of a list', () => {
  // Typed by OPTION_FIELDS: a new option without a sample here does not compile.
  const sample: Record<(typeof OPTION_FIELDS)[number], unknown> = {
    proxy: { server: 'http://203.0.113.5:8080' },
    timezone: 'Europe/Berlin',
    locale: 'de-DE'
  }
  for (const name of OPTION_FIELDS) {
    assert.ok((REQUEST_FIELDS as readonly string[]).includes(name), `${name} is a field a request may carry`)
    const parsed = parseSlotOptions({ [name]: sample[name] })
    assert.ok(parsed.ok, `${name} parses`)
    if (!parsed.ok) continue
    assert.deepEqual(Object.keys(parsed.value), [name], `${name} is the only option read`)
    assert.deepEqual(appliedNames(parsed.value, []), [name], `${name} is named in applied`)
    assert.ok(featuresFor(parsed.value).length > 0, `${name} asks something of a node`)
    assert.ok(parseNodeSlotOptions(parsed.value).ok, `a node accepts ${name}`)
  }
})
