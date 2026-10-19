/**
 * What a slot may ask of its browser, and the one place that says what a valid ask is.
 *
 * The relay checks a request with it (so a bad value is a 400 that says what is wrong, before any node is bothered), and a node
 * checks again what the relay sends (a timezone becomes an environment variable and a proxy becomes a listener, so the node
 * does not rely on the wire being right). Neither message ever repeats a credential: a proxy password that is wrong in some
 * way is called wrong, not quoted.
 */
import { LABEL_LIMITS, NAME_PATTERN, NODE_FEATURE, type ProxySettings, type SlotOptions } from './protocol.js'
import { isForbiddenProxyHost, parseProxyServer } from './proxy-address.js'

/**
 * A node cannot make the slot as it was asked (a time zone it does not have). Its message says so to
 * the person who asked, and never repeats a credential, so the agent passes it on in `context.failed` with `refused`.
 */
export class SlotRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlotRefusedError'
  }
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value })
const bad = (message: string): Parsed<never> => ({ ok: false, message })

/** Every field of a slot request that is not the plain three, with the options a node acts on first. */
export const OPTION_FIELDS = ['proxy', 'timezone', 'locale'] as const
export const REQUEST_FIELDS = ['runId', 'maxLifetimeSeconds', 'waitMs', ...OPTION_FIELDS, 'nodeLabels'] as const

/** A field name from the wire, safe to put in a message. */
const shown = (name: string) => JSON.stringify(name.slice(0, 40))

const hasControl = (text: string) => /[\u0000-\u001f\u007f]/.test(text)
/** SOCKS5's user/password sub-negotiation (RFC 1929) carries each in at most 255 bytes, so that is the limit for both. */
const MAX_CREDENTIAL_BYTES = 255
const MAX_BYPASS_CHARS = 1024

export function parseProxySettings(value: unknown): Parsed<ProxySettings> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return bad('proxy must be an object with a server, and optionally a username, a password and a bypass list')
  }
  const known = new Set(['server', 'username', 'password', 'bypass'])
  for (const name of Object.keys(value)) if (!known.has(name)) return bad(`proxy has no field ${shown(name)}`)
  const { server, username, password, bypass } = value as Record<string, unknown>

  const parsed = parseProxyServer(server)
  if (!parsed) {
    return bad(
      'proxy.server must be http://host:port, https://host:port or socks5://host:port, with no user name, password or path in it (those have their own fields)'
    )
  }
  if (isForbiddenProxyHost(parsed.host)) {
    return bad('proxy.server must not be a loopback, unspecified or link-local address')
  }

  const result: ProxySettings = { server: server as string }
  for (const [name, text] of [
    ['username', username],
    ['password', password]
  ] as const) {
    if (text === undefined) continue
    if (typeof text !== 'string' || hasControl(text))
      return bad(`proxy.${name} must be text without control characters`)
    if (Buffer.byteLength(text) > MAX_CREDENTIAL_BYTES)
      return bad(`proxy.${name} may be at most ${MAX_CREDENTIAL_BYTES} bytes`)
    result[name] = text
  }
  if (result.password !== undefined && result.username === undefined) return bad('proxy.password needs proxy.username')
  // HTTP Basic joins them with a colon, so a colon in the name could not be told from the end of it.
  if (result.username?.includes(':')) return bad('proxy.username must not contain a colon')

  if (bypass !== undefined) {
    if (typeof bypass !== 'string' || hasControl(bypass) || bypass.length > MAX_BYPASS_CHARS) {
      return bad(`proxy.bypass must be text of up to ${MAX_BYPASS_CHARS} characters, without control characters`)
    }
    result.bypass = bypass
  }
  return ok(result)
}

/** The IANA zone names by their lower-case spelling, in the case the zone database writes them (and `UTC`, which ICU does not list). */
const ZONE_CASE = new Map<string, string>([
  ...Intl.supportedValuesOf('timeZone').map((zone): [string, string] => [zone.toLowerCase(), zone]),
  ['utc', 'UTC']
])

/**
 * A time zone by its IANA name. Put in the case the zone database spells it (`europe/berlin` is `Europe/Berlin`), because it
 * becomes the browser's TZ and a lower-case name is not a file there. Otherwise the name is kept as given: ICU would turn
 * `America/Argentina/Buenos_Aires` into its older link `America/Buenos_Aires`, which a slim system may not have.
 */
