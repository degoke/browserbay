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
 * How the browser is displayed. `headless`: no display at all (`--headless=new`). `host`: a headful browser on whatever
 * display the node's environment names. `xvfb`: a headful browser on a virtual display the node starts for it (xvfb.ts),
 * which is what the image does: a headful Chromium has no `HeadlessChrome` in its user agent and none of the other
 * things headless mode announces.
 */
export type Display = 'headless' | 'host' | 'xvfb'

/**
 * Chromium's command line. DevTools is a pair of pipes to the parent (fds 3 and 4), so there is no DevTools port for
 * anything on the network to reach.
 *
 * `sandbox: false` adds --no-sandbox, which a container running Chromium as an unprivileged user usually needs
 * (Chromium's sandbox wants user namespaces the platform rarely grants). The BrowserContext per slot (or, with
 * BROWSERBAY_ISOLATION=process, a Chromium per slot) is the isolation between slots, unless the sandbox can be
 * enabled; see "Isolation" in the README.
 *
 * Driving a browser over DevTools turns on `navigator.webdriver`, which a page can read to learn it is automated.
 * `--disable-blink-features=AutomationControlled` turns that off; `hideWebdriver: false` leaves it on, for a node whose
 * operator wants the browser to say what it is.
 */
export function chromiumArgs({
  profileDir,
  display = 'headless',
  sandbox = false,
  hideWebdriver = true
}: {
  profileDir: string
  display?: Display
  sandbox?: boolean
  hideWebdriver?: boolean
}): string[] {
  return [
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    // No keyring to probe for in a container: the default store would try, and log about it.
    '--password-store=basic',
    ...(hideWebdriver ? ['--disable-blink-features=AutomationControlled'] : []),
    ...(sandbox ? [] : ['--no-sandbox']),
    '--disable-dev-shm-usage',
    '--window-size=1280,900',
    ...(display === 'headless'
      ? // A headless browser's screen is 800x600 inside a 1280x900 window, which no real display is.
        ['--headless=new', '--screen-info={1920x1080}']
      : [
          // Headful, only a window's active tab paints and a background tab's timers are throttled, which would leave a
          // live view of (or a script in) a tab that is not in front with nothing to show.
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          // On the virtual display, which is the container with no GPU: never the host's Wayland compositor (on a desktop, with
          // the virtual display named in DISPLAY, that is the one it uses), and a software WebGL renderer, because a headful
          // Chromium has no WebGL at all without one (a page with none is a stronger tell than one on SwiftShader) and a
          // headless one always had it. On the host's own display it is the host's call: it has a GPU, or the operator's flags.
          ...(display === 'xvfb' ? ['--ozone-platform=x11', '--enable-unsafe-swiftshader'] : [])
        ]),
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
 *
 * `display` names a virtual display the node started for this browser (xvfb.ts). It replaces whatever display the node's own
 * environment named, and drops the Wayland socket, so the browser can only ever open on the virtual one.
 */
export function chromiumEnv(
  env: NodeJS.ProcessEnv = process.env,
  display?: { DISPLAY: string; XAUTHORITY: string }
): Record<string, string | undefined> {
  const extra = new Set(
    (env.BROWSERBAY_CHROMIUM_ENV_PASSTHROUGH ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !name.startsWith('BROWSERBAY_'))
  )
  const allowed: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(env).filter(([name]) => CHROMIUM_ENV.has(name) || extra.has(name) || name.startsWith('LC_'))
  )
  if (!display) return allowed
  delete allowed.WAYLAND_DISPLAY
  return { ...allowed, ...display }
}
