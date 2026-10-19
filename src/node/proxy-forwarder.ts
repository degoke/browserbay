/**
 * A slot's proxy, reached through a forwarder the node runs for it.
 *
 * Chromium takes a proxy per browser context, but it takes no credentials for one over DevTools (the one way is to answer
 * its auth challenges page by page, which means holding the password in the browser's reach) and it speaks no SOCKS5
 * authentication at all. So the node does not give Chromium the proxy. It gives it this: a SOCKS5 listener on loopback, with
 * no authentication, that opens each connection to the real proxy itself and adds the credentials there.
 *
 *   Chromium ──socks5, no auth──▶ forwarder (this node, loopback) ──http CONNECT / https CONNECT / socks5 + auth──▶ proxy
 *
 *   - Chromium never holds the credentials, and a page cannot read them or be shown a proxy login. A proxy that refuses them
 *     (407) is a connection that fails, which is what the page sees; it is never a dialog.
 *   - Every slot gets a forwarder of its own, on a random port (on Linux, at a random address in 127/8). A page speaks HTTP, not
 *     SOCKS5, so it cannot use one by accident; one that went looking would have to find it first.
 *   - The proxy's name is resolved here, once per connection, and what it resolved to is checked and then connected to. The
 *     check that matters is on the address, not the name: a name can be made to point at 127.0.0.1, where another slot's
 *     forwarder is listening, and a name checked and then resolved again is a name that can change in between.
 *   - It is a tunnel and nothing else: it parses the SOCKS5 greeting and one CONNECT, then copies bytes. A destination that is not
 *     a plain host name or address is refused, so what a client of the forwarder sends cannot become a header upstream.
 *
 * Nothing here logs an address a slot connected to, or a credential.
 */
import { randomInt } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { connect as netConnect, createServer, isIP, type Server, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { ProxySettings } from '../protocol.js'
import { isForbiddenIp, parseProxyServer, type ProxyServer } from '../proxy-address.js'
import type { RequestSigner } from '../web-bot-auth.js'
import type { RunContext } from './scope.js'

export interface ProxyForwarder {
  /** What Chromium is told: `socks5://127.x.y.z:port`. */
  url: string
  close(): Promise<void>
}

export interface ProxyForwarderOptions {
  logger?: { warn?(message: string, fields?: Record<string, unknown>): void }
  /** For tests: how the proxy's name becomes addresses. */
  lookup?: (host: string) => Promise<string[]>
  /** For tests: which addresses may not be connected to. Defaults to loopback, unspecified and link-local. */
  isForbidden?: (ip: string) => boolean
  /** How long a connection to the proxy, and its answer, may take (default 10 s). */
  connectTimeoutMs?: number
  /** The most connections one forwarder carries at once (default 256). */
  maxConnections?: number
  /** For tests: the address to listen on first (default a random one in 127/8 on Linux, else 127.0.0.1). */
  bindHost?: string
}

const VERSION = 5
/** Replies of a SOCKS5 server (RFC 1928). */
const REPLY = {
  ok: 0,
  failure: 1,
  notAllowed: 2,
  unreachable: 4,
  refused: 5,
  commandUnsupported: 7,
  addressUnsupported: 8
}

/** A failure to reach the destination through the proxy, with the SOCKS5 reply that tells Chromium why. */
class TunnelError extends Error {
  readonly reply: number
  constructor(reply: number, message: string) {
    super(message)
    this.reply = reply
  }
}

const defaultLookup = async (host: string) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address)

