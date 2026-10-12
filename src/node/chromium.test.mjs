import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chromiumArgs, chromiumEnv, findChromium } from './chromium.mjs'

test('chromium environment: what a browser needs passes, the box’s and the platform’s secrets do not', () => {
  const env = chromiumEnv({
    PATH: '/usr/bin',
    HOME: '/home/node',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C.UTF-8',
    LC_TIME: 'en_GB',
    TZ: 'Europe/London',
    DISPLAY: ':99',
    LD_LIBRARY_PATH: '/usr/lib',
    HTTPS_PROXY: 'http://proxy:3128',
    no_proxy: 'localhost',
    // none of these
    BROWSERBOX_API_KEY: 'the-api-key-0123456789',
    BROWSERBOX_ENROLLMENT_SECRET: 'the-enrollment-secret',
    BROWSERBOX_ENROLLMENT_SECRETS: 'a:00',
    DATABASE_URL: 'postgres://user:password@host/db',
    AWS_SECRET_ACCESS_KEY: 'aws',
    RAILWAY_TOKEN: 'railway',
    FLY_API_TOKEN: 'fly',
    NODE_OPTIONS: '--require /x.js',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright'
  })
  assert.deepEqual(Object.keys(env).sort(), [
    'DISPLAY',
    'HOME',
    'HTTPS_PROXY',
    'LANG',
    'LC_ALL',
    'LC_TIME',
    'LD_LIBRARY_PATH',
    'PATH',
    'TZ',
    'no_proxy'
  ])
  assert.ok(!JSON.stringify(env).includes('0123456789') && !JSON.stringify(env).includes('password'))
  assert.deepEqual(chromiumEnv({}), {}, 'nothing in, nothing out')
})

test('chromium command line: DevTools on a pipe, no port; sandbox and headless as asked', () => {
  const args = chromiumArgs({ profileDir: '/p' })
  assert.ok(args.includes('--remote-debugging-pipe'))
  assert.ok(!args.some((arg) => arg.startsWith('--remote-debugging-port')), 'no DevTools port for anything to reach')
  assert.ok(args.includes('--user-data-dir=/p'))
  assert.ok(args.includes('--headless=new'), 'headless unless told otherwise')
  assert.ok(args.includes('--no-sandbox'), 'a container rarely allows the sandbox, so it is off unless asked for')
  assert.equal(args.at(-1), 'about:blank')

  assert.ok(!chromiumArgs({ profileDir: '/p', sandbox: true }).includes('--no-sandbox'))
  assert.ok(!chromiumArgs({ profileDir: '/p', headless: false }).some((arg) => arg.startsWith('--headless')))
})

test('finding Chromium: an explicit path wins, then the image’s Playwright directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browserbox-find-'))
  try {
    assert.equal(
      findChromium({ BROWSERBOX_CHROMIUM_EXECUTABLE: '/custom/chrome', PLAYWRIGHT_BROWSERS_PATH: root }),
      '/custom/chrome'
    )
    assert.equal(findChromium({ PLAYWRIGHT_BROWSERS_PATH: root }), null, 'nothing installed')
    assert.equal(findChromium({ PLAYWRIGHT_BROWSERS_PATH: join(root, 'missing') }), null, 'no such directory')

    // Playwright's layout: <root>/chromium-<revision>/chrome-linux*/chrome. Other browsers in the directory are not it.
    for (const entry of [
      'chromium_headless_shell-1234/chrome-linux',
      'firefox-1/firefox',
      'chromium-1234/chrome-linux64'
    ]) {
      await mkdir(join(root, entry), { recursive: true })
    }
    await writeFile(join(root, 'chromium_headless_shell-1234/chrome-linux/chrome'), '')
    assert.equal(
      findChromium({ PLAYWRIGHT_BROWSERS_PATH: root }),
      null,
      'the headless shell is not the browser this wants'
    )
    await writeFile(join(root, 'chromium-1234/chrome-linux64/chrome'), '')
    await chmod(join(root, 'chromium-1234/chrome-linux64/chrome'), 0o755)
    assert.equal(findChromium({ PLAYWRIGHT_BROWSERS_PATH: root }), join(root, 'chromium-1234/chrome-linux64/chrome'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
