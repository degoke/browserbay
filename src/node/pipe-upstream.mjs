/**
 * The agent's connection to Chromium: DevTools over `--remote-debugging-pipe`, the transport Playwright itself uses when
 * it launches a browser. Chromium reads commands from one pipe and writes answers and events to another, each message
 * a JSON text followed by a NUL byte.
 *
 * It is used instead of DevTools' WebSocket for two reasons. Node's built-in WebSocket client drops the connection
 * (1006) when Chromium sends a message of about 4 MB or more, which a full-page screenshot or a large evaluate result
 * is; a pipe has no framing to go wrong, at any size. And there is no DevTools port at all, on loopback or anywhere
 * else, so nothing on the machine (a page, another process) can reach the browser's debugging interface but this one.
 *
 * Plain Node, no dependencies.
 */

/**
 * `input` is the stream Chromium writes to (fd 4 of the child) and `output` the one it reads from (fd 3). Calls
 * `onMessage` with each complete message, and `onClose` once when the browser's end goes away.
 */
export function createPipeUpstream({ input, output, onMessage, onClose }) {
  /** The pieces of the message being received. Nothing is joined, or decoded, until its NUL arrives. */
  const parts = []
  let closed = false

  input.on('data', (chunk) => {
    let start = 0
    for (;;) {
      const end = chunk.indexOf(0, start)
      if (end === -1) {
        if (start < chunk.length) parts.push(start === 0 ? chunk : chunk.subarray(start))
        return
      }
      parts.push(chunk.subarray(start, end))
      // Decoding the whole message at once keeps a character that straddles two chunks in one piece.
      const message = Buffer.concat(parts).toString('utf8')
      parts.length = 0
      if (message) onMessage(message)
      start = end + 1
    }
  })

  const finish = () => {
    if (closed) return
    closed = true
    onClose()
  }
  input.on('end', finish)
  input.on('close', finish)
  input.on('error', finish)
  // Writing to a browser that has gone is reported through `input` closing, not as a second failure here.
  output.on('error', () => undefined)

  return {
    send(text) {
      if (!closed) output.write(`${text}\0`)
    }
  }
}
