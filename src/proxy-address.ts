/**
 * Where a slot's proxy may point.
 *
 * A proxy is somewhere a node sends a slot's traffic, and sends it as itself: a node that dials `127.0.0.1` reaches its own
 * services (the all-in-one relay, another slot's proxy forwarder), and one that dials `169.254.169.254` reaches the cloud's
 * metadata service. So an address that names the machine or its link is refused, however it is spelled. `127.1`,
 * `0x7f000001`, `2130706433` and `[::ffff:7f00:1]` all mean loopback to a resolver, so the check is made on what the
 * address parses to and not on the text, and the node checks again on what a name resolves to, which is the check that
 * cannot be talked round (a name can point at 127.0.0.1 whatever it looks like).
 *
 * Private ranges (10/8, 192.168/16, 100.64/10) stay allowed: an office proxy, a cluster's own squid and a Tailscale
 * address are all proxies a box is meant to use. A cluster that wants them out says so in its network policy.
 */
import { isIP } from 'node:net'

export type ProxyScheme = 'http' | 'https' | 'socks5'

export interface ProxyServer {
  scheme: ProxyScheme
  /** A name or an address, without the brackets an IPv6 address is written in. */
  host: string
  port: number
}

/** `scheme://host:port` and nothing else: no user name or password (they have their own fields), no path, no query. */
const PROXY_SERVER = /^(https?|socks5):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?):(\d{1,5})$/

export function parseProxyServer(value: unknown): ProxyServer | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined
  const match = PROXY_SERVER.exec(value)
  if (!match) return undefined
  const port = Number(match[3])
  if (port < 1 || port > 65_535) return undefined
  const host = match[2]!
  return { scheme: match[1] as ProxyScheme, host: host.startsWith('[') ? host.slice(1, -1) : host, port }
}

const ipv4Parts = (ip: string) => (isIP(ip) === 4 ? ip.split('.').map(Number) : undefined)

/** 0/8 (this host), 127/8 (loopback) and 169.254/16 (link-local, and the cloud metadata address in it). */
const forbiddenIPv4 = ([a, b]: number[]) => a === 0 || a === 127 || (a === 169 && b === 254)

/** The sixteen bytes of an IPv6 address, in any spelling `isIP` accepts. */
function ipv6Bytes(ip: string): number[] | undefined {
  if (isIP(ip) !== 6) return undefined
  let text = ip.split('%')[0]!
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', rest] = text.split('::')
  const front = head ? head.split(':') : []
  const back = rest ? rest.split(':') : []
  const fill = rest === undefined ? [] : Array<string>(8 - front.length - back.length).fill('0')
  return [...front, ...fill, ...back].flatMap((group) => {
    const value = parseInt(group, 16)
    return [value >> 8, value & 0xff]
  })
}

function forbiddenIPv6(bytes: number[]) {
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0)
  // fe80::/10, link-local.
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return true
  // ::, ::1 and the old IPv4-compatible ::a.b.c.d: whatever the last four bytes say as an IPv4 address.
  if (zeros(0, 12)) return forbiddenIPv4(bytes.slice(12))
  // ::ffff:a.b.c.d, an IPv4 address written as IPv6: the same address.
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return forbiddenIPv4(bytes.slice(12))
  // 64:ff9b::/96, NAT64: an IPv4 address behind a translator, which reaches whatever that address is.
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) {
    return forbiddenIPv4(bytes.slice(12))
  }
  return false
}

/** True for an IP address that names this machine or its link. A name is not an address: this says false for one. */
export function isForbiddenIp(ip: string): boolean {
  const v4 = ipv4Parts(ip)
  if (v4) return forbiddenIPv4(v4)
  const v6 = ipv6Bytes(ip)
  return v6 ? forbiddenIPv6(v6) : false
}

/**
 * True for a host that is, or can be told by its spelling to be, this machine or its link. The URL parser's own reading of
 * the host is used, so every spelling a resolver would accept as an address is read as one.
 */
export function isForbiddenProxyHost(host: string): boolean {
  const name = host.toLowerCase()
  let normalized: string
  try {
    normalized = new URL(`http://${name.includes(':') && !name.startsWith('[') ? `[${name}]` : name}`).hostname
  } catch {
    return true
  }
  if (normalized.startsWith('[')) normalized = normalized.slice(1, -1)
  normalized = normalized.replace(/\.$/, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === 'ip6-localhost' || normalized === 'ip6-loopback') return true
  return isForbiddenIp(normalized)
}

/**
 * Whether Chromium proxy rules (`host:port`, `scheme://host:port`, `http=a:1;https=b:2`, `a:1,b:2`, `direct://`) name only
 * IP addresses that are allowed. For a client that chooses its own proxy for a context of its own: a rule it cannot be trusted
 * with is refused whole. A name is refused too, however harmless it looks: Chromium resolves it itself, and a name can point
 * at 127.0.0.1 (where another slot's forwarder listens), which no check of the spelling can see.
 */
export function proxyRulesAllowed(rules: string): boolean {
  for (const part of rules.split(';')) {
    const list = part.trim().replace(/^[A-Za-z]+=/, '')
    if (!list) continue
    for (const entry of list.split(',')) {
      const server = entry.trim()
      if (server.toLowerCase() === 'direct://') continue
      const bare = server.replace(/^[A-Za-z0-9]+:\/\//, '')
      if (!bare || bare.includes('@') || bare.includes('/')) return false
      const host = bare.startsWith('[') ? bare.slice(1, bare.indexOf(']')) : bare.replace(/:\d*$/, '')
      if (!host || !isIP(host) || isForbiddenIp(host)) return false
    }
  }
  return true
}
