import assert from 'node:assert/strict'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import test from 'node:test'
import { contextProxy, startProxyForwarder, type ProxyForwarder } from './proxy-forwarder.js'

const servers: Server[] = []
const forwarders: ProxyForwarder[] = []
test.afterEach(async () => {
  for (const forwarder of forwarders.splice(0)) await forwarder.close()
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
})

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })

/** The destination every fake proxy tunnels to, whatever it was asked for: echoes what it is sent. */
async function echo() {
  const server = createServer((socket) => {
    socket.on('error', () => undefined)
    socket.pipe(socket)
  })
  return listen(server)
}

/** Reads exact numbers of bytes from a socket in a test. */
function reader(socket: Socket) {
  let buffer = Buffer.alloc(0)
  let wake: (() => void) | undefined
  let closed = false
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    wake?.()
  })
  socket.on('close', () => {
    closed = true
    wake?.()
  })
  socket.on('error', () => undefined)
  return {
    /** The bytes, or undefined when the socket closed first. */
    async read(count: number, ms = 3000): Promise<Buffer | undefined> {
      const end = Date.now() + ms
      while (buffer.length < count) {
        if (closed) return undefined
        if (Date.now() > end) throw new Error(`timed out waiting for ${count} bytes`)
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, 50)
        })
      }
      const out = buffer.subarray(0, count)
      buffer = buffer.subarray(count)
      return out
    },
    get closed() {
      return closed
    }
  }
}

/** A fake proxy that speaks HTTP CONNECT, checks `Proxy-Authorization` when it wants credentials, and records what it was asked. */
async function httpProxy({ credentials, destination }: { credentials?: string; destination: number }) {
  const requests: Array<{ line: string; auth?: string }> = []
  let connections = 0
  const server = createServer((client) => {
    connections++
    client.on('error', () => undefined)
    let data = Buffer.alloc(0)
    client.on('data', function onData(chunk) {
      data = Buffer.concat([data, chunk])
      const end = data.indexOf('\r\n\r\n')
      if (end === -1) return
      client.off('data', onData)
      const [line = '', ...headers] = data.subarray(0, end).toString().split('\r\n')
      const auth = headers.find((header) => /^proxy-authorization:/i.test(header))?.split(': ')[1]
      requests.push({ line, auth })
      if (credentials !== undefined && auth !== `Basic ${Buffer.from(credentials).toString('base64')}`) {
        return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n')
      }
      const upstream = connect(destination, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n')
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.on('error', () => client.destroy())
    })
  })
  const port = await listen(server)
  return { port, requests, connections: () => connections }
}

/** A fake SOCKS5 proxy, with user/password authentication when it is given credentials. */
async function socksProxy({ credentials, destination }: { credentials?: [string, string]; destination: number }) {
  const requests: Array<{ atyp: number; host: string; port: number }> = []
  const server = createServer(async (client) => {
    client.on('error', () => undefined)
    const input = reader(client)
    const greeting = await input.read(2)
    if (!greeting) return
    const methods = await input.read(greeting[1]!)
    if (!methods) return
    if (credentials) {
      client.write(Buffer.from([5, 2]))
      const head = await input.read(2)
      const user = await input.read(head![1]!)
      const passLength = await input.read(1)
      const pass = await input.read(passLength![0]!)
      const good = user!.toString() === credentials[0] && pass!.toString() === credentials[1]
      client.write(Buffer.from([1, good ? 0 : 1]))
      if (!good) return void client.end()
    } else {
      client.write(Buffer.from([5, 0]))
    }
    const request = await input.read(4)
    if (!request) return
    const atyp = request[3]!
    let host = ''
    if (atyp === 3) {
      const length = (await input.read(1))![0]!
      host = (await input.read(length))!.toString()
    } else if (atyp === 1) host = [...(await input.read(4))!].join('.')
    else host = (await input.read(16))!.toString('hex')
    const port = (await input.read(2))!.readUInt16BE(0)
    requests.push({ atyp, host, port })
    const upstream = connect(destination, '127.0.0.1', () => {
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
      client.pipe(upstream)
      upstream.pipe(client)
    })
    upstream.on('error', () => client.destroy())
  })
  const port = await listen(server)
  return { port, requests }
}

const allowAll = { isForbidden: () => false }

async function forwarderFor(settings: Parameters<typeof startProxyForwarder>[0], options = {}) {
  const forwarder = await startProxyForwarder(settings, { ...allowAll, connectTimeoutMs: 2000, ...options })
  forwarders.push(forwarder)
  const { hostname, port } = new URL(forwarder.url.replace('socks5://', 'http://'))
  return { forwarder, host: hostname, port: Number(port) }
}

/** What Chromium does: SOCKS5 with no authentication, CONNECT to a host name. Resolves with the reply code and the socket. */
async function socksClient(
  at: { host: string; port: number },
  destination: { name?: string; atyp?: number; raw?: Buffer; port?: number } = {}
) {
  const socket = connect(at.port, at.host)
  const input = reader(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write(Buffer.from([5, 1, 0]))
  const accepted = await input.read(2)
  assert.deepEqual([...accepted!], [5, 0])
  const atyp = destination.atyp ?? 3
  const raw =
    destination.raw ??
    Buffer.concat([
      Buffer.from([(destination.name ?? 'example.test').length]),
      Buffer.from(destination.name ?? 'example.test')
    ])
  const port = Buffer.alloc(2)
  port.writeUInt16BE(destination.port ?? 443)
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, atyp]), raw, port]))
  const answer = await input.read(10)
  return { socket, input, reply: answer ? answer[1]! : undefined }
}

