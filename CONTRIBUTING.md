# Contributing to browserbay

Thanks for helping. This page is what you need to build the project, change it and send the change back.

By contributing you agree that your contribution is released under the project's [MIT license](LICENSE).

## What fits, and what does not

browserbay is **a box that lends out browsers, and nothing on top of it**. You ask for a browser, get a DevTools address and a token, and what drives it is up to you. That is what makes one box reusable across projects, so changes should be about the box itself: isolation, scaling, reliability, security, Chromium and DevTools compatibility, deployment, the clients, and the docs.

Please do not send:

- agent loops, model or LLM calls, or helpers for a specific agent framework,
- a crawler, a scraping endpoint, or screenshot, PDF or "quick action" endpoints,
- anything that makes the box know what is on the other end of a slot.

Build those on top of `slot.cdpUrl` instead. If you are not sure whether an idea fits, open an issue and ask before you write it.

## Reporting problems

- **A bug or a feature idea:** open an issue and fill in the form.
- **A security problem:** do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Setting up

You need Node 22 or newer and [pnpm](https://pnpm.io) (the version in `package.json`'s `packageManager`).

```sh
pnpm install
pnpm test           # builds, then runs the unit tests (they use a fake Chromium: no browser needed)
pnpm run ci         # what CI runs first: typecheck, format check and the unit tests
pnpm format         # fixes formatting (Prettier)
```

`pnpm ci` is pnpm's own clean install, not this. Use `pnpm run ci`.

The tests that use a real Chromium run the whole box:

```sh
pnpm exec playwright install chromium
pnpm test:browser
```

The first launch can take 20 seconds or more on macOS. See the README's Development section for the details.

### The scope hub needs extra care

`src/node/scope.ts` is what keeps one slot away from another. When you change it:

- re-run `pnpm test:browser`,
- add a test for the new behaviour,
- **mutate it to prove the test notices**: change the code to break the rule (resume popups early, skip release cleanup, return an unfiltered `Target.getTargets`) and check a test fails. A test that passes is not proof until it has failed for the right reason.

`src/node/fake-chromium.ts` stands in for Chromium in the unit tests and must stay in step with it.

### The other parts

Each part has its own checks, and CI runs them all.

| Part                 | Where                     | Check it                                                                                   |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| Website and docs     | `site/`                   | `cd site && pnpm install && pnpm dev` to look, `pnpm build` to check                       |
| Go client            | `clients/go/`             | `gofmt -l .`, `go vet ./...`, `go test ./... -race`                                        |
| Python client        | `clients/python/`         | `PYTHONPATH=src python3 -m unittest discover -s tests`                                     |
| Helm chart           | `deploy/helm/browserbay/` | `helm lint . -f ci/split-values.yaml --strict`, and `helm template` for each file in `ci/` |
| Logo and brand files | `brand/`                  | edit the SVGs, then `node brand/render.mjs`                                                |

## Sending a change

1. Fork the repository and make a branch.
2. Keep the change small and about one thing. A bug fix needs a test that fails without it.
3. **Update the docs when behaviour changes.** A setting, an endpoint or a limit lives in the README and in `site/src/content/docs/`. Say it in both.
4. Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
5. Run `pnpm run ci` (and the checks for any other part you touched).
6. Open a pull request and fill in the template.

A few conventions:

- Match the style around you: TypeScript on the Node side, plain standard-library Go and Python in the clients. Prettier decides formatting.
- Write comments that explain why. Comments that repeat the code are noise.
- Do not log, return or store secrets: API keys, slot tokens and enrollment secrets never go in a log line or an error message.
- Releases are made by a maintainer; see [RELEASING.md](RELEASING.md).

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
