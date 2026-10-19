#!/usr/bin/env node
// Drives one slot of a running box over raw DevTools and checks the browser does not announce itself. No dependencies
// (Node's own fetch and WebSocket), so CI can run it against the image it just built with nothing installed:
//
//   node scripts/smoke-box.mjs http://localhost:8788 "$BROWSERBAY_API_KEY"            # a headful node (the image's default)
//   node scripts/smoke-box.mjs http://localhost:8788 "$BROWSERBAY_API_KEY" --headless  # a node on BROWSERBAY_HEADLESS=true
//
// Exits 0 when the slot's browser shows no HeadlessChrome (unless --headless), has navigator.webdriver off and has a
// screen at least as big as its window; otherwise prints what it saw and exits 1.

const [boxUrl, apiKey, ...flags] = process.argv.slice(2)
if (!boxUrl || !apiKey) {
  console.error('usage: smoke-box.mjs <box url> <api key> [--headless]')
  process.exit(2)
}
const allowHeadless = flags.includes('--headless')
const base = boxUrl.replace(/\/$/, '')
const auth = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }

const created = await fetch(`${base}/v1/slots`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ runId: 'smoke', maxLifetimeSeconds: 120, waitMs: 20_000 })
})
if (created.status !== 201) {
  console.error(`could not take a slot: ${created.status} ${await created.text()}`)
  process.exit(1)
}
const { slotId, token } = await created.json()

let exitCode = 1
try {
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/cdp/${slotId}`, {
    headers: { 'x-browserbay-token': token }
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('could not open the slot’s DevTools socket')), {
      once: true
    })
  })
  let nextId = 1
  const waiting = new Map()
  const events = []
  const listeners = []
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data))
    if (message.id !== undefined) waiting.get(message.id)?.(message)
    else {
      events.push(message)
      for (const listener of listeners) listener(message)
    }
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`${method} was not answered`)), 20_000)
      waiting.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(`${method}: ${message.error.message}`))
        else resolve(message.result)
      })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })

  // As a client of a slot does: take over auto-attach, open a tab, and let it run once it is set up.
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  const attached = new Promise((resolve) => {
    listeners.push((message) => message.method === 'Target.attachedToTarget' && resolve(message.params.sessionId))
  })
  await send('Target.createTarget', { url: 'about:blank' })
  const sessionId = await attached
  await send('Runtime.runIfWaitingForDebugger', {}, sessionId)

  const { result } = await send(
    'Runtime.evaluate',
    {
      expression: `JSON.stringify({
        userAgent: navigator.userAgent,
        webdriver: navigator.webdriver,
        screen: [screen.width, screen.height],
        window: [outerWidth, outerHeight]
      })`,
      returnByValue: true
    },
    sessionId
  )
  const seen = JSON.parse(result.value)
  console.log(JSON.stringify(seen))

  const problems = []
  if (!allowHeadless && /Headless/.test(seen.userAgent)) problems.push('the user agent says HeadlessChrome')
  if (seen.webdriver !== false) problems.push(`navigator.webdriver is ${seen.webdriver}`)
  if (seen.screen[0] < seen.window[0] || seen.screen[1] < seen.window[1]) {
    problems.push(`the screen (${seen.screen}) is smaller than the window (${seen.window})`)
  }
  if (problems.length) console.error(`the slot's browser announces itself: ${problems.join('; ')}`)
  else console.log('ok: the slot’s browser does not announce itself')
  exitCode = problems.length ? 1 : 0
  socket.close()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
} finally {
  await fetch(`${base}/v1/slots/${slotId}`, { method: 'DELETE', headers: auth }).catch(() => undefined)
}
process.exit(exitCode)