test('through an HTTP proxy: the forwarder adds the credentials, and what is sent is tunnelled', async () => {
  const destination = await echo()
  const proxy = await httpProxy({ credentials: 'user:p:ss word', destination })
  const at = await forwarderFor({ server: `http://127.0.0.1:${proxy.port}`, username: 'user', password: 'p:ss word' })

  const { socket, input, reply } = await socksClient(at, { name: 'shop.example.test', port: 443 })
  assert.equal(reply, 0, 'the tunnel is open')
  socket.write('hello through the proxy')
  assert.equal((await input.read(23))!.toString(), 'hello through the proxy')
  assert.deepEqual(proxy.requests, [
    {
      line: 'CONNECT shop.example.test:443 HTTP/1.1',
      auth: `Basic ${Buffer.from('user:p:ss word').toString('base64')}`
    }
  ])
  socket.destroy()
})

test('an HTTP proxy that refuses the credentials is a failed connection, never a login prompt, and says so once', async () => {
  const destination = await echo()
  const proxy = await httpProxy({ credentials: 'user:right', destination })
  const warnings: string[] = []
  const at = await forwarderFor(
    { server: `http://127.0.0.1:${proxy.port}`, username: 'user', password: 'wrong-hunter2' },
    { logger: { warn: (message: string) => warnings.push(message) } }
  )
  for (let i = 0; i < 2; i++) {
    const { reply, input } = await socksClient(at)
    assert.equal(reply, 1, 'general failure: the page gets a failed connection')
    assert.equal(await input.read(1), undefined, 'and the connection is closed')
  }
  assert.equal(warnings.length, 1, 'said once, not per connection')
  assert.ok(
    !warnings.join('').includes('hunter2') && !warnings.join('').includes('user'),
    'a credential is never logged'
  )
})

test('an HTTP proxy with no credentials is asked for none', async () => {
  const destination = await echo()
  const proxy = await httpProxy({ destination })
  const at = await forwarderFor({ server: `http://127.0.0.1:${proxy.port}` })
  const { socket, reply } = await socksClient(at)
  assert.equal(reply, 0)
  assert.equal(proxy.requests[0]!.auth, undefined)
  socket.destroy()
})

