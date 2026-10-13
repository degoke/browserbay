#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { errorMessage } from './errors.js'
import { ConfigError, NAME_PATTERN } from './protocol.js'

const HELP = `browserbay: self-hosted browsers for AI agents and automation

  browserbay start     the relay and a browser node in one process (the simplest box)
  browserbay relay     the relay alone (clients and remote nodes connect to it)
  browserbay node      a browser node alone (dials out to a relay)
  browserbay secret    make an enrollment secret for a node, and the entry the relay needs for it
  browserbay key       make an API key

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
      console.log(secret())
      break
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
