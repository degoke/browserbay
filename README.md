# browserbox

Browsers for AI agents and automation, as a service you deploy once and point any project at.

You ask a box for a browser and get back a DevTools address and a token. What drives it is up to you: Playwright, Puppeteer, an AI agent loop, a screenshot service. The box does not know or care what is on the other end, which is what makes it reusable across projects.

```
your service A ─┐                          ┌─ node (anywhere): Chromium, one isolated context per slot
your service B ─┼──▶ relay (one instance) ◀┤
your service C ─┘    auth + scheduling     └─ node (another machine, behind NAT, a laptop…)
```

- **Isolated.** Every browser is its own BrowserContext (own cookies, storage, cache) on a shared Chromium. A client sees its own pages and nothing else on that Chromium, and this is tested against real Chromium, including attempts to reach another slot.
- **Deploys anywhere.** `docker run` it on a VPS, a container platform, a Raspberry Pi. Nodes only ever connect **out** to the relay, so a node can sit behind NAT, and no DevTools port is open anywhere.
- **Scales by adding nodes.** Start with one container. Add capacity by running more nodes, wherever you like.
- **Safe by default.** Three separate secrets, a leased lifetime on every browser so a crashed client never leaks one, and a protocol version check between relay and nodes.

## Quick start

```sh
docker run -d --name browserbox --restart always --init \
  -p 8788:8788 -e BROWSERBOX_API_KEY="$(openssl rand -base64 24)" \
  ghcr.io/degoke/browserbox
```