test('through a SOCKS5 proxy: it signs in with the credentials and the destination is passed on', async () => {
  const destination = await echo()
  const proxy = await socksProxy({ credentials: ['user', 'secret'], destination })
  const at = await forwarderFor({ server: `socks5://127.0.0.1:${proxy.port}`, username: 'user', password: 'secret' })
  const { socket, input, reply } = await socksClient(at, { name: 'a.example.test', port: 8443 })
  assert.equal(reply, 0)
  socket.write('ping')
  assert.equal((await input.read(4))!.toString(), 'ping')
  assert.deepEqual(proxy.requests, [{ atyp: 3, host: 'a.example.test', port: 8443 }])
  socket.destroy()

  const refused = await forwarderFor({ server: `socks5://127.0.0.1:${proxy.port}`, username: 'user', password: 'nope' })
  assert.equal((await socksClient(refused)).reply, 1)
})

test('through a SOCKS5 proxy that wants no sign-in, and for an address destination', async () => {
  const destination = await echo()
  const proxy = await socksProxy({ destination })
  const at = await forwarderFor({ server: `socks5://127.0.0.1:${proxy.port}` })
  const v4 = await socksClient(at, { atyp: 1, raw: Buffer.from([203, 0, 113, 9]), port: 80 })
  assert.equal(v4.reply, 0)
  v4.socket.destroy()
  const v6 = await socksClient(at, {
    atyp: 4,
    raw: Buffer.from('20010db8000000000000000000000001', 'hex'),
    port: 443
  })
  assert.equal(v6.reply, 0)
  v6.socket.destroy()
  assert.deepEqual(
    proxy.requests.map(({ atyp, host, port }) => [atyp, port, atyp === 1 ? host : '']),
    [
      [1, 80, '203.0.113.9'],
      [4, 443, '']
    ]
  )
})

test('a proxy that is, or resolves to, this machine is never connected to', async () => {
  const destination = await echo()
  const proxy = await httpProxy({ destination })
  // The real guard, not the test's: the fake proxy is on loopback.
  const literal = await startProxyForwarder({ server: `http://127.0.0.1:${proxy.port}` }, { connectTimeoutMs: 2000 })
  forwarders.push(literal)
  const at = (forwarder: ProxyForwarder) => {
    const { hostname, port } = new URL(forwarder.url.replace('socks5://', 'http://'))
    return { host: hostname, port: Number(port) }
  }
  assert.equal((await socksClient(at(literal))).reply, 2, 'not allowed by the ruleset')

  // A name that points at loopback: what it resolves to is what is checked, so the name does not matter.
  const rebound = await startProxyForwarder(
    { server: `http://proxy.example.test:${proxy.port}` },
    { connectTimeoutMs: 2000, lookup: async () => ['127.0.0.1'] }
  )
  forwarders.push(rebound)
  assert.equal((await socksClient(at(rebound))).reply, 2)
  assert.equal(proxy.connections(), 0, 'nothing reached the proxy on loopback')

  // And a name that cannot be found is an unreachable proxy, not a crash.
  const missing = await startProxyForwarder(
    { server: 'http://nowhere.example.test:3128' },
    { connectTimeoutMs: 2000, lookup: async () => [] }
  )
  forwarders.push(missing)
  assert.equal((await socksClient(at(missing))).reply, 4)
})

test('what is not a SOCKS5 CONNECT to a plain destination is refused or dropped', async () => {
  const destination = await echo()
  const proxy = await httpProxy({ destination })
  const at = await forwarderFor({ server: `http://127.0.0.1:${proxy.port}` })

  // A page speaks HTTP, not SOCKS5: the first byte tells, and the connection is dropped without an answer.
  const http = connect(at.port, at.host)
  const httpInput = reader(http)
  http.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n')
  assert.equal(await httpInput.read(1), undefined)

  // A destination name that could carry a second header upstream is refused (8: address type not supported).
  for (const name of ['evil.test\r\nX-Injected: 1', 'has space.test', 'a/b', 'x'.repeat(254)]) {
    if (name.length > 255) continue
    const refused = await socksClient(at, { name })
    assert.equal(refused.reply, 8, JSON.stringify(name))
  }
  assert.equal((await socksClient(at, { name: 'ok.test', port: 0 })).reply, 8, 'port 0 is not a port')
  assert.equal(proxy.requests.length, 0, 'none of it reached the proxy')

  // Only CONNECT: UDP associate (3) and BIND (2) are not on offer (7).
  for (const command of [2, 3]) {
    const socket = connect(at.port, at.host)
    const input = reader(socket)
    socket.write(Buffer.from([5, 1, 0]))
    await input.read(2)
    socket.write(Buffer.concat([Buffer.from([5, command, 0, 1, 1, 2, 3, 4]), Buffer.from([0, 80])]))
    assert.equal((await input.read(10))![1], 7, `command ${command}`)
  }

  // A client that wants authentication and offers nothing else gets "no acceptable method" (0xff).
  const picky = connect(at.port, at.host)
  const pickyInput = reader(picky)
  picky.write(Buffer.from([5, 1, 2]))
  assert.deepEqual([...(await pickyInput.read(2))!], [5, 0xff])
})

