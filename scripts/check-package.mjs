// Checks the package the way a user will meet it: packs what npm would publish, installs that tarball into an empty
// project, and uses it. Run after a build (`pnpm check:package`); CI and the release workflow run it before anything is
// published, so a package with a missing file or a broken entry point never reaches a registry.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const problems = []
const check = (ok, message) => ok || problems.push(message)

const work = mkdtempSync(join(tmpdir(), 'browserbay-package-'))
try {
  // 1. What would be published.
  const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], root))
  const files = packed.files.map((file) => file.path)
  console.log(`${packed.name}@${packed.version}: ${files.length} files, ${packed.size} bytes packed`)
  for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/cli.js',
    'dist/protocol.js',
    'dist/protocol.d.ts',
    'dist/client/index.js',
    'dist/client/index.d.ts'
  ]) {
    check(files.includes(required), `the package is missing ${required} (did you run the build?)`)
  }
  const unexpected = files.filter(
    (file) => !(file === 'package.json' || file === 'README.md' || file === 'LICENSE' || file.startsWith('dist/'))
  )
  check(unexpected.length === 0, `the package contains files it should not: ${unexpected.join(', ')}`)
  const noise = files.filter((file) => /\.test\.|\.map$|fake-chromium/.test(file))
  check(noise.length === 0, `the package contains tests or source maps: ${noise.slice(0, 5).join(', ')}`)
  check(packed.version === manifest.version, 'the packed version differs from package.json')
  check(Boolean(manifest.license), 'package.json has no license field')

  // 2. What a user gets: install the tarball into an empty project, then use it.
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  run('npm', ['install', join(work, packed.filename), '--ignore-scripts', '--no-audit', '--no-fund'], work)

  const help = run(join(work, 'node_modules', '.bin', 'browserbay'), ['help'], work)
  check(help.includes('browserbay start'), 'the installed `browserbay` command did not print its help')
  const key = run(join(work, 'node_modules', '.bin', 'browserbay'), ['key'], work).trim()
  check(key.length >= 16, 'the installed `browserbay key` did not make a usable API key')

  run(
    'node',
    [
      '--input-type=module',
      '-e',
      `const client = await import('${manifest.name}/client')
       if (typeof client.createBrowserBay !== 'function' || typeof client.NoCapacityError !== 'function') throw new Error('the client entry point is incomplete')
       const protocol = await import('${manifest.name}/protocol')
       if (!protocol.NAME_PATTERN) throw new Error('the protocol entry point is incomplete')`
    ],
    work
  )
} catch (error) {
  problems.push(`could not complete the check: ${error instanceof Error ? error.message : error}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error(`\nThe package is not ready to publish:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
  process.exit(1)
}
console.log('The package installs and its command and entry points work.')
