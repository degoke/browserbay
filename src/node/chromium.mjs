/**
 * Finding and starting Chromium inside the browserbox image. Plain Node, no dependencies.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function findChromium(env = process.env) {
  const override = env.BROWSERBOX_CHROMIUM_EXECUTABLE
  if (override) return override
  const root = env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright'
  for (const entry of existsSync(root) ? readdirSync(root) : []) {
    if (!/^chromium-\d+$/.test(entry)) continue
    for (const sub of readdirSync(join(root, entry))) {
      const candidate = join(root, entry, sub, 'chrome')
      if (/^chrome-linux/.test(sub) && existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Chromium's command line. DevTools is a pair of pipes to the parent (fds 3 and 4), so there is no DevTools port for
 * anything on the network to reach.
 *
 * `sandbox: false` adds --no-sandbox, which a container running Chromium as an unprivileged user usually needs
 * (Chromium's sandbox wants user namespaces the platform rarely grants). The BrowserContext per slot is the isolation
 * between slots, unless the sandbox can be enabled; see "Isolation" in the README.
 */
export function chromiumArgs({ profileDir, headless = true, sandbox = false }) {
  return [
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    ...(sandbox ? [] : ['--no-sandbox']),
    '--disable-dev-shm-usage',
    '--window-size=1280,900',
    ...(headless ? ['--headless=new'] : []),
    'about:blank'
  ]
}
