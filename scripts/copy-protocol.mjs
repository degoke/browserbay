// The relay is compiled TypeScript; the protocol it imports is plain JavaScript that tsc only reads the types of.
// Copy it next to the output so `dist/relay/*.js` finds `../protocol.js`.
import { copyFileSync, mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })
copyFileSync('src/protocol.js', 'dist/protocol.js')
