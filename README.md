# browserbox

Browsers for AI agents and automation, as a service you deploy once and point any project at.

You ask a box for a browser and get back a DevTools address and a token. What drives it is up to you: Playwright, Puppeteer, an AI agent loop, a screenshot service. The box does not know or care what is on the other end, which is what makes it reusable across projects.

```
your service A ─┐                          ┌─ node (anywhere): Chromium, one isolated context per slot
your service B ─┼──▶ relay (one instance) ◀┤
your service C ─┘    auth + scheduling     └─ node (another machine, behind NAT, a laptop…)
```

- **Isolated from each other.** Every browser is its own BrowserContext (own cookies, storage, cache) on a shared Chromium. A client sees its own pages and nothing else on that Chromium, tested against real Chromium including attempts to reach another slot. A slot's client is also held to the web: no `file:` or `chrome:` pages, no file paths read into a page. **Read [Trust](#trust-what-a-slot-token-is-and-what-it-is-not) before handing slot tokens to anyone you do not trust.**
- **Deploys anywhere.** `docker run` it on a VPS, a container platform, a Raspberry Pi. Nodes only ever connect **out** to the relay, so a node can sit behind NAT, and no DevTools port is open anywhere.
- **Scales by adding nodes.** Start with one container. Add capacity by running more nodes, wherever you like.
- **Hard to leak.** Three separate secrets, a leased lifetime on every browser so a crashed client does not hold one forever, and a protocol version check between relay and nodes.

## Quick start

```sh
export BROWSERBOX_API_KEY="$(openssl rand -base64 24)"   # keep it: your projects present it
docker run -d --name browserbox --restart always --init --stop-timeout 130 \
  -p 127.0.0.1:8788:8788 -e BROWSERBOX_API_KEY \
  ghcr.io/degoke/browserbox
```

