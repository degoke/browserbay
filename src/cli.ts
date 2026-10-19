#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { errorMessage } from './errors.js'
import { ConfigError, NAME_PATTERN, quotaProblem } from './protocol.js'

const HELP = `browserbay: self-hosted browsers for AI agents and automation

  browserbay start     the relay and a browser node in one process (the simplest box)
  browserbay relay     the relay alone (clients and remote nodes connect to it)
  browserbay node      a browser node alone (dials out to a relay)
  browserbay secret    make an enrollment secret for a node, and the entry the relay needs for it
  browserbay key       make an API key (with a name, also the entry the relay needs: see BROWSERBAY_API_KEYS)
  browserbay web-bot-auth   make the Ed25519 key a box signs its browsers' requests with (Web Bot Auth)

Settings are environment variables; see the README.`

const [command, ...args] = process.argv.slice(2)

const secret = () => randomBytes(24).toString('base64url')

// One of this package's own files is missing (an interrupted or stale build), as opposed to a damaged dependency.
const ownDir = fileURLToPath(new URL('.', import.meta.url))
const isBuildIncomplete = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_MODULE_NOT_FOUND' &&
  /Cannot find module '([^']+)'/.exec(errorMessage(error))?.[1]?.startsWith(ownDir) === true

try {
  await dispatch()
} catch (error) {
  if (isBuildIncomplete(error)) {
    console.error(`${errorMessage(error)}\n\nThe build looks incomplete. In a checkout, run \`pnpm build\`.`)
    process.exit(2)
  }
  // A bad setting should read as a sentence, not a stack trace; and as status 2.
  console.error(errorMessage(error))
  process.exit(error instanceof ConfigError ? 2 : 1)
}

/**
 * `browserbay key` prints a bare key, for BROWSERBAY_API_KEY. With a name it also prints the BROWSERBAY_API_KEYS entry
 * for the relay (which only ever holds the hash), optionally confined to a namespace with a quota of slots:
 * `browserbay key billing --namespace billing --quota 5`.
 */
function makeKey(args: string[]) {
  const [name, ...flags] = args
  if (name === undefined) return console.log(secret())
  const options: Record<string, string> = {}
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i]
    const value = flags[i + 1]
    if ((flag !== '--namespace' && flag !== '--quota') || value === undefined || value.startsWith('--')) {
      console.error('Usage: browserbay key [name [--namespace <namespace>] [--quota <slots>]]')
      process.exit(2)
    }
    options[flag.slice(2)] = value
  }
  if (!NAME_PATTERN.test(name) || (options.namespace !== undefined && !NAME_PATTERN.test(options.namespace))) {
    console.error('A name and a namespace may only contain letters, digits, "_", "." and "-".')
    process.exit(2)
  }
  const quotaIssue = options.quota === undefined ? undefined : quotaProblem(options.quota, options.namespace)
  if (quotaIssue) {
    console.error(`--quota: ${quotaIssue}.`)
    process.exit(2)
  }
  const value = secret()
  const hash = createHash('sha256').update(value).digest('hex')
  const entry = [name, hash, options.namespace ?? '', options.quota ?? ''].join(':').replace(/:+$/, '')
  console.log(`Give the service:  BROWSERBAY_API_KEY=${value}   (as the client's apiKey)`)
  console.log(`Give the relay:    BROWSERBAY_API_KEYS=${entry}   (comma-separate several)`)
  if (options.namespace) console.log(`The service must create its browsers with namespace "${options.namespace}".`)
}

// Each command loads only what it runs: `key` and `secret` do not need the relay, the browser node or their dependencies.
async function dispatch() {
  switch (command) {
    case 'start':
      await (await import('./box/start.js')).runBox()
      break
    case 'node':
      await (await import('./node/main.js')).runNode()
      break
    case 'relay':
      await (await import('./relay/main.js')).runRelay()
      break
    case 'secret': {
      const name = args[0] ?? 'node'
      if (!NAME_PATTERN.test(name)) {
        console.error(
          'The name may only contain letters, digits, "_", "." and "-" (it is what the relay calls the node in its logs).'
        )
        process.exit(2)
      }
      const value = secret()
      const hash = createHash('sha256').update(value).digest('hex')
      console.log(`Give the node:   BROWSERBAY_ENROLLMENT_SECRET=${value}`)
      console.log(`Give the relay:  BROWSERBAY_ENROLLMENT_SECRETS=${name}:${hash}   (comma-separate several)`)
      break
    }
    case 'key':
      makeKey(args)
      break
    case 'web-bot-auth': {
      // A key for a box to sign its browsers' requests with. It is a private key: shown here once, then kept like a password.
      const { generateSigningKey, DIRECTORY_PATH } = await import('./web-bot-auth.js')
      const made = generateSigningKey()
      console.log(`Give the relay and every node that signs:  BROWSERBAY_WEB_BOT_AUTH_KEY='${made.privateJwk}'`)
      console.log(`Its id, which is what a site looks the key up by:  ${made.keyid}`)
      console.log('')
      console.log('On each node that signs, say how and where the box says it is:')
      console.log('  BROWSERBAY_WEB_BOT_AUTH=optional   (or "always": sign every slot, and not only the ones that ask)')
      console.log('  BROWSERBAY_WEB_BOT_AUTH_AGENT=https://<the address your relay is served at>')
      console.log('')
      console.log(`The relay then publishes the public key at  https://<your relay>${DIRECTORY_PATH}`)
      break
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      break
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`)
      process.exit(2)
  }
}
