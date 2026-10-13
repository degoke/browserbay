/**
 * Decides when the far end of a connection is too slow to be kept. The question is not "is a lot of data waiting
 * right now": one legitimate message (a full-page screenshot is tens of MB) leaves the buffer high until it drains, and
 * the very next message would then look like an overload. A consumer is too slow when its backlog stays above
 * `maxBytes` for longer than `graceMs`. Call the returned function with the socket's bufferedAmount before each send.
 *
 * Shared by the relay (its client sockets) and the node agent (its stream sockets).
 */
export function createBacklogGuard({
  maxBytes,
  graceMs,
  now = Date.now
}: {
  maxBytes: number
  graceMs: number
  now?: () => number
}) {
  let overSince: number | null = null
  return (bufferedBytes: number) => {
    if (bufferedBytes <= maxBytes) {
      overSince = null
      return false
    }
    overSince ??= now()
    return now() - overSince > graceMs
  }
}
