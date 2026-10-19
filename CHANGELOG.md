# Changelog

All notable changes to browserbay are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/). While it is on 0.x, a minor version may change behaviour: read the entry before upgrading, and upgrade the relay and the nodes together.

## [Unreleased]

### Added

- **A browser that does not announce itself.** A headless Chromium says `HeadlessChrome` in its user agent and client hints, has a screen smaller than its window, and (driven over DevTools) has `navigator.webdriver` on. Slots no longer do any of that unasked. The image now runs Chromium headful on a virtual display that the node starts (`BROWSERBAY_HEADLESS=xvfb`, the default of the image and of the Helm chart: `node.headless`), so there is no `HeadlessChrome` to hide. The display is closed to everything but the browser (an Xvfb with a cookie file only the node can read, over a local socket), and with `BROWSERBAY_ISOLATION=process` each slot gets a display of its own, so slots share neither a clipboard nor a crash. Nothing is faked: the user agent, WebGL and canvas are left as the browser reports them.
- **`BROWSERBAY_WEBDRIVER_FLAG`** (`hide`, the default, or `keep`). Chromium is started with `--disable-blink-features=AutomationControlled`, so `navigator.webdriver` is `false`. `keep` leaves it on, for a browser that should say what it is.
- **`scripts/smoke-box.mjs`**, a dependency-free check that takes a slot of a running box and fails if its browser says `HeadlessChrome`, has `navigator.webdriver` on, or has a screen smaller than its window. CI runs it against the image it builds, as the chart runs it (an unprivileged user, a read-only root, no capabilities).
- **A guide, [Avoid bot blocks](https://browserbay.3adelabs.com/docs/guides/avoid-bot-blocks/)**, on what a site sees, what the box fixes by itself and what is left for you.

### Changed

- **Upgrading the image makes nodes headful.** A node uses about 150 MB more memory (about 65 MB for Chromium and 80 MB for the display), and with `BROWSERBAY_ISOLATION=process` about that much more per slot. Set `BROWSERBAY_HEADLESS=true` (`node.headless=true` in the chart) to stay headless. Outside the image the default is still `true`: a node asks for Xvfb only when told to, and says so at startup if it is missing.
- **`BROWSERBAY_HEADLESS` is checked.** It takes `true`, `false` or `xvfb`; any other value stops the node at startup. Before, anything but `false` meant headless.
- **A headless Chromium's screen is 1920×1080** (it was 800×600, inside a 1280×900 window), and every Chromium starts with `--password-store=basic`. A headful one is started with the flags that keep a tab that is not in front painting and its timers running, and, on the virtual display, may use software WebGL (without it a headful Chromium with no GPU has none at all). See [Watching a headful node](https://browserbay.3adelabs.com/docs/guides/live-view/#watching-a-headful-node).
- **A slot whose display dies is reported as that**, not as the browser that went with it.
- **The docs say how to run the box with a read-only root filesystem.** It needs `HOME` pointed at a writable directory (and `/tmp` writable), because Chromium's crash reporter exits at start-up without one. That was already true of earlier images; it is now written down and checked: the image was run read-only with `HOME=/tmp` and its slot's browser passes the same check as without.
- **The browser tests run twice in CI,** headless and on a virtual display (set `BROWSERBAY_HEADLESS=xvfb` to run them that way locally).
- **The docs now cover a `BROWSERBAY_API_KEYS` entry for a key you already have**: how to hash it (with `printf %s`, not `echo`, whose newline changes the hash), what each field of the entry is, and that the relay cannot check the strength of a key it only holds a hash of. The README and the configuration page both have it, and the CLI reference points to it.

## [0.2.2] - 2026-10-14

### Fixed

- **Two wrong install lines in the client READMEs.** The Python client's README led with `pip install browserbay`, but the client is not on PyPI yet: it now leads with the install from the repository. The Go client's README gave a `go get ...@v0.1.0` example that cannot resolve, because no `clients/go` tag exists yet: it now explains the tags and how to pin a commit.
- **The CLI reference now says `start` and `node` need a Chromium** outside the Docker images: set `BROWSERBAY_CHROMIUM_EXECUTABLE`, or the process exits with "Chromium was not found". `secret` and `key` need no browser.

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

[Unreleased]: https://github.com/degoke/browserbay/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/degoke/browserbay/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/degoke/browserbay/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/degoke/browserbay/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/degoke/browserbay/releases/tag/v0.1.0
