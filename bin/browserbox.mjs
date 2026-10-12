#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'

const HELP = `browserbox: self-hosted browsers for AI agents and automation

  browserbox start     the relay and a browser node in one process (the simplest box)
  browserbox relay     the relay alone (clients and remote nodes connect to it)
  browserbox node      a browser node alone (dials out to a relay)
  browserbox secret    make an enrollment secret for a node, and the entry the relay needs for it
  browserbox key       make an API key

Settings are environment variables; see the README.`

const [command, ...args] = process.argv.slice(2)

const secret = () => randomBytes(24).toString('base64url')

try {
  await dispatch()
} catch (error) {
  // A bad setting should read as a sentence, not a stack trace.
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

async function dispatch() {
  switch (command) {
    case 'start':
      await (await import('../src/box/start.mjs')).runBox()
      break
    case 'node':
      await (await import('../src/node/main.mjs')).runNode()
      break
    case 'relay': {
      let main
      try {
        main = await import('../dist/relay/main.js')
      } catch (error) {
        if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
        console.error('The relay is not built. Run `pnpm build` first (the Docker image does this for you).')
        process.exit(2)
      }
      await main.runRelay()
      break
    }
    case 'secret': {
      const name = args[0] ?? 'node'
      const value = secret()
      const hash = createHash('sha256').update(value).digest('hex')
      console.log(`Give the node:   BROWSERBOX_ENROLLMENT_SECRET=${value}`)
      console.log(`Give the relay:  BROWSERBOX_ENROLLMENT_SECRETS=${name}:${hash}   (comma-separate several)`)
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
