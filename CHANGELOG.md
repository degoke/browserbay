# Changelog

All notable changes to browserbay are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/). While it is on 0.x, a minor version may change behaviour: read the entry before upgrading, and upgrade the relay and the nodes together.

## [Unreleased]

## [0.3.0] - 2026-10-19

### Added

- **A browser that does not announce itself.** A headless Chromium says `HeadlessChrome` in its user agent and client hints, has a screen smaller than its window, and (driven over DevTools) has `navigator.webdriver` on. Slots no longer do any of that unasked. The image now runs Chromium headful on a virtual display that the node starts (`BROWSERBAY_HEADLESS=xvfb`, the default of the image and of the Helm chart: `node.headless`), so there is no `HeadlessChrome` to hide. The display is closed to everything but the browser (an Xvfb with a cookie file only the node can read, over a local socket), and with `BROWSERBAY_ISOLATION=process` each slot gets a display of its own, so slots share neither a clipboard nor a crash. Nothing is faked: the user agent, WebGL and canvas are left as the browser reports them.
- **`BROWSERBAY_WEBDRIVER_FLAG`** (`hide`, the default, or `keep`). Chromium is started with `--disable-blink-features=AutomationControlled`, so `navigator.webdriver` is `false`. `keep` leaves it on, for a browser that should say what it is.
- **`scripts/smoke-box.mjs`**, a dependency-free check that takes a slot of a running box and fails if its browser says `HeadlessChrome`, has `navigator.webdriver` on, or has a screen smaller than its window. CI runs it against the image it builds, as the chart runs it (an unprivileged user, a read-only root, no capabilities).
- **A guide, [Avoid bot blocks](https://browserbay.3adelabs.com/docs/guides/avoid-bot-blocks/)**, on what a site sees, what the box fixes by itself and what is left for you.
- **A proxy per slot.** `acquire({ proxy: { server, username?, password?, bypass? } })` (`proxy=Proxy(...)` in Python, `Proxy: &ProxyOptions{...}` in Go) sends one slot's traffic through an `http://`, `https://` or `socks5://` proxy, so a slot can leave from an address that is not the box's. The credentials never reach Chromium, which takes none over DevTools and no SOCKS5 sign-in: the node starts a forwarder for the slot (a SOCKS5 listener on its own loopback, at a random address and port) and the forwarder opens each connection to your proxy and adds the credentials there. A proxy that refuses them is a page that fails to load, not a login prompt. A proxy at loopback, `169.254.169.254` or any address of the node itself is refused however it is spelled (`127.1`, `0x7f000001`, `[::ffff:7f00:1]`), and so is a name that resolves to one: the address a name resolved to is what is checked, and what is connected to. Localhost requests from a proxied slot go through the proxy too, and a node with a Chromium per slot starts a proxied slot's browser with a WebRTC policy that stops UDP past the proxy. The password is in no table, listing or log of the relay or the node.
- **Nodes can be labelled, and a slot can ask for a label.** `BROWSERBAY_NODE_LABELS=residential,eu` names a node, `acquire({ nodeLabels: ['residential'] })` places the slot only on a node with all of them, and `BROWSERBAY_NODE_EXCLUSIVE=true` keeps a node for the slots that ask. A node dials out, so one on a home or office connection, behind a router, is how a box gets an address that is not a datacenter's. In the Helm chart: `node.labels` and `node.exclusive`.
- **A time zone and a language per slot** on a node with `BROWSERBAY_ISOLATION=process`: `acquire({ timezone: 'Europe/Berlin', locale: 'de-DE' })` starts that slot's Chromium in them (`navigator.language`, `Accept-Language` and the `Intl` time zone agree). A box with a shared Chromium cannot do it per slot, so it says so rather than make a slot in the wrong zone.
- **Nodes say what they can do.** A node's hello carries `features` (`proxy`, `locale`), `labels` and `exclusive`, which `GET /v1/nodes` and the clients' node listings show. A relay only places a slot on a node that has what it asks for, and an older node, which says nothing, is never asked for a proxy it would have ignored. No protocol version change: a relay or a node that does not know the fields ignores them.
- **`UnsupportedError` / `ErrUnsupported`, and `422 unsupported`.** When nodes are connected and none could ever serve a request (none has the feature or label, or all are kept for labels), or every node that could refused the slot's value (a time zone its system lacks), the relay answers `422` at once with the reason, not `503 no_capacity` after the whole wait. A node's own words are quoted in the relay's sentence, as plain text. Just after the relay starts it waits as usual, because nodes may still be reconnecting.
- **A guide section, "Keep a session between runs", and browser tests for it.** A clearance cookie or a signed-in session can be kept by keeping the slot, or taken out with a driver's own cookie calls (`context.cookies()` and `addCookies()`, HttpOnly cookies included) and put into a new slot before its first request. Nothing is added to the box for it: the new tests (`test/session.browser.test.ts`, in both isolation modes) show it works, that a slot that was not given the session does not have it, and that a slot revived from its stored handle still holds its cookies. The guide says what a clearance cookie is tied to: the same exit address and the same browser.
- **Web Bot Auth: a box can say who it is.** A site that blocks bots can let known ones in, and a bot makes itself known by signing its requests (HTTP Message Signatures, RFC 9421) with a key whose public half it publishes. `browserbay web-bot-auth` makes the Ed25519 key. The relay, given it (`BROWSERBAY_WEB_BOT_AUTH_KEY`), serves the public half at `/.well-known/http-message-signatures-directory`, signed over the host that asked, as verifiers (Cloudflare's, to register a bot) want it. A node set to `BROWSERBAY_WEB_BOT_AUTH=optional` signs the slots that ask (`acquire({ signRequests: true })`; `sign_requests=True`, `SignRequests: &yes`), and `always` signs every slot's. `signRequests: true` is only placed on a node that signs with the key the relay publishes, so what a site verifies is what the box publishes. Off by default; in the chart: `webBotAuth.*`. It declares a bot and the box's address, which the guide says plainly.
- **How a slot is signed.** For each new tab of a signing slot the hub attaches a session of its own, turns request interception on there, follows frames in other processes into their own targets, and only then lets the tab run: the client's commands on the tab are held, in order, until that is done (at most 5 s, then the tab runs and a warning says so). Interception is added after Chromium's CORS check, so a signed cross-origin `fetch` sends no preflight and a strict server still answers; each hop of a redirect is signed for the host it goes to; popups, frames and workers' requests are covered. The hub's session lasts as long as the tab, whoever is connected. Measured against real Chromium, and the browser tests verify every request with Cloudflare's own `web-bot-auth` library, using the key the relay published.
- **Limits, in the guide.** WebSocket handshakes never pass through interception and go unsigned; the first request of a tab opened with a URL through `Target.createTarget({ url })` is made before anything can attach; requests of workers inside cross-site frames and of service and shared workers are not signed; and a client that replaces a request's whole header set with its own copy wins over the box (on a redirect, Playwright hands back the previous hop's headers, so the second hop carries the first hop's signature). Add headers with `context.setExtraHTTPHeaders()`, or route with `route.continue()` and no `headers`.

### Changed

- **Upgrading the image makes nodes headful.** A node uses about 150 MB more memory (about 65 MB for Chromium and 80 MB for the display), and with `BROWSERBAY_ISOLATION=process` about that much more per slot. Set `BROWSERBAY_HEADLESS=true` (`node.headless=true` in the chart) to stay headless. Outside the image the default is still `true`: a node asks for Xvfb only when told to, and says so at startup if it is missing.
- **`BROWSERBAY_HEADLESS` is checked.** It takes `true`, `false` or `xvfb`; any other value stops the node at startup. Before, anything but `false` meant headless.
- **A headless Chromium's screen is 1920×1080** (it was 800×600, inside a 1280×900 window), and every Chromium starts with `--password-store=basic`. A headful one is started with the flags that keep a tab that is not in front painting and its timers running, and, on the virtual display, may use software WebGL (without it a headful Chromium with no GPU has none at all). See [Watching a headful node](https://browserbay.3adelabs.com/docs/guides/live-view/#watching-a-headful-node).
- **A slot whose display dies is reported as that**, not as the browser that went with it.
- **The relay refuses a field of `POST /v1/slots` it does not know** (`400`, with a `message`), and `201` carries `applied`, the options the slot has. A relay that ignored an unknown field would hand an upgraded client a slot without its proxy, going out from the box's own address. Every client now checks `applied` whenever it asked for options, and if the box is older than them it releases the browser it was given and throws `UnsupportedError`. A request without options is the one a box has always taken. Upgrade the relay and the nodes together.
- **A `400` or `422` from `acquire` says why** in its message (the clients show it). It never repeats a proxy password.
- **`browser.newContext({ proxy })` on a node with a Chromium per slot is refused for an address of the node itself** (loopback and link-local, however spelled), and for a host name (use an IP address: a name can point at loopback), and a slot that was given a proxy keeps it for the contexts its client makes unless the client names another.
- **Go: `NodeSummary` has slices, so it can no longer be compared with `==`.** Compare the fields you use.
- **`RunHost.createRun` takes the slot's options,** and a node reaches a shared Chromium through `createScopeHost` (src/node/scope-host.ts), which owns each slot's forwarder.
- **`Signature-Agent` has two spellings, and the default is the one that verifies.** The IETF draft moved it to a dictionary (`sig1="https://..."`); Cloudflare's verifier, as of October 2026, still wants the quoted string and rejected the dictionary. `BROWSERBAY_WEB_BOT_AUTH_FORMAT` (`legacy`, the default, or `dictionary`) chooses. The signature the default makes is byte for byte what Cloudflare documents for the same inputs.
- **`browserbay web-bot-auth` is a command of its own,** not `browserbay secret web-bot-auth`: a node may already be called that.
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

[Unreleased]: https://github.com/degoke/browserbay/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/degoke/browserbay/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/degoke/browserbay/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/degoke/browserbay/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/degoke/browserbay/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/degoke/browserbay/releases/tag/v0.1.0