That one container is a complete box: the relay and a Chromium node together. It listens on this machine only (`127.0.0.1`). Put it behind HTTPS (your platform's proxy, Caddy, a tunnel) before anything outside the machine talks to it: the API key and slot tokens travel to it. (`--stop-timeout 130` is the 120 s a stopping node gives slots in use, plus a margin.)

Or with Compose, from a checkout: `export BROWSERBOX_API_KEY=$(openssl rand -base64 24)`, then `docker compose up -d`.

### Use it from Node

```sh
pnpm add github:degoke/browserbox#v0.1.0
```

If you install it inside a Docker build, pin a **commit** instead of the tag (`github:degoke/browserbox#<commit>`): a tag is looked up with `git ls-remote`, which a slim Node image does not have, and a full commit hash needs no lookup (and cannot be moved). The repository is public, so no credentials are needed either way.

```js
import { chromium } from 'playwright'
import { createBrowserBox } from 'browserbox/client'

const box = createBrowserBox({ url: 'https://browsers.example.com', apiKey: process.env.BROWSERBOX_API_KEY })

const slot = await box.acquire({ runId: 'task-42', maxLifetimeSeconds: 30 * 60 })
try {
  const browser = await chromium.connectOverCDP(slot.cdpUrl, { headers: slot.headers })
  const context = browser.contexts()[0] // your slot's context: use it, do not create another
  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto('https://example.com')
  console.log(await page.title())
} finally {
  await slot.release()
}
```

`acquire` waits up to `waitMs` (default 30 s) for a free slot and throws `NoCapacityError` if the box stays full. `maxLifetimeSeconds` is 60 to 86400, and `runId` up to 200 characters. Puppeteer works the same way (`puppeteer.connect({ browserWSEndpoint: slot.cdpUrl, headers: slot.headers })`; checked with puppeteer-core), and anything else that speaks the Chrome DevTools Protocol should too.

### Use it from anything else

The client is a thin wrapper over a small HTTP and WebSocket API (types in [`src/protocol.d.ts`](src/protocol.d.ts)):

| Call                                                      | Auth                          | Does                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/slots` `{ runId, maxLifetimeSeconds, waitMs? }` | `Authorization: Bearer <key>` | Takes a browser. `201 { slotId, token, nodeId }` (token shown once), `503 no_capacity`. `400` for a bad body: `runId` 1 to 200 characters, `maxLifetimeSeconds` 60 to 86400. `waitMs` defaults to 0 here (the client's default is 30 s) and is capped at the box's `BROWSERBOX_MAX_ACQUIRE_WAIT_MS`. |
| `GET /v1/slots`                                           | API key                       | Lists slots (no tokens).                                                                                                                                                                                                                                                                             |
| `DELETE /v1/slots/:id`                                    | API key                       | Releases a browser. Idempotent, `204`.                                                                                                                                                                                                                                                               |
| `GET /v1/nodes`                                           | API key                       | Lists nodes, their capacity and load.                                                                                                                                                                                                                                                                |
| `GET /v1/slots/:id`                                       | `x-browserbox-token: <token>` | `200` while the slot's browser is reachable, `404` when gone, `503` while its node reconnects.                                                                                                                                                                                                       |
| `WS /v1/cdp/:id`                                          | `x-browserbox-token: <token>` | The slot's DevTools endpoint.                                                                                                                                                                                                                                                                        |
| `GET /health`                                             | none                          | `200` when the relay is up. It does not say a node has joined: look at `GET /v1/nodes`.                                                                                                                                                                                                              |

### The client

```js
const box = createBrowserBox({ url, apiKey, namespace?, allowOtherBoxes?: string[] | true, logger?, fetch?, now? })

box.acquire({ runId, maxLifetimeSeconds, waitMs? })  // → Slot
box.slot(stored)                                      // a Slot from what you saved earlier; makes no request
box.release(slotId, { url? })                         // releases a slot you only know the id of
box.list()                                            // slots (this namespace's, if you set one)
box.nodes()                                           // nodes and their load
box.reap({ isLive, graceMs?, skip? })                 // releases slots whose owner `isLive` says is gone

slot.cdpUrl  slot.headers  slot.slotId  slot.nodeId  slot.token
slot.isAlive()   // never throws; a box that cannot be asked counts as "not alive"
slot.release()   // idempotent
JSON.stringify(slot)   // what to save to come back to this browser later (it contains the token: store it like a secret)
```

`runId` is your own id for what the browser is for (a run, a task, a job). The box hands it back in `list()`, so `reap` can ask "is this still needed?" and release browsers a crash orphaned. **Reconnecting**: save `JSON.stringify(slot)`, later `box.slot(JSON.parse(saved))`, check `isAlive()`, and reconnect: the same pages are still there, which is how a service can hand a browser to a person and take it back. Two cautions. The saved slot holds the slot token, so store it like a secret. And it names the box it lives on: the client only sends its API key and the slot token to _its own_ box, and refuses a saved slot that names another one, so a tampered row cannot redirect them. If your box moved while slots were live, list the old address(es) in `allowOtherBoxes: ['https://old-box.example.com']` and only those are trusted too (spelled however, `https://Old-Box.example.com:443/` is the same box). `allowOtherBoxes: true` trusts any address, which is only for storage nobody else can write. After a **relay restart**, nodes take up to about 15 seconds to reconnect, and until they do the relay does not know their slots: `isAlive()` can say `false` for a slot that is about to come back, so give it that long before deciding a browser is gone.

**Sharing one box between projects.** Give each project a `namespace`: slots are created as `<namespace>:<runId>`, and `list()` and `reap()` only see that project's. It is a naming convention, not access control: every holder of the API key can still reach every slot. Do not share a box between parties that should not trust each other.

## Deploy

### All-in-one (`browserbox start`, the default command)

| Variable                         | Default | Meaning                                                                             |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `BROWSERBOX_API_KEY`             | —       | **Required**, at least 16 characters. `openssl rand -base64 24` makes one.          |
| `PORT`                           | `8788`  | Where the relay listens.                                                            |
| `BROWSERBOX_MAX_CONTEXTS`        | `5`     | Concurrent slots. Size it to the machine's memory, and measure with your own pages. |
| `BROWSERBOX_MAX_ACQUIRE_WAIT_MS` | `60000` | The longest a client may wait for a free slot, whatever it asks for.                |
| `BROWSERBOX_ENROLLMENT_SECRETS`  | —       | Optional: `name:sha256` entries that let remote nodes join this box (below).        |

Plus the node settings listed under the split deployment below (`BROWSERBOX_NODE_ID`, `BROWSERBOX_CHROMIUM_SANDBOX`, …). Give the container a restart policy of "always": the process leaves when Chromium does, and comes back with an empty box. `docker stop` and Compose give a container 10 seconds by default, less than the 120 a node waits for slots in use, so set `--stop-timeout` (Compose: `stop_grace_period`) to match `BROWSERBOX_DRAIN_SECONDS` plus a margin.

### Split: a relay and nodes

When you want browsers on several machines, run **one relay** and any number of nodes.

1. **Make the secrets.** One enrollment secret per node (or per group), and an API key:

   ```sh
   docker run --rm ghcr.io/degoke/browserbox secret laptop   # the secret for the node, and the `name:sha256` entry for the relay
   openssl rand -base64 24                                   # the API key
   ```

   (From a checkout, `node bin/browserbox.mjs secret laptop` and `node bin/browserbox.mjs key` do the same. Do not use `npx browserbox`: that name on npm is an unrelated package.) The node gets the secret; the relay gets only its hash.

2. **Run the relay** (the `relay` image: no Chromium, about 230 MB). Exactly **one replica**: the nodes' sockets live in that process. Serve it over HTTPS with WebSocket support, at the root of its own hostname (or behind a proxy that strips a path prefix).

   ```sh
   docker run -d --restart always -p 8788:8788 \
     -e BROWSERBOX_API_KEY=... -e BROWSERBOX_ENROLLMENT_SECRETS=laptop:<sha256> \
     ghcr.io/degoke/browserbox-relay
   ```

3. **Run nodes** anywhere, from the `browserbox` image with the command `node`. A node needs no inbound port.

   ```sh
   docker run -d --restart always --init --stop-timeout 130 \
     -e BROWSERBOX_RELAY_URL=https://browsers.example.com -e BROWSERBOX_ENROLLMENT_SECRET=... \
     ghcr.io/degoke/browserbox node
   ```

   | Variable                              | Default          | Meaning                                                                                                                                           |
   | ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `BROWSERBOX_RELAY_URL`                | —                | **Required.** The relay's address. A node refuses `http://` unless the relay is on the same machine, because the enrollment secret travels to it. |
   | `BROWSERBOX_ENROLLMENT_SECRET`        | —                | **Required**, at least 16 characters.                                                                                                             |
   | `BROWSERBOX_NODE_ID`                  | the hostname     | A name, unique per replica (a second node with the same name replaces the first): letters, digits, `_`, `.`, `-`.                                 |
   | `BROWSERBOX_MAX_CONTEXTS`             | `5`              | Concurrent slots on this node, 1 to 100.                                                                                                          |
   | `BROWSERBOX_DRAIN_SECONDS`            | `120`            | How long a stopping node waits for its slots (on `SIGTERM`), 0 or more (empty means the default).                                                 |
   | `BROWSERBOX_CHROMIUM_SANDBOX`         | `false`          | `true` keeps Chromium's own sandbox on (needs user namespaces). See Isolation.                                                                    |
   | `BROWSERBOX_HEADLESS`                 | `true`           | `false` for a headful browser (needs a display).                                                                                                  |
   | `BROWSERBOX_PROFILE_DIR`              | a fresh temp dir | Chromium's profile.                                                                                                                               |
   | `BROWSERBOX_CHROMIUM_ENV_PASSTHROUGH` | none             | Comma-separated names of environment variables the browser should also see (see Trust). Never passes `BROWSERBOX_*`.                              |
   | `BROWSERBOX_CHROMIUM_EXECUTABLE`      | the image's      | A Chromium other than the one in the image.                                                                                                       |

   A box can also take remote nodes: set `BROWSERBOX_ENROLLMENT_SECRETS` on it and point the nodes at it. A node that cannot join says why in its log (an unreachable address, a wrong secret, an invalid id or slot count, a duplicate id) and keeps trying.

4. **Check it:**

   ```sh
   curl https://browsers.example.com/health
   curl -H "Authorization: Bearer $BROWSERBOX_API_KEY" https://browsers.example.com/v1/nodes
   ```

### Secrets: three secrets, three jobs

- the **enrollment secret** lets a node join (node ↔ relay);
- the **API key** lets your services create, list and release browsers (never sent to a browser);
- the **slot token** reaches one slot's browser (see Trust below for what that means).

## Trust: what a slot token is, and what it is not

**A slot token is control of a browser that runs on the node's machine.** Treat it as a credential for that machine's place on your network, not only for one page.

What the box does enforce, tested against real Chromium (`test/scope.browser.test.ts`):

- **Slots cannot reach each other.** Each slot is its own BrowserContext behind a virtual DevTools endpoint ([`src/node/scope.mjs`](src/node/scope.mjs)) that cannot see or reach another slot's pages, targets, contexts or sessions, including by guessing ids.
- **A client is held to the web.** It cannot point a page at `file:`, `chrome:`, `devtools:`, `view-source:` or `about:` pages other than blank (only `http(s)`, `data:` and `blob:`), cannot have the browser read a file path into a page (`DOM.setFileInputFiles`, dragging files in), and cannot choose where a download goes (downloads are denied from the start).
- **The browser does not inherit the node's secrets.** Chromium is started with an allowlisted environment, not the node's: `PATH`, `HOME`, the locale (`LANG`, `LC_*`), `TZ`, the display (`DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, `XDG_*`), library and font paths, and proxy and CA settings (`HTTP(S)_PROXY`, `NO_PROXY`, `SSL_CERT_*`). A headful node that needs more (`LIBGL_*`, `MESA_*`, `GTK_*`, `DBUS_SESSION_BUS_ADDRESS`) names it in `BROWSERBOX_CHROMIUM_ENV_PASSTHROUGH`; the box's own `BROWSERBOX_*` settings can never be passed.

What it does **not** do: it limits what a client can _ask_ of the machine, it does not make a client harmless.

- **A slot can browse anything the node's network can reach**: localhost services, the LAN, a cloud metadata address (`169.254.169.254`). That is SSRF, inherent in giving someone a browser.
- **The node process's own environment holds a secret** (a node's enrollment secret; in the all-in-one, the API key) and is readable by the browser's OS user through the process table. The restrictions above keep a client from asking for it; they are a filter on a very capable protocol, not a sandbox. Nothing here is proof against a flaw in that filter or in Chromium.
- **Slots on one node share a browser process**, so a hostile page that crashes or exhausts it takes every slot on that node with it, and a renderer exploit is not contained by a VM. Chromium's own sandbox is the control for that: it is off by default (`--no-sandbox`) because containers rarely allow the user namespaces it needs; set `BROWSERBOX_CHROMIUM_SANDBOX=true` where yours does.

So:

- Give slot tokens to **services you trust**, not to end users or to code you did not write. (A person watching and steering a slot through a viewer you build is fine: that viewer sends only mouse and key events, not DevTools commands.)
- Run nodes on **machines with nothing to steal** and, if the pages are untrusted, with egress rules that block private ranges and metadata addresses.
- Prefer the **split deployment** for anything sensitive: then the machines with browsers hold only a node's enrollment secret, and the API key stays on the relay's machine.
- To serve parties that do not trust each other, **run a box per party**. `namespace` is a naming convention, not a boundary.

## Operations

- **Chromium's `dbus` errors in the logs** ("Failed to connect to the bus") are harmless in a container: there is no desktop bus to find.
- **A node's browser crashes.** The node exits and the platform restarts it. Its slots are reported unreachable (`slot.isAlive()` is `false`); the next `acquire` gets a fresh browser. Nothing is retried on its own.
- **The relay restarts.** Nodes reconnect on their own and list the contexts they still hold, with a hash of each slot's token, so the relay adopts them and existing tokens keep working. A node whose control socket drops keeps its slots for about fifteen seconds before the relay gives up on it.
- **A client dies mid-use.** Every browser closes itself at its `maxLifetimeSeconds`, even while the relay is unreachable. For something sooner, run `box.reap(...)` on a schedule.
- **Stopping a node.** On `SIGTERM` it stops taking slots, waits up to `BROWSERBOX_DRAIN_SECONDS` for the current ones, then exits. The platform has to wait that long too (`docker stop --time`, Compose `stop_grace_period`, a Kubernetes `terminationGracePeriodSeconds`), or it kills the node first.
- **A create that does not finish.** If a node does not confirm a new slot in time, or its connection drops while it is being made, the relay tells the node to close it and will not adopt it later, so a slow node does not leave a browser holding a place that nobody can use.
- **Mismatched versions.** The node and the relay each announce their protocol version. The relay closes a node that speaks another one (code 4426) and the node logs a warning. Upgrade the relay and the nodes together.
- **Rotating an enrollment secret.** Add the new `name:sha256` to `BROWSERBOX_ENROLLMENT_SECRETS`, move the nodes to the new secret (restart them), then remove the old entry.
- **Bandwidth.** Watching a slot (a DevTools screencast) costs about the frame size times the frame rate through the node and the relay. Measured on loopback against a page that repaints every frame (the worst case), one watcher was about 60 frames per second at about 36 KB each, roughly 2 MB/s; a static page sends frames only when it repaints and costs far less. Budget the relay's network for that figure per concurrent watcher, and measure on your real network (`pnpm test:browser` prints it).

## Limits of this version

- One relay instance. The registry is in memory and recovered from the nodes; sharding it is a later step.
- Use the slot's own context: `browser.contexts()[0]`. A client may not create its own browser contexts (`browser.newContext()` is refused), because the slot _is_ the context.
- Pages open only on `http(s)`, `data:`, `blob:` and `about:blank`. Downloads are denied, and so are the `IO` (streams: `page.pdf()`, tracing) and `Tracing` DevTools domains.
- Uploads must be sent as data (Playwright's `setInputFiles({ name, mimeType, buffer })` does this for a remote client): a file path on the node is refused.
- A single API key for the whole box (see "Sharing one box between projects").
- Tested with Playwright 1.62. Other versions that speak a compatible DevTools protocol should work, but the Chromium in the image is the one that version ships.

## Development

```sh
pnpm install
pnpm test           # unit tests: relay, registry, node agent, scope hub (against a fake Chromium), client, CLI
pnpm test:browser   # the same paths against real Chromium, then the whole box as processes (needs Chromium: see below)
pnpm run ci         # typecheck + format check + unit tests (what CI runs first). `pnpm ci` is pnpm's own clean-install, not this
docker build -t browserbox .                         # the box image (Chromium included)
docker build --target relay -t browserbox-relay .    # the relay alone
```

`pnpm test:browser` uses Playwright's Chromium. Install it once with `pnpm exec playwright install chromium` (the first launch afterwards can take 20+ seconds on macOS while the system checks the download, longer than the node's 30 s startup allows, so run it once by hand first). (Playwright's install removes browsers that belong to other Playwright versions in the shared cache; set `PLAYWRIGHT_SKIP_BROWSER_GC=1` if other projects on this machine use that cache.)

Layout: `src/protocol.js` (the wire contract, shared), `src/relay/` (TypeScript, compiled to `dist/` by `pnpm build`), `src/node/` (plain JavaScript, runs as it is: Chromium launch, the scope hub, the relay agent), `src/client/` (plain JavaScript with hand-written types, so it installs from git with no build step), `src/box/` (the all-in-one).

When you change `src/node/scope.mjs`, re-run `pnpm test:browser`. `src/node/fake-chromium.mjs` stands in for Chromium in the unit tests and must stay in step with it. A hub test that passes is not proof: mutate the hub (resume popups early, skip release cleanup, unfiltered `Target.getTargets`) and check that a test notices.
