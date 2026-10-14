# Changelog

All notable changes to browserbay are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/). While it is on 0.x, a minor version may change behaviour: read the entry before upgrading, and upgrade the relay and the nodes together.

## [Unreleased]

## [0.2.1] - 2026-10-14

### Changed

- **Releases reach npm through staged publishing.** The release workflow stages the package with `npm stage publish`, and a maintainer approves it with two-factor authentication before it can be installed. The npm token no longer has to bypass 2FA. See `RELEASING.md`.

### Fixed

- **The 0.2.0 release stopped part way:** npm asked for a one-time code, so 0.2.0 is on GitHub Packages only, and neither npm nor the Docker images have it. 0.2.1 is the first version on npmjs.com and the first with Docker images from the release workflow.

## [0.2.0] - 2026-10-14

### Added

- **Several API keys with namespaces and quotas** (`BROWSERBAY_API_KEYS`, `browserbay key <name> --namespace <ns> --quota <n>`) and **a Chromium per slot** (`BROWSERBAY_ISOLATION=process`).
- **Python and Go clients** in `clients/python` and `clients/go`, with the same behaviour as the Node client, including its `QuotaExceeded` and `Forbidden` errors, and no dependencies beyond the standard library. A slot saved by one can be revived by another. The Python client has an async API.
- **Helm chart** in `deploy/helm/browserbay`: a relay with one replica and a separate node Deployment that scales on its own (by hand or with an autoscaler), plus an all-in-one mode. Nodes drain before they stop, rollouts keep capacity, and values are validated against a schema.
- **`BROWSERBAY_ALLOW_INSECURE_RELAY`** lets a node reach a relay over plain `http://` or `ws://` on a private network, such as a cluster's own Service. A public address is still refused, and the node logs a warning on every start.
- **Website and docs** in `site/`: a landing page and docs for deploying and using browserbay, including live view, Kubernetes and the clients.
- **Logo and brand files** in `brand/`.
- **Search and sharing metadata** for the website at https://browserbay.3adelabs.com: canonical URLs, a sitemap, `robots.txt`, social card tags, structured data, and an `llms.txt` that lists the docs for AI assistants. Every page gets its own 1200 x 630 share image, drawn at build time from its title and description. The package, Python client and chart now name the site as their homepage.
- **Publishing to npm.** Releases now go to npmjs.com as well as GitHub Packages, with a check that the packed package installs and runs. `pnpm version:set` sets the version everywhere it must agree. See `RELEASING.md`.
- A license (MIT), a code of conduct, a security policy, contributing guidelines, and issue and pull request templates.

### Changed

- The relay URL error now says how to opt in to plain http on a trusted network.
- The website's headline and share images now say what the product does: run browsers anywhere, watch them live, drive them with any agent.
- The package is installed from npm (`pnpm add @degoke/browserbay`). GitHub Packages still carries every release.

## [0.1.0] - 2026-10-12

First release.

### Added

- **The box.** A relay that checks API keys and schedules, and browser nodes that dial out to it. Run both in one container (`browserbay start`), or one relay with any number of nodes on other machines, including behind NAT.
- **Slots.** Each browser is its own Chromium BrowserContext behind a scoped DevTools endpoint. A client sees its own pages and nothing else on that Chromium, tested against real Chromium. A slot's client is held to the web: no `file:` or `chrome:` pages, no file paths read into a page, no downloads.
- **Leases.** Every browser closes itself at its maximum lifetime, even if the client or the relay is gone.
- **Three separate secrets**: the API key, the slot token and the node enrollment secret. The relay stores only a hash of each node's secret.
- **A Node client**, `@degoke/browserbay/client`, to take, list, release and reconnect to browsers, with namespaces for sharing a box and `reap` to release orphans.
- **Live view support.** A second connection to a slot can watch a screencast and send mouse and key events without displacing the driver.
- **Docker images**, `ghcr.io/degoke/browserbay` (Chromium included) and `ghcr.io/degoke/browserbay-relay`, and a Compose file.
- A protocol version check between the relay and its nodes.

[Unreleased]: https://github.com/degoke/browserbay/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/degoke/browserbay/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/degoke/browserbay/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/degoke/browserbay/releases/tag/v0.1.0
