// Sets the release version everywhere it has to agree: the package, the Helm chart (its version and the appVersion
// that picks the image tag) and the Python client. CI fails if they drift. It also rolls the changelog: what is under
// [Unreleased] becomes this version's section, dated today, with its compare link.
//
//   pnpm version:set 0.2.0        (or a pre-release: 0.2.0-rc.1)
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: pnpm version:set <major.minor.patch>   (a pre-release such as 1.2.3-rc.1 is fine)')
  process.exit(2)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const targets = [
  // file, the line to replace (first match only), what it becomes
  ['package.json', /^(\s*"version": )"[^"]*"/m, `$1"${version}"`],
  ['deploy/helm/browserbay/Chart.yaml', /^version: .*$/m, `version: ${version}`],
  ['deploy/helm/browserbay/Chart.yaml', /^appVersion: .*$/m, `appVersion: '${version}'`],
  ['clients/python/src/browserbay/_version.py', /^__version__ = ".*"$/m, `__version__ = "${version}"`]
]
for (const [file, pattern, replacement] of targets) {
  const path = join(root, file)
  const before = readFileSync(path, 'utf8')
  if (!pattern.test(before)) {
    console.error(`${file}: could not find the version line to change`)
    process.exit(1)
  }
  writeFileSync(path, before.replace(pattern, replacement))
  console.log(`${file} -> ${version}`)
}

// The changelog. Running this twice for the same version changes nothing the second time.
const changelogPath = join(root, 'CHANGELOG.md')
const changelog = readFileSync(changelogPath, 'utf8')
if (changelog.includes(`## [${version}]`)) {
  console.log(`CHANGELOG.md already has a section for ${version}`)
} else {
  const link = /^\[Unreleased\]: (\S+)\/compare\/v(\S+?)\.\.\.HEAD$/m.exec(changelog)
  if (!link || !changelog.includes('## [Unreleased]')) {
    console.error('CHANGELOG.md: could not find the [Unreleased] heading and its compare link to roll')
    process.exit(1)
  }
  const [, repository, previous] = link
  const unreleased = changelog.split('## [Unreleased]')[1].split(/^## \[/m)[0]
  if (unreleased.replace(/^### .*$/gm, '').trim() === '')
    console.warn('Warning: nothing is listed under [Unreleased] in CHANGELOG.md')
  const today = new Date().toISOString().slice(0, 10)
  writeFileSync(
    changelogPath,
    changelog
      .replace('## [Unreleased]', `## [Unreleased]\n\n## [${version}] - ${today}`)
      .replace(
        link[0],
        `[Unreleased]: ${repository}/compare/v${version}...HEAD\n[${version}]: ${repository}/compare/v${previous}...v${version}`
      )
  )
  console.log(`CHANGELOG.md -> [${version}] - ${today}`)
}

console.log('\nNext: check CHANGELOG.md reads well, commit, run `pnpm release:check`, then tag v' + version)