/** Reads exact numbers of bytes from a socket that is not yet a tunnel, with a deadline. */
function byteReader(socket: Socket, timeoutMs: number) {
  let buffer = Buffer.alloc(0)
  let wake: (() => void) | undefined
  let ended = false
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    wake?.()
  }
  const onEnd = () => {
    ended = true
    wake?.()
  }
  socket.on('data', onData)
  socket.on('close', onEnd)
  socket.on('error', onEnd)
  return {
    async read(count: number): Promise<Buffer> {
      const deadline = Date.now() + timeoutMs
      while (buffer.length < count) {
        if (ended) throw new TunnelError(REPLY.refused, 'The proxy closed the connection')
        const left = deadline - Date.now()
        if (left <= 0) throw new TunnelError(REPLY.unreachable, 'The proxy did not answer in time')
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
      const out = buffer.subarray(0, count)
      buffer = buffer.subarray(count)
      return out
    },
    /** Everything read ahead and not asked for, and stops reading: the socket is the caller's again. */
    release(): Buffer {
      socket.off('data', onData)
      socket.off('close', onEnd)
      socket.off('error', onEnd)
      // An error between here and the caller attaching its own handler must not be an unhandled one.
      socket.on('error', () => undefined)
      socket.pause()
      return buffer
    },
    /** The head of an HTTP response: up to the blank line, the rest kept. */
    async readHead(): Promise<string> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end !== -1) {
          const head = buffer.subarray(0, end).toString('latin1')
          buffer = buffer.subarray(end + 4)
          return head
        }
        if (buffer.length > 16 * 1024) throw new TunnelError(REPLY.failure, 'The proxy sent too long an answer')
        if (ended) throw new TunnelError(REPLY.refused, 'The proxy closed the connection')
        const left = deadline - Date.now()
        if (left <= 0) throw new TunnelError(REPLY.unreachable, 'The proxy did not answer in time')
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
    }
  }
}

interface Destination {
  atyp: number
  /** The raw address bytes, in the form SOCKS5 sends them (a name is length-prefixed). */
  raw: Buffer
  /** For an HTTP CONNECT line. */
  hostPort: string
  port: Buffer
}

const ipv6Text = (bytes: Buffer) => {
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16))
  return groups.join(':')
}

/** A destination host name as Chromium sends one: letters, digits and a few separators, nothing that could be a header. */
const HOSTNAME = /^[A-Za-z0-9._~%-]{1,253}$/

