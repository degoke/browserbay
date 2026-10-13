/**
 * Finding and starting Chromium inside the browserbay image.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function findChromium(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.BROWSERBAY_CHROMIUM_EXECUTABLE
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
export function chromiumArgs({
  profileDir,
  headless = true,
  sandbox = false
}: {
  profileDir: string
  headless?: boolean
  sandbox?: boolean
}): string[] {
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

/**
 * What Chromium may see of its parent's environment. Not all of it: the parent's environment holds the box's own
 * secrets (the API key, the enrollment secret) and, on a platform, usually unrelated ones (database URLs, cloud
 * credentials), and pages the browser runs are not trusted with any of them. What is kept is what a browser needs to
 * find its libraries, fonts, a display, its time zone and locale, and to reach the network through a proxy.
 */
const CHROMIUM_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'LD_LIBRARY_PATH',
  'FONTCONFIG_PATH',
  'FONTCONFIG_FILE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  '__CF_USER_TEXT_ENCODING',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY'
])

/**
 * `BROWSERBAY_CHROMIUM_ENV_PASSTHROUGH` is how an operator adds to that (a headful node under Xvfb or on a GL host may
 * need LIBGL_*, MESA_*, GTK_*, DBUS_SESSION_BUS_ADDRESS or a custom CA variable): comma-separated variable names. It
 * can never pass the box's own settings, whatever it lists.
 */
export function chromiumEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const extra = new Set(
    (env.BROWSERBAY_CHROMIUM_ENV_PASSTHROUGH ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !name.startsWith('BROWSERBAY_'))
  )
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => CHROMIUM_ENV.has(name) || extra.has(name) || name.startsWith('LC_'))
  )
}
