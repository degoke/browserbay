/** A logger that writes one JSON line per message to stdout, for the relay and the all-in-one box. */
export const jsonLog = (level: string) => (message: string, fields?: Record<string, unknown>) =>
  console.log(JSON.stringify({ level, message, ...fields }))
