# Releasing

A release is a `vX.Y.Z` tag on `main`. Pushing it runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which tests everything and then publishes:

- the npm package `@degoke/browserbay` to **GitHub Packages**, and to **npmjs.com** as a _staged_ version that goes live when you approve it (see [Approve the staged version](#each-release)),
- the two Docker images, `ghcr.io/degoke/browserbay` and `ghcr.io/degoke/browserbay-relay`.

The images wait for the GitHub Packages publish and the npm staging, so a tag is released whole or not at all. The npm version goes live when you approve it, which is after the images: the workflow cannot wait for a person.

## One-time setup

Do these once, before the first release.

1. **Own the scope.** `@degoke` has to be your npm username or an npm organisation you can publish to. Check with `npm whoami`. For an organisation, create it at npmjs.com first.
2. **The license is MIT.** It is in [`LICENSE`](LICENSE), in `package.json` and in `clients/python/pyproject.toml`, with copies in `clients/go/` and `clients/python/`. `pnpm check:package` fails if the package ships without it. Keep the copies in step if the text ever changes.
3. **Make a token.** On npmjs.com, Access Tokens, Generate New Token, Granular Access Token. Give it **Read and write (stage only)** if npm offers it, otherwise **Read and write**. CI only stages the package, and staging needs no one-time code, so the token does **not** need to bypass two-factor authentication (npm is restricting tokens that do). The package does not exist yet, so for the first release choose all packages (or the `@degoke` scope). Set an expiry and put it in your calendar.
4. **Give the repository the token.** On GitHub: Settings, Secrets and variables, Actions, New repository secret, named `NPM_TOKEN`.
5. **Provenance.** The npm job stages with `--provenance`, which links the package to the workflow run that built it. That needs a **public** repository. If the repository is private, remove `--provenance` from the `npm` job.
6. **Two-factor authentication** has to be on for your npm account. It is what approves a staged version.

After the first release, narrow the token to just `@degoke/browserbay`, or switch to npm's trusted publishing (no stored token) once the package exists.

## Each release

1. **Choose the version.** Semantic versioning. Then set it everywhere it has to agree:

   ```sh
   pnpm version:set 0.2.0
   ```

   This writes the package version, the Helm chart's `version` and `appVersion` (which picks the image tag) and the Python client's version. CI has a `versions` job that fails if they ever differ.

   It also **rolls the changelog**: what is under `[Unreleased]` in `CHANGELOG.md` becomes the new version's dated section, with its compare link, and a fresh empty `[Unreleased]` is left above it. Read the result: it should say what a user would notice. The script warns if nothing was listed.

2. **Commit and merge.** Commit the version files and the changelog as `Release v0.2.0`, open a pull request, and merge it to `main` once CI is green.

3. **Check the package yourself** if you like (CI runs the same):

   ```sh
   pnpm release:check
   ```

   It typechecks, checks formatting, runs the tests, then packs the package exactly as npm would publish it, installs that into an empty project and runs it (`browserbay help`, `browserbay key`, and an import of both entry points). It fails on a missing file, a stray test file or a broken command.

4. **Tag and push.**

   ```sh
   git checkout main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

   The workflow refuses a tag that does not match the version in `package.json`.

5. **Watch the run** under Actions. The order is: tests and the package check, then the GitHub Packages publish and the npm staging in parallel, then the Docker images.

6. **Approve the staged version.** The `npm` job does not put the version live: it stages it, and it cannot be installed until you approve it with your two-factor code. This is the one step a person has to do. Open the package on npmjs.com and approve the staged version there, or from a terminal:

   ```sh
   npm stage list                       # the staged versions and their ids
   npm stage view <stage-id>            # what is in it (or `npm stage download <stage-id>` to inspect the files)
   npm stage approve <stage-id>         # asks for your two-factor code, then publishes
   ```

   `npm stage reject <stage-id>` discards a staged version for good. It needs npm 11.15 or newer.

7. **Check the result.**

   ```sh
   npm view @degoke/browserbay version          # the new version
   npx @degoke/browserbay key                   # the published package runs
   docker pull ghcr.io/degoke/browserbay:0.2.0
   ```

### Not published by the workflow

- **The Go client.** Its module lives in a subdirectory, so it needs its own tag: `git tag clients/go/v0.2.0 && git push origin clients/go/v0.2.0`.
- **The Python client** is not published to PyPI yet. Install it from the repository.
- **The Helm chart** is not published to a chart repository. Install it from a checkout.

## Pre-releases

A tag with a suffix, such as `v1.0.0-rc.1`, is published to the `next` tag on npm and not to `latest`, and its images are not tagged `latest`. Install one with `pnpm add @degoke/browserbay@next`.

## When something goes wrong

- **The run failed part way.** Fix the cause and re-run the failed jobs. Publishing is safe to repeat: a version a registry already has is skipped. A version that is staged and not yet approved is _not_ on the registry, so approve or reject it first, or the re-run stages it a second time.
- **The workflow that runs is the one in the tag.** Re-running a failed release runs the `release.yml` as it was when the tag was made. A fix to the workflow does not reach an existing tag: release the next patch version instead of moving the tag.
- **"The NPM_TOKEN secret is not set"** or an authentication error from `npm whoami`: the secret is missing, wrong or expired. Make a new token, update the secret, re-run.
- **A bad version went out.** A published version cannot be replaced. Run `npm deprecate @degoke/browserbay@0.2.0 "reason"`, fix the problem and release `0.2.1`. `npm unpublish` only works for the first 72 hours and only if nothing depends on it, so treat it as a last resort.