export function parseTimezone(value: unknown): Parsed<string> {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value) ||
    value.length > 64
  ) {
    return bad('timezone must be an IANA time zone name such as Europe/Berlin or UTC')
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
  } catch {
    return bad('timezone is not a time zone this system knows: use an IANA name such as Europe/Berlin or UTC')
  }
  return ok(ZONE_CASE.get(value.toLowerCase()) ?? value)
}

/** A language tag such as `de-DE`, in its canonical spelling. */
export function parseLocale(value: unknown): Parsed<string> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{2,35}$/.test(value)) {
    return bad('locale must be a language tag such as en-US or de-DE')
  }
  try {
    const canonical = Intl.getCanonicalLocales(value)
    if (canonical.length === 1) return ok(canonical[0]!)
  } catch {
    // falls through to the message below
  }
  return bad('locale must be a language tag such as en-US or de-DE')
}

/** The labels a slot requires of its node. */
export function parseNodeLabels(value: unknown): Parsed<string[]> {
  if (!Array.isArray(value)) return bad('nodeLabels must be a list of labels')
  if (value.length > LABEL_LIMITS.maxRequired)
    return bad(`nodeLabels may name at most ${LABEL_LIMITS.maxRequired} labels`)
  for (const label of value) {
    if (typeof label !== 'string' || label.length > LABEL_LIMITS.maxLength || !NAME_PATTERN.test(label)) {
      return bad(`a label is letters, digits, "_", "." and "-", up to ${LABEL_LIMITS.maxLength} characters`)
    }
  }
  return ok([...new Set(value as string[])])
}

/** The options of a slot request: `proxy`, `timezone` and `locale`, each checked. Fields that are not options are not looked at. */
export function parseSlotOptions(input: Record<string, unknown>): Parsed<SlotOptions> {
  const options: SlotOptions = {}
  if (input.proxy !== undefined) {
    const proxy = parseProxySettings(input.proxy)
    if (!proxy.ok) return proxy
    options.proxy = proxy.value
  }
  if (input.timezone !== undefined) {
    const timezone = parseTimezone(input.timezone)
    if (!timezone.ok) return timezone
    options.timezone = timezone.value
  }
  if (input.locale !== undefined) {
    const locale = parseLocale(input.locale)
    if (!locale.ok) return locale
    options.locale = locale.value
  }
  return ok(options)
}

/**
 * The `options` a node was sent, as the node reads them: the same checks, and a field it has never heard of is an error, not
 * something to skip, because a node that skipped one would make a slot without it.
 */
export function parseNodeSlotOptions(value: unknown): Parsed<SlotOptions> {
  if (value === undefined) return ok({})
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad('options must be an object')
  const fields = new Set<string>(OPTION_FIELDS)
  for (const name of Object.keys(value))
    if (!fields.has(name)) return bad(`this node does not know the option ${shown(name)}`)
  return parseSlotOptions(value as Record<string, unknown>)
}

/** The node features (NODE_FEATURE) that serving these options takes. */
export function featuresFor(options: SlotOptions): string[] {
  const features: string[] = []
  if (options.proxy) features.push(NODE_FEATURE.proxy)
  if (options.timezone !== undefined || options.locale !== undefined) features.push(NODE_FEATURE.locale)
  return features
}

/** The names of the request's options that a slot with these options and labels has, for `applied` in the response. */
export function appliedNames(options: SlotOptions, nodeLabels: string[]): string[] {
  return [
    ...OPTION_FIELDS.filter((name) => options[name] !== undefined),
    ...(nodeLabels.length > 0 ? ['nodeLabels'] : [])
  ]
}

/** What a hello's labels may be: the names a node's operator gave it, each a valid label. */
export function sanitizeLabels(value: unknown, max: number = LABEL_LIMITS.maxPerNode): string[] {
  if (!Array.isArray(value)) return []
  const labels = value.filter(
    (label): label is string =>
      typeof label === 'string' && label.length <= LABEL_LIMITS.maxLength && NAME_PATTERN.test(label)
  )
  return [...new Set(labels)].slice(0, max)
}

/** What a hello's features may be: short names. A feature this relay has never heard of is kept: it only matters if asked for. */
export function sanitizeFeatures(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value.filter((feature): feature is string => typeof feature === 'string' && /^[\w.:-]{1,64}$/.test(feature))
    )
  ].slice(0, 32)
}