test('close() ends the listener and every tunnel through it', async () => {
  const destination = await echo()
  const proxy = await httpProxy({ destination })
  const { forwarder, ...at } = await forwarderFor({ server: `http://127.0.0.1:${proxy.port}` })
  const open = await socksClient(at)
  assert.equal(open.reply, 0)
  await forwarder.close()
  assert.equal(await open.input.read(1), undefined, 'the open tunnel was closed')
  await assert.rejects(socksClient(at), 'nothing listens any more')
  await forwarder.close() // twice is fine
})

test('a forwarder carries only so many connections at once', async () => {
  const destination = await echo()
  const proxy = await httpProxy({ destination })
  const at = await forwarderFor({ server: `http://127.0.0.1:${proxy.port}` }, { maxConnections: 1 })
  const first = await socksClient(at)
  assert.equal(first.reply, 0)
  const second = connect(at.port, at.host)
  const input = reader(second)
  second.write(Buffer.from([5, 1, 0]))
  assert.equal(await input.read(2), undefined, 'the second is dropped')
})

test('each slot gets a forwarder of its own, on loopback, that no address in its URL gives away the proxy of', async () => {
  const one = await startProxyForwarder(
    { server: 'http://proxy.example.test:3128', username: 'u', password: 'p' },
    allowAll
  )
  const two = await startProxyForwarder({ server: 'http://proxy.example.test:3128' }, allowAll)
  forwarders.push(one, two)
  for (const forwarder of [one, two]) assert.match(forwarder.url, /^socks5:\/\/127\.\d+\.\d+\.\d+:\d+$/)
  assert.notEqual(one.url, two.url)
  assert.ok(
    !one.url.includes('proxy.example.test') && !one.url.includes('p@'),
    'the context is told nothing of the real proxy'
  )
  await assert.rejects(startProxyForwarder({ server: 'not a proxy' }), /not valid/)
})

test('the context is made with the forwarder, and a bypass list that does not leave loopback to Chromium', () => {
  const forwarder = { url: 'socks5://127.5.6.7:4000', close: async () => undefined }
  assert.deepEqual(contextProxy(forwarder, { server: 'http://p.example:1' }), {
    proxyServer: 'socks5://127.5.6.7:4000',
    proxyBypassList: '<-loopback>'
  })
  assert.deepEqual(contextProxy(forwarder, { server: 'http://p.example:1', bypass: '*.internal.test;10.0.0.0/8' }), {
    proxyServer: 'socks5://127.5.6.7:4000',
    proxyBypassList: '<-loopback>;*.internal.test;10.0.0.0/8'
  })
})

test('an address that cannot be bound is not the end of the slot: the forwarder falls back to 127.0.0.1', async () => {
  // 192.0.2.1 (TEST-NET-1) is on no interface, so listening on it fails with EADDRNOTAVAIL, as a random 127.x.y.z does where
  // the loopback holds only 127.0.0.1.
  const forwarder = await startProxyForwarder(
    { server: 'http://203.0.113.5:8080' },
    { lookup: async () => ['203.0.113.5'], bindHost: '192.0.2.1' }
  )
  forwarders.push(forwarder)
  assert.match(forwarder.url, /^socks5:\/\/127\.0\.0\.1:\d+$/)
})