export async function startProxyForwarder(
  settings: ProxySettings,
  options: ProxyForwarderOptions = {}
): Promise<ProxyForwarder> {
  const upstream = parseProxyServer(settings.server)
  if (!upstream) throw new Error('The proxy address is not valid')
  const {
    logger = {},
    lookup = defaultLookup,
    isForbidden = isForbiddenIp,
    connectTimeoutMs = 10_000,
    maxConnections = 256,
    bindHost: preferredHost
  } = options
  const credentials =
    settings.username === undefined ? undefined : { username: settings.username, password: settings.password ?? '' }
  let warnedAuth = false

  /** One address of the proxy that may be connected to, or a refusal. */
  async function resolveUpstream(server: ProxyServer): Promise<string> {
    const addresses = isIP(server.host) ? [server.host] : await lookup(server.host).catch(() => [] as string[])
    if (addresses.length === 0) throw new TunnelError(REPLY.unreachable, 'The proxy could not be found')
    const allowed = addresses.find((address) => !isForbidden(address))
    if (!allowed) throw new TunnelError(REPLY.notAllowed, 'The proxy resolves to an address a slot may not use')
    return allowed
  }

  /** A connection to the proxy and, over it, to the destination: returned once it is a tunnel, with any bytes already read. */
  async function openTunnel(destination: Destination): Promise<{ socket: Socket; ahead: Buffer }> {
    const address = await resolveUpstream(upstream!)
    const socket: Socket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.destroy()
        reject(new TunnelError(REPLY.unreachable, 'The proxy did not accept the connection in time'))
      }, connectTimeoutMs)
      const connection =
        upstream!.scheme === 'https'
          ? tlsConnect({
              host: address,
              port: upstream!.port,
              ...(isIP(upstream!.host) ? {} : { servername: upstream!.host })
            })
          : netConnect({ host: address, port: upstream!.port })
      connection.once(upstream!.scheme === 'https' ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer)
        resolve(connection)
      })
      connection.once('error', () => {
        clearTimeout(timer)
        reject(new TunnelError(REPLY.refused, 'Could not connect to the proxy'))
      })
    })
    const reader = byteReader(socket, connectTimeoutMs)
    try {
      if (upstream!.scheme === 'socks5') await socksHandshake(socket, reader, destination)
      else await httpConnect(socket, reader, destination)
    } catch (error) {
      reader.release()
      socket.destroy()
      throw error
    }
    return { socket, ahead: reader.release() }
  }

  async function httpConnect(socket: Socket, reader: ReturnType<typeof byteReader>, destination: Destination) {
    const auth = credentials
      ? `Proxy-Authorization: Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}\r\n`
      : ''
    socket.write(`CONNECT ${destination.hostPort} HTTP/1.1\r\nHost: ${destination.hostPort}\r\n${auth}\r\n`)
    const head = await reader.readHead()
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)
    const code = status ? Number(status[1]) : 0
    if (code >= 200 && code < 300) return
    if (code === 407) {
      if (!warnedAuth) logger.warn?.('A slot’s proxy refused its credentials')
      warnedAuth = true
      throw new TunnelError(REPLY.failure, 'The proxy refused the credentials')
    }
    if (code === 403) throw new TunnelError(REPLY.notAllowed, 'The proxy refused the destination')
    if (code === 502 || code === 503 || code === 504)
      throw new TunnelError(REPLY.unreachable, 'The proxy could not reach it')
    throw new TunnelError(REPLY.failure, 'The proxy did not open a tunnel')
  }

  async function socksHandshake(socket: Socket, reader: ReturnType<typeof byteReader>, destination: Destination) {
    socket.write(credentials ? Buffer.from([VERSION, 2, 0x00, 0x02]) : Buffer.from([VERSION, 1, 0x00]))
    const [version, method] = await reader.read(2)
    if (version !== VERSION || method === 0xff)
      throw new TunnelError(REPLY.failure, 'The proxy accepts no way to sign in')
    if (method === 0x02) {
      if (!credentials) throw new TunnelError(REPLY.failure, 'The proxy wants credentials')
      const user = Buffer.from(credentials.username)
      const pass = Buffer.from(credentials.password)
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
      const [, status] = await reader.read(2)
      if (status !== 0) {
        if (!warnedAuth) logger.warn?.('A slot’s proxy refused its credentials')
        warnedAuth = true
        throw new TunnelError(REPLY.failure, 'The proxy refused the credentials')
      }
    } else if (method !== 0x00) {
      throw new TunnelError(REPLY.failure, 'The proxy chose a way to sign in that was not offered')
    }
    socket.write(Buffer.concat([Buffer.from([VERSION, 1, 0, destination.atyp]), destination.raw, destination.port]))
    const [, reply, , atyp] = await reader.read(4)
    const remaining = atyp === 1 ? 6 : atyp === 4 ? 18 : atyp === 3 ? (await reader.read(1))[0]! + 2 : -1
    if (remaining < 0) throw new TunnelError(REPLY.failure, 'The proxy sent an answer that is not SOCKS5')
    await reader.read(remaining)
    if (reply !== REPLY.ok)
      throw new TunnelError(reply === 0 ? REPLY.failure : reply, 'The proxy could not open the connection')
  }

  // ---- the listener Chromium talks to -----------------------------------------------------------------------------

  const clients = new Set<Socket>()

  function handleClient(client: Socket) {
    if (clients.size >= maxConnections) return void client.destroy()
    clients.add(client)
    client.setNoDelay(true)
    client.on('close', () => clients.delete(client))
    client.on('error', () => client.destroy())
    // A client that does not finish the greeting is not a browser.
    client.setTimeout(connectTimeoutMs, () => client.destroy())

    let buffer = Buffer.alloc(0)
    let state: 'greeting' | 'request' | 'connecting' = 'greeting'
    const reply = (code: number) => client.write(Buffer.from([VERSION, code, 0, 1, 0, 0, 0, 0, 0, 0]))

    client.on('data', function onData(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk])
      if (state === 'greeting') {
        if (buffer.length < 2) return
        // The first byte is the one thing a page's HTTP cannot be: anything but a SOCKS5 greeting is dropped at once.
        if (buffer[0] !== VERSION) return void client.destroy()
        const count = buffer[1]!
        if (buffer.length < 2 + count) return
        const offersNoAuth = buffer.subarray(2, 2 + count).includes(0x00)
        buffer = buffer.subarray(2 + count)
        if (!offersNoAuth) {
          client.write(Buffer.from([VERSION, 0xff]))
          return void client.end()
        }
        client.write(Buffer.from([VERSION, 0x00]))
        state = 'request'
      }
      if (state !== 'request' || buffer.length < 4) return
      const [version, command, , atyp] = buffer as unknown as number[]
      if (version !== VERSION) return void client.destroy()
      let addressLength: number
      if (atyp === 1) addressLength = 4
      else if (atyp === 4) addressLength = 16
      else if (atyp === 3) {
        if (buffer.length < 5) return
        addressLength = 1 + buffer[4]!
      } else {
        reply(REPLY.addressUnsupported)
        return void client.end()
      }
      const total = 4 + addressLength + 2
      if (buffer.length < total) return
      if (command !== 1) {
        reply(REPLY.commandUnsupported)
        return void client.end()
      }
      const raw = buffer.subarray(4, 4 + addressLength)
      const port = buffer.subarray(4 + addressLength, total)
      const early = buffer.subarray(total)
      let host: string
      if (atyp === 1) host = [...raw].join('.')
      else if (atyp === 4) host = ipv6Text(raw)
      else host = raw.subarray(1).toString('latin1')
      if ((atyp === 3 && !HOSTNAME.test(host)) || port.readUInt16BE(0) === 0) {
        reply(REPLY.addressUnsupported)
        return void client.end()
      }
      const destination: Destination = {
        atyp: atyp!,
        raw: Buffer.from(raw),
        hostPort: `${atyp === 4 ? `[${host}]` : host}:${port.readUInt16BE(0)}`,
        port: Buffer.from(port)
      }
      state = 'connecting'
      client.off('data', onData)
      client.pause()
      void openTunnel(destination).then(
        ({ socket, ahead }) => {
          if (client.destroyed) return void socket.destroy()
          client.setTimeout(0)
          reply(REPLY.ok)
          socket.on('error', () => client.destroy())
          client.on('error', () => socket.destroy())
          client.on('close', () => socket.destroy())
          socket.on('close', () => client.destroy())
          if (ahead.length > 0) client.write(ahead)
          if (early.length > 0) socket.write(early)
          client.pipe(socket)
          socket.pipe(client)
          socket.resume()
          client.resume()
        },
        (error) => {
          if (client.destroyed) return
          reply(error instanceof TunnelError ? error.reply : REPLY.failure)
          client.end()
        }
      )
    })
  }

  let bindHost =
    preferredHost ??
    (process.platform === 'linux' ? `127.${randomInt(1, 255)}.${randomInt(0, 256)}.${randomInt(1, 255)}` : '127.0.0.1')
  const server: Server = createServer(handleClient)
  const listen = (host: string) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  try {
    await listen(bindHost)
  } catch (error) {
    // A loopback with only 127.0.0.1 on it (some sandboxes) cannot bind the others.
    if ((error as NodeJS.ErrnoException).code !== 'EADDRNOTAVAIL' || bindHost === '127.0.0.1') throw error
    bindHost = '127.0.0.1'
    await listen(bindHost)
  }
  server.on('error', () => undefined)
  const { port } = server.address() as { port: number }

  return {
    url: `socks5://${bindHost}:${port}`,
    async close() {
      for (const client of clients) client.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/**
 * What the hub is told to make a slot's context with: the forwarder, and a bypass list that starts with `<-loopback>`. Chromium
 * sends no request for localhost through a proxy unless that is said, and a slot that is meant to leave through its proxy
 * should not be able to reach the node's own loopback (the relay of a box, other slots' forwarders) just by asking for it.
 */
export function contextProxy(forwarder: ProxyForwarder, settings: ProxySettings): RunContext {
  return {
    proxyServer: forwarder.url,
    proxyBypassList: ['<-loopback>', settings.bypass].filter(Boolean).join(';')
  }
}

/**
 * What a run is created with: the forwarder's address when the slot has a proxy, and a way to sign when its requests are signed.
 * Nothing at all (`undefined`) for a plain slot, so its context is made as it always was.
 */
export function runContext(
  forwarder: ProxyForwarder | undefined,
  proxy: ProxySettings | undefined,
  signer: RequestSigner | undefined
): RunContext | undefined {
  const context: RunContext = {
    ...(forwarder ? contextProxy(forwarder, proxy!) : {}),
    ...(signer ? { sign: (url: string) => signer.sign(url) } : {})
  }
  return Object.keys(context).length > 0 ? context : undefined
}
