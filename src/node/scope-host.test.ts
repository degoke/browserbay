import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeChromium } from './fake-chromium.js'
import { createScopeHost } from './scope-host.js'
import { createCdpScope } from './scope.js'
import type { ProxyForwarder, startProxyForwarder } from './proxy-forwarder.js'

async function world() {
  const fake = createFakeChromium()
  fake.createTarget({ url: 'about:blank' })
  const scope = createCdpScope({ upstream: { send: fake.receive } })
  fake.onMessage(scope.onUpstreamMessage)
  await scope.start()
  await fake.flush()
  const forwarders: Array<{ settings: unknown; url: string; closed: number }> = []
  const startForwarder = (async (settings: unknown) => {
    const entry = { settings, url: `socks5://127.9.9.${forwarders.length + 1}:4000`, closed: 0 }
    forwarders.push(entry)
    return { url: entry.url, close: async () => void entry.closed++ } satisfies ProxyForwarder
  }) as unknown as typeof startProxyForwarder
  return { fake, scope, forwarders, host: createScopeHost(scope, { startForwarder }) }
}

const PROXY = { server: 'http://proxy.example.com:8080', username: 'u', password: 'pw', bypass: 'a.test' }

test('scope host: a plain slot starts no forwarder, a proxied one gets its own for as long as it lives', async () => {
  const { fake, scope, forwarders, host } = await world()
  await host.createRun('plain')
  assert.equal(forwarders.length, 0)
  assert.deepEqual(fake.commands('Target.createBrowserContext').at(-1)!.params, { disposeOnDetach: false })

  await host.createRun('proxied', { proxy: PROXY })
  assert.equal(forwarders.length, 1)
  assert.deepEqual(forwarders[0]!.settings, PROXY, 'the forwarder is given the proxy, with its credentials')
  const params = fake.commands('Target.createBrowserContext').at(-1)!.params
  assert.deepEqual(params, {
    disposeOnDetach: false,
    proxyServer: forwarders[0]!.url,
    proxyBypassList: '<-loopback>;a.test'
  })
  assert.ok(!JSON.stringify(fake.log).includes('pw'), 'the browser is never told the credentials')
  assert.equal(forwarders[0]!.closed, 0)

  await host.disposeRun('proxied')
  assert.equal(forwarders[0]!.closed, 1, 'closed with the slot')
  assert.ok(!scope.hasRun('proxied'))
  await host.disposeRun('proxied') // twice is fine
  assert.equal(forwarders[0]!.closed, 1)
  await host.disposeRun('plain')
})

test('scope host: a slot that could not be made leaves no forwarder, and a duplicate leaves the first one alone', async () => {
  const { forwarders, host } = await world()
  await host.createRun('s1', { proxy: PROXY })
  await assert.rejects(host.createRun('s1', { proxy: PROXY }), /already has a browser context/)
  assert.equal(forwarders.length, 2)
  assert.equal(forwarders[1]!.closed, 1, 'the second forwarder was closed')
  assert.equal(forwarders[0]!.closed, 0, 'the first slot keeps its own')
  await host.disposeRun('s1')
  assert.equal(forwarders[0]!.closed, 1)
})

test('scope host: a shared browser cannot give one slot its own time zone or language, and says so before making anything', async () => {
  const { fake, forwarders, host } = await world()
  const before = fake.commands('Target.createBrowserContext').length
  await assert.rejects(host.createRun('s1', { timezone: 'Europe/Berlin' }), /cannot set a time zone or a language/)
  await assert.rejects(host.createRun('s2', { locale: 'de-DE', proxy: PROXY }), /cannot set a time zone or a language/)
  assert.equal(fake.commands('Target.createBrowserContext').length, before)
  assert.equal(forwarders.length, 0, 'not even a forwarder')
})

// ---- signing --------------------------------------------------------------------------------------------------------

import { generateSigningKey, createRequestSigner } from '../web-bot-auth.js'

const signingKey = generateSigningKey()
const signingHost = (mode: 'optional' | 'always') => ({
  mode,
  signer: createRequestSigner({ key: signingKey.privateJwk, agent: 'https://box.example.com' })
})

async function signingWorld(mode?: 'optional' | 'always') {
  const fake = createFakeChromium()
  fake.createTarget({ url: 'about:blank' })
  const created: Array<unknown> = []
  const scope = createCdpScope({ upstream: { send: fake.receive } })
  const real = scope.createRun
  scope.createRun = ((runKey: string, context?: unknown) => {
    created.push(context)
    return real(runKey, context as never)
  }) as typeof scope.createRun
  fake.onMessage(scope.onUpstreamMessage)
  await scope.start()
  await fake.flush()
  return { created, host: createScopeHost(scope, mode ? { signing: signingHost(mode) } : {}) }
}

test('scope host: a slot is signed when it asks, or when the node always signs, and in no other case', async () => {
  const optional = await signingWorld('optional')
  await optional.host.createRun('a')
  await optional.host.createRun('b', { signRequests: true })
  await optional.host.createRun('c', { signRequests: false })
  assert.equal(optional.created[0], undefined, 'optional: a slot that did not ask is made plain')
  assert.equal(typeof (optional.created[1] as { sign?: unknown }).sign, 'function', 'one that asked is signed')
  assert.equal(optional.created[2], undefined)

  const always = await signingWorld('always')
  await always.host.createRun('a')
  assert.equal(typeof (always.created[0] as { sign?: unknown }).sign, 'function', 'always: every slot')
  await assert.rejects(always.host.createRun('b', { signRequests: false }), /cannot leave one unsigned/)

  const off = await signingWorld()
  await off.host.createRun('a')
  await off.host.createRun('b', { signRequests: false })
  assert.deepEqual(off.created, [undefined, undefined])
  await assert.rejects(off.host.createRun('c', { signRequests: true }), /does not sign requests/)
  assert.equal(off.created.length, 2, 'and nothing was made for the one that could not be')
})

test('scope host: the signer produces headers for the URL it is given, with the proxy and signing side by side', async () => {
  const world = await signingWorld('always')
  await world.host.createRun('s', { proxy: { server: 'http://proxy.example.com:8080' } }).catch(() => undefined)
  const context = world.created[0] as { sign: (url: string) => Record<string, string>; proxyServer?: string }
  const headers = context.sign('https://example.com/')
  assert.deepEqual(Object.keys(headers).sort(), ['signature', 'signature-agent', 'signature-input'])
  assert.match(headers['signature-input']!, new RegExp(`keyid="${signingKey.keyid}"`))
  assert.match(context.proxyServer ?? '', /^socks5:\/\/127\./, 'the proxy forwarder is there too')
  await world.host.disposeRun('s')
})