That one container is a complete box: the relay and a Chromium node together. Put it behind HTTPS (your platform's proxy, Caddy, a tunnel) before anything outside the machine talks to it: the API key and slot tokens travel to it.

Or with Compose, from a checkout: `BROWSERBOX_API_KEY=$(openssl rand -base64 24) docker compose up`.

### Use it from Node

```sh
pnpm add github:degoke/browserbox#v0.1.0
```

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

`acquire` waits up to `waitMs` (default 30 s) for a free slot and throws `NoCapacityError` if the box stays full. Puppeteer works the same way (`puppeteer.connect({ browserWSEndpoint: slot.cdpUrl, headers: slot.headers })`; checked with puppeteer-core), and anything else that speaks the Chrome DevTools Protocol should too.

### Use it from anything else

The client is a thin wrapper over a small HTTP and WebSocket API (types in [`src/protocol.d.ts`](src/protocol.d.ts)):

| Call                                                      | Auth                          | Does                                                                                           |
| --------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /v1/slots` `{ runId, maxLifetimeSeconds, waitMs? }` | `Authorization: Bearer <key>` | Takes a browser. `201 { slotId, token, nodeId }` (token shown once), `503 no_capacity`.        |
| `GET /v1/slots`                                           | API key                       | Lists slots (no tokens).                                                                       |
| `DELETE /v1/slots/:id`                                    | API key                       | Releases a browser. Idempotent, `204`.                                                         |
| `GET /v1/nodes`                                           | API key                       | Lists nodes, their capacity and load.                                                          |
| `GET /v1/slots/:id`                                       | `x-browserbox-token: <token>` | `200` while the slot's browser is reachable, `404` when gone, `503` while its node reconnects. |
| `WS /v1/cdp/:id`                                          | `x-browserbox-token: <token>` | The slot's DevTools endpoint.                                                                  |
| `GET /health`                                             | none                          | `200` when the relay is up.                                                                    |

### The client

```js
const box = createBrowserBox({ url, apiKey, namespace?, logger?, fetch?, now? })

box.acquire({ runId, maxLifetimeSeconds, waitMs? })  // → Slot
box.slot(stored)                                      // a Slot from what you saved earlier; makes no request
box.list()                                            // slots (this namespace's, if you set one)
box.nodes()                                           // nodes and their load
box.reap({ isLive, graceMs?, skip? })                 // releases slots whose owner `isLive` says is gone

slot.cdpUrl  slot.headers  slot.slotId  slot.nodeId  slot.token
slot.isAlive()   // never throws; a box that cannot be asked counts as "not alive"
slot.release()   // idempotent
JSON.stringify(slot)   // what to save to come back to this browser later (it contains the token: store it like a secret)
```

`runId` is your own id for what the browser is for (a run, a task, a job). The box hands it back in `list()`, so `reap` can ask "is this still needed?" and release browsers a crash orphaned. **Reconnecting**: save `JSON.stringify(slot)`, later `box.slot(JSON.parse(saved))`, check `isAlive()`, and reconnect: the same pages are still there, which is how a service can hand a browser to a person and take it back.

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

Plus the node settings listed under the split deployment below (`BROWSERBOX_NODE_ID`, `BROWSERBOX_CHROMIUM_SANDBOX`, …). Give the container a restart policy of "always": the process leaves when Chromium does, and comes back with an empty box.

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
   docker run -d --restart always --init \
     -e BROWSERBOX_RELAY_URL=https://browsers.example.com -e BROWSERBOX_ENROLLMENT_SECRET=... \
     ghcr.io/degoke/browserbox node
   ```

   | Variable                         | Default          | Meaning                                                                                                                                           |
   | -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `BROWSERBOX_RELAY_URL`           | —                | **Required.** The relay's address. A node refuses `http://` unless the relay is on the same machine, because the enrollment secret travels to it. |
   | `BROWSERBOX_ENROLLMENT_SECRET`   | —                | **Required**, at least 16 characters.                                                                                                             |
   | `BROWSERBOX_NODE_ID`             | the hostname     | A name, unique per replica.                                                                                                                       |
   | `BROWSERBOX_MAX_CONTEXTS`        | `5`              | Concurrent slots on this node.                                                                                                                    |
   | `BROWSERBOX_DRAIN_SECONDS`       | `120`            | How long a stopping node waits for its slots (on `SIGTERM`).                                                                                      |
   | `BROWSERBOX_CHROMIUM_SANDBOX`    | `false`          | `true` keeps Chromium's own sandbox on (needs user namespaces). See Isolation.                                                                    |
   | `BROWSERBOX_HEADLESS`            | `true`           | `false` for a headful browser (needs a display).                                                                                                  |
   | `BROWSERBOX_PROFILE_DIR`         | a fresh temp dir | Chromium's profile.                                                                                                                               |
   | `BROWSERBOX_CHROMIUM_EXECUTABLE` | the image's      | A Chromium other than the one in the image.                                                                                                       |

   A box can also take remote nodes: set `BROWSERBOX_ENROLLMENT_SECRETS` on it and point the nodes at it.

4. **Check it:**

   ```sh
   curl https://browsers.example.com/health
   curl -H "Authorization: Bearer $BROWSERBOX_API_KEY" https://browsers.example.com/v1/nodes
   ```

### Secrets: three secrets, three jobs

- the **enrollment secret** lets a node join (node ↔ relay);
- the **API key** lets your services create, list and release browsers (never sent to a browser);
- the **slot token** reaches one slot's browser and nothing else.

## Isolation: read this before choosing where nodes run

A node shares one Chromium between slots. Each slot has its own BrowserContext (its own cookies, storage and cache) and a virtual DevTools endpoint that cannot see or reach another slot's pages, targets or contexts. That is enforced in [`src/node/scope.mjs`](src/node/scope.mjs) and tested against real Chromium, including attempts to reach another slot's browser (`test/scope.browser.test.ts`).

What it does **not** give you is the boundary of a VM per browser. Slots on one node share a browser process, so a hostile page that crashes or exhausts the browser takes every slot on that node with it, and a renderer exploit is not contained by a VM. Chromium's own sandbox is the control for that: it is off by default (`--no-sandbox`) because containers rarely allow the user namespaces it needs; set `BROWSERBOX_CHROMIUM_SANDBOX=true` where yours does. Keep contexts per node modest, and run nodes somewhere you would be comfortable running a browser that visits the sites you send it to.

## Operations

- **Chromium's `dbus` errors in the logs** ("Failed to connect to the bus") are harmless in a container: there is no desktop bus to find.
- **A node's browser crashes.** The node exits and the platform restarts it. Its slots are reported unreachable (`slot.isAlive()` is `false`); the next `acquire` gets a fresh browser. Nothing is retried on its own.
- **The relay restarts.** Nodes reconnect on their own and list the contexts they still hold, with a hash of each slot's token, so the relay adopts them and existing tokens keep working. A node whose control socket drops keeps its slots for about fifteen seconds before the relay gives up on it.
- **A client dies mid-use.** Every browser closes itself at its `maxLifetimeSeconds`, even while the relay is unreachable. For something sooner, run `box.reap(...)` on a schedule.
- **Stopping a node.** On `SIGTERM` it stops taking slots, waits up to `BROWSERBOX_DRAIN_SECONDS` for the current ones, then exits.
- **Mismatched versions.** The node and the relay each announce their protocol version. The relay closes a node that speaks another one (code 4426) and the node logs a warning. Upgrade the relay and the nodes together.
- **Rotating an enrollment secret.** Add the new `name:sha256` to `BROWSERBOX_ENROLLMENT_SECRETS`, move the nodes to the new secret (restart them), then remove the old entry.
- **Bandwidth.** Watching a slot (a DevTools screencast) costs about the frame size times the frame rate through the node and the relay. Measured on loopback against a page that repaints every frame (the worst case), one watcher was about 60 frames per second at about 36 KB each, roughly 2 MB/s; a static page sends frames only when it repaints and costs far less. Budget the relay's network for that figure per concurrent watcher, and measure on your real network (`pnpm test:browser` prints it).

## Limits of this version

- One relay instance. The registry is in memory and recovered from the nodes; sharding it is a later step.
- Use the slot's own context: `browser.contexts()[0]`. A client may not create its own browser contexts (`browser.newContext()` is refused), because the slot _is_ the context.
- Downloads are denied, and so are the `IO` (streams: `page.pdf()`, tracing) and `Tracing` DevTools domains.
- A single API key for the whole box (see "Sharing one box between projects").
- Tested with Playwright 1.62. Other versions that speak a compatible DevTools protocol should work, but the Chromium in the image is the one that version ships.

## Development

```sh
pnpm install
pnpm test           # unit tests: relay, registry, node agent, scope hub (against a fake Chromium), client, CLI
pnpm test:browser   # the same paths against real Chromium, then the whole box as processes (needs Chromium: see below)
pnpm ci             # typecheck + format check + unit tests (what CI runs first)
docker build -t browserbox .                         # the box image (Chromium included)
docker build --target relay -t browserbox-relay .    # the relay alone
```

`pnpm test:browser` uses Playwright's Chromium. Install it once with `pnpm exec playwright install chromium`. (Playwright's install removes browsers that belong to other Playwright versions in the shared cache; set `PLAYWRIGHT_SKIP_BROWSER_GC=1` if other projects on this machine use that cache.)

Layout: `src/protocol.js` (the wire contract, shared), `src/relay/` (TypeScript, compiled to `dist/` by `pnpm build`), `src/node/` (plain JavaScript, runs as it is: Chromium launch, the scope hub, the relay agent), `src/client/` (plain JavaScript with hand-written types, so it installs from git with no build step), `src/box/` (the all-in-one).

When you change `src/node/scope.mjs`, re-run `pnpm test:browser`. `src/node/fake-chromium.mjs` stands in for Chromium in the unit tests and must stay in step with it. A hub test that passes is not proof: mutate the hub (resume popups early, skip release cleanup, unfiltered `Target.getTargets`) and check that a test notices.
