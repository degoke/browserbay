<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/degoke/browserbay/main/brand/lockup-reverse.png">
    <img src="https://raw.githubusercontent.com/degoke/browserbay/main/brand/lockup.png" alt="browserbay" width="380">
  </picture>
</h1>

<p align="center">
  <a href="https://github.com/degoke/browserbay/actions/workflows/ci.yml"><img src="https://github.com/degoke/browserbay/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@degoke/browserbay"><img src="https://img.shields.io/npm/v/@degoke/browserbay" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

**Run browsers anywhere. Watch them live. Drive them with any agent.**

Self-hosted browsers for AI agents and automation, as a service you deploy once and point any project at. Docs and guides: **[browserbay.3adelabs.com](https://browserbay.3adelabs.com)**.

You ask a box for a browser and get back a DevTools address and a token. What drives it is up to you: Playwright, Puppeteer, an AI agent loop, a screenshot service. The box does not know or care what is on the other end, which is what makes it reusable across projects.

```
your service A ─┐                          ┌─ node (anywhere): Chromium, one isolated context per slot
your service B ─┼──▶ relay (one instance) ◀┤
your service C ─┘    auth + scheduling     └─ node (another machine, behind NAT, a laptop…)
```

- **Isolated from each other.** Every browser is its own BrowserContext (own cookies, storage, cache) on a shared Chromium. A client sees its own pages and nothing else on that Chromium, tested against real Chromium including attempts to reach another slot. A slot's client is also held to the web: no `file:` or `chrome:` pages, no file paths read into a page. **Read [Trust](#trust-what-a-slot-token-is-and-what-it-is-not) before handing slot tokens to anyone you do not trust.**
- **Deploys anywhere.** `docker run` it on a VPS, a container platform, a Raspberry Pi. Nodes only ever connect **out** to the relay, so a node can sit behind NAT, and no DevTools port is open anywhere.
- **Scales by adding nodes.** Start with one container. Add capacity by running more nodes, wherever you like.
- **Does not announce itself as a bot.** A browser from a box looks like Chrome, not headless Chrome, and a slot can leave through its own proxy, from a node on your home connection, or in its own time zone and language. See [Avoid bot blocks](https://browserbay.3adelabs.com/docs/guides/avoid-bot-blocks/).
- **Hard to leak.** Three separate secrets, a leased lifetime on every browser so a crashed client does not hold one forever, and a protocol version check between relay and nodes.

## Quick start

```sh
export BROWSERBAY_API_KEY="$(openssl rand -base64 24)"   # keep it: your projects present it
docker run -d --name browserbay --restart always --init --stop-timeout 130 \
  -p 127.0.0.1:8788:8788 -e BROWSERBAY_API_KEY \
  ghcr.io/degoke/browserbay
```

That one container is a complete box: the relay and a Chromium node together. It listens on this machine only (`127.0.0.1`). Put it behind HTTPS (your platform's proxy, Caddy, a tunnel) before anything outside the machine talks to it: the API key and slot tokens travel to it. (`--stop-timeout 130` is the 120 s a stopping node gives slots in use, plus a margin.)

Or with Compose, from a checkout: `export BROWSERBAY_API_KEY=$(openssl rand -base64 24)` (or set `BROWSERBAY_API_KEYS`: see Several API keys), then `docker compose up -d`.

### Use it from Node

The client is published on npm as `@degoke/browserbay`, already built, so installing it needs no registry setup and no token:

```sh
pnpm add @degoke/browserbay
```

Every release is also published to [GitHub Packages](https://github.com/degoke/browserbay/pkgs/npm/browserbay), if you would rather install from there. That registry needs the scope pointed at it and a personal access token with `read:packages`, even for a public package. Point the scope at it in your project's `.npmrc`:

```ini
@degoke:registry=https://npm.pkg.github.com
```

and keep the token in your user-level `~/.npmrc` (not in the project, so it is never committed and nothing breaks where it is absent):

```ini
//npm.pkg.github.com/:_authToken=<your token>
```

In a Docker build that installs from GitHub Packages, hand the token to the install step as a BuildKit secret, so it never lands in an image layer:

```dockerfile
RUN --mount=type=secret,id=npm_token \
    printf '@degoke:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/npm_token)" > ~/.npmrc \
    && pnpm install --frozen-lockfile \
    && rm -f ~/.npmrc
```

with `docker build --secret id=npm_token,env=GITHUB_TOKEN .`.

```js
import { chromium } from 'playwright'
import { createBrowserBay } from '@degoke/browserbay/client'

const box = createBrowserBay({ url: 'https://browsers.example.com', apiKey: process.env.BROWSERBAY_API_KEY })

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

### Use it from Python or Go

There are clients for both, with the same behaviour as the Node one and no dependencies beyond the standard library. A slot saved by one can be revived by another.

```python
from browserbay import BrowserBay  # pip install "git+https://github.com/degoke/browserbay.git#subdirectory=clients/python"

box = BrowserBay("https://browsers.example.com", os.environ["BROWSERBAY_API_KEY"])
with box.acquire(run_id="task-42", max_lifetime_seconds=1800) as slot:   # released on exit
    browser = playwright.chromium.connect_over_cdp(slot.cdp_url, headers=slot.headers)
```

```go
box, _ := browserbay.New(browserbay.Options{URL: "https://browsers.example.com", APIKey: key}) // go get github.com/degoke/browserbay/clients/go
slot, err := box.Acquire(ctx, browserbay.AcquireOptions{RunID: "task-42", MaxLifetime: 30 * time.Minute})
defer slot.Release(ctx)
```

See [`clients/python`](clients/python/README.md) and [`clients/go`](clients/go/README.md).

### Use it from anything else

The client is a thin wrapper over a small HTTP and WebSocket API (types in [`src/protocol.ts`](src/protocol.ts)):

| Call                                                                                               | Auth                          | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/slots` `{ runId, maxLifetimeSeconds, waitMs?, proxy?, timezone?, locale?, nodeLabels? }` | `Authorization: Bearer <key>` | Takes a browser. `201 { slotId, token, nodeId, applied }` (token shown once; `applied` names the options the slot has), `503 no_capacity`, `422 unsupported` (nodes are connected and none could serve it: it asks for a proxy, a language or a label none has, or every node that has them refused the value, such as a time zone its system lacks; `message` says which), `403 forbidden` (a run id outside the key's namespace), `429 quota_exceeded`. `400` for a bad body: `runId` 1 to 200 characters, `maxLifetimeSeconds` 60 to 86400, a field it does not know, or a wrong option (`message` says which). `waitMs` defaults to 0 here (the client's default is 30 s) and is capped at the box's `BROWSERBAY_MAX_ACQUIRE_WAIT_MS`. |
| `GET /v1/slots`                                                                                    | API key                       | Lists slots (no tokens). A key confined to a namespace sees only its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DELETE /v1/slots/:id`                                                                             | API key                       | Releases a browser. Idempotent, `204`. A key confined to a namespace cannot release another namespace's slot: that answers `204` and does nothing, as for a slot that does not exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /v1/nodes`                                                                                    | API key                       | Lists nodes, their capacity and load. `403` for a key confined to a namespace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /v1/slots/:id`                                                                                | `x-browserbay-token: <token>` | `200` while the slot's browser is reachable, `404` when gone, `503` while its node reconnects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `WS /v1/cdp/:id`                                                                                   | `x-browserbay-token: <token>` | The slot's DevTools endpoint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /health`                                                                                      | none                          | `200` when the relay is up. It does not say a node has joined: look at `GET /v1/nodes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### The client

```js
const box = createBrowserBay({ url, apiKey, namespace?, allowOtherBoxes?: string[] | true, logger?, fetch?, now? })

box.acquire({ runId, maxLifetimeSeconds, waitMs?, proxy?, timezone?, locale?, nodeLabels? })  // → Slot
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

**Sharing one box between projects.** Give each project its own API key, confined to a namespace on the box (see [Several API keys](#several-api-keys)), and have its client use that `namespace`: slots are created as `<namespace>:<runId>`, and `list()` and `reap()` only see that project's. The relay then enforces it: a confined key cannot create, list or release another namespace's slots. Without a confined key, a `namespace` is only a naming convention and every holder of the API key can still reach every slot. Either way the projects share the node's Chromium process: see Trust before sharing a box between parties that should not trust each other.

## Deploy

### All-in-one (`browserbay start`, the default command)

| Variable                         | Default | Meaning                                                                                                                                                  |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSERBAY_API_KEY`             | —       | An unrestricted key, at least 16 characters. `openssl rand -base64 24` makes one. At least one of this and the next is required.                         |
| `BROWSERBAY_API_KEYS`            | —       | Keys for several services, each optionally confined to a namespace with a quota: see Several API keys.                                                   |
| `PORT`                           | `8788`  | Where the relay listens.                                                                                                                                 |
| `BROWSERBAY_MAX_CONTEXTS`        | `5`     | Concurrent slots (with `BROWSERBAY_ISOLATION=process`, concurrent Chromium processes). Size it to the machine's memory, and measure with your own pages. |
| `BROWSERBAY_MAX_ACQUIRE_WAIT_MS` | `60000` | The longest a client may wait for a free slot, whatever it asks for.                                                                                     |
| `BROWSERBAY_ENROLLMENT_SECRETS`  | —       | Optional: `name:sha256` entries that let remote nodes join this box (below).                                                                             |

Plus the node settings listed under the split deployment below (`BROWSERBAY_NODE_ID`, `BROWSERBAY_CHROMIUM_SANDBOX`, …). Give the container a restart policy of "always": the process leaves when Chromium does, and comes back with an empty box. `docker stop` and Compose give a container 10 seconds by default, less than the 120 a node waits for slots in use, so set `--stop-timeout` (Compose: `stop_grace_period`) to match `BROWSERBAY_DRAIN_SECONDS` plus a margin.

### Several API keys

One `BROWSERBAY_API_KEY` is an unrestricted key, which is all a single project needs. To share a box, give each project its own key in `BROWSERBAY_API_KEYS`, a comma-separated list of `name:sha256[:namespace[:quota]]` entries (the relay holds hashes, like the enrollment secrets). Make an entry with:

```sh
docker run --rm ghcr.io/degoke/browserbay key billing --namespace billing --quota 5
```

It prints the key for the service (its client's `apiKey`) and the entry for the relay. Both settings can be used together; `BROWSERBAY_API_KEY` is the key named `default`.

- **`namespace`** confines the key. It can only create slots whose run id starts with `<namespace>:` (the client does this when it is made with the same `namespace`; anything else is `403` / `ForbiddenError`), only lists and releases such slots (releasing another's answers `204` and does nothing, as for a slot that does not exist), and cannot list nodes. A key without one sees and releases everything: that is the operator's key.
- **`quota`** (needs a namespace) is the most slots the namespace may hold at once, counting browsers still being created. The next request is refused at once with `429` / `QuotaExceededError`; it does not wait for a slot to free up. Slots a restarted relay recovers from its nodes count too.
- Names, hashes and namespaces must each be unique across the entries.
- Slot tokens are unchanged: whoever holds a slot's token can drive that slot, whatever key made it.

#### A key you already have

`browserbay key` makes a key and its entry together. If the key already exists (a secret your service reads from its own settings, say), make the entry yourself. The relay wants the SHA-256 of the key as 64 hex characters, never the key:

```sh
printf %s "$KEY" | openssl dgst -sha256 | awk '{print $NF}'
```

Use `printf %s`, not `echo`. `echo` adds a newline, which changes the hash, and then the key is never accepted: every request is `401`. Put the hash in an entry on the box, and give the service the same key and the same namespace:

```sh
# on the box: name:hash:namespace:quota
BROWSERBAY_API_KEYS=billing:<hash>:billing:5
```

```ts
// on the service
createBrowserBay({ url, apiKey: process.env.BROWSERBAY_API_KEY, namespace: 'billing' })
```

The first field is a name for the key (the relay uses it in its logs; letters, digits, `_`, `.` and `-`). The third, the namespace, must be the word the client is made with. The fourth, the quota, is optional, so `billing:<hash>:billing` is a valid entry too. The relay only holds the hash, so it cannot check how strong the key is: make it at least 16 random characters (`openssl rand -base64 24` makes one).

### Kubernetes

A Helm chart in [`deploy/helm/browserbay`](deploy/helm/browserbay/README.md) runs one relay and the nodes as a separate Deployment, so the nodes scale on their own (by hand or with a HorizontalPodAutoscaler) without touching the relay. A node being removed finishes its browsers first. Nodes dial the relay's `https://` address, so serve the relay over HTTPS first (the chart has an ingress for it). It also has an `allInOne` mode: one pod that is a whole box.

```sh
helm install browserbay ./deploy/helm/browserbay -n browserbay --create-namespace \
  --set node.relayUrl=https://browsers.example.com --set relay.ingress.enabled=true  # plus the ingress host and TLS
kubectl -n browserbay scale deploy/browserbay-node --replicas=5
```

### Split: a relay and nodes

When you want browsers on several machines, run **one relay** and any number of nodes.

1. **Make the secrets.** One enrollment secret per node (or per group), and an API key:

   ```sh
   docker run --rm ghcr.io/degoke/browserbay secret laptop   # the secret for the node, and the `name:sha256` entry for the relay
   openssl rand -base64 24                                   # the API key
   ```

   (From a checkout, `node dist/cli.js secret laptop` and `node dist/cli.js key` (after `pnpm build`) do the same. From the published package, use the scoped name: `npx @degoke/browserbay secret laptop`. An unscoped `npx browserbay` is not this package.) The node gets the secret; the relay gets only its hash.

2. **Run the relay** (the `relay` image: no Chromium, about 230 MB). Exactly **one replica**: the nodes' sockets live in that process. Serve it over HTTPS with WebSocket support, at the root of its own hostname (or behind a proxy that strips a path prefix).

   ```sh
   docker run -d --restart always -p 8788:8788 \
     -e BROWSERBAY_API_KEY=... -e BROWSERBAY_ENROLLMENT_SECRETS=laptop:<sha256> \
     ghcr.io/degoke/browserbay-relay
   ```

3. **Run nodes** anywhere, from the `browserbay` image with the command `node`. A node needs no inbound port.

   ```sh
   docker run -d --restart always --init --stop-timeout 130 \
     -e BROWSERBAY_RELAY_URL=https://browsers.example.com -e BROWSERBAY_ENROLLMENT_SECRET=... \
     ghcr.io/degoke/browserbay node
   ```

   | Variable                              | Default                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                          |
   | ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `BROWSERBAY_RELAY_URL`                | —                          | **Required.** The relay's address. A node refuses `http://` unless the relay is on the same machine (or `BROWSERBAY_ALLOW_INSECURE_RELAY` is set), because the enrollment secret travels to it.                                                                                                                                                                                                  |
   | `BROWSERBAY_ALLOW_INSECURE_RELAY`     | `false`                    | `true` lets the relay address be plain `http://` or `ws://` when it is on a private network (a private IP range, a single-label name, or a `.svc`, `.internal` or `.local` name). The enrollment secret then crosses that network without TLS, so use it only on one you trust (a Kubernetes cluster's own network, say). A public address is still refused. A warning is logged on every start. |
   | `BROWSERBAY_ENROLLMENT_SECRET`        | —                          | **Required**, at least 16 characters.                                                                                                                                                                                                                                                                                                                                                            |
   | `BROWSERBAY_NODE_ID`                  | the hostname               | A name, unique per replica (a second node with the same name replaces the first): letters, digits, `_`, `.`, `-`.                                                                                                                                                                                                                                                                                |
   | `BROWSERBAY_MAX_CONTEXTS`             | `5`                        | Concurrent slots on this node, 1 to 100.                                                                                                                                                                                                                                                                                                                                                         |
   | `BROWSERBAY_DRAIN_SECONDS`            | `120`                      | How long a stopping node waits for its slots (on `SIGTERM`), 0 or more (empty means the default).                                                                                                                                                                                                                                                                                                |
   | `BROWSERBAY_ISOLATION`                | `context`                  | `process` starts a Chromium per slot instead of one shared by all: see Isolation.                                                                                                                                                                                                                                                                                                                |
   | `BROWSERBAY_NODE_LABELS`              | none                       | Comma-separated names for this node (`residential,eu`). A slot that asks for `nodeLabels` is only placed on a node with all of them: see Avoid bot blocks in the docs.                                                                                                                                                                                                                           |
   | `BROWSERBAY_NODE_EXCLUSIVE`           | `false`                    | `true` takes only the slots that ask for one of this node's labels, so ordinary slots do not fill (say) a machine on a home connection. Needs `BROWSERBAY_NODE_LABELS`.                                                                                                                                                                                                                          |
   | `BROWSERBAY_CHROMIUM_SANDBOX`         | `false`                    | `true` keeps Chromium's own sandbox on (needs user namespaces). See Isolation.                                                                                                                                                                                                                                                                                                                   |
   | `BROWSERBAY_HEADLESS`                 | `true` (the image: `xvfb`) | `xvfb` runs a headful browser on a virtual display the node starts: no `HeadlessChrome` in its user agent, and the Docker image's default. `true` is headless (about 150 MB less per node). `false` is headful on the display `DISPLAY` names. With `BROWSERBAY_ISOLATION=process` each slot gets its own display.                                                                               |
   | `BROWSERBAY_WEBDRIVER_FLAG`           | `hide`                     | `hide` turns `navigator.webdriver` off, which driving a browser over DevTools turns on. `keep` leaves it on, for a browser that says what it is.                                                                                                                                                                                                                                                 |
   | `BROWSERBAY_PROFILE_DIR`              | a fresh temp dir           | Chromium's profile. With `BROWSERBAY_ISOLATION=process`, the directory each slot's profile is made in (`<dir>/<slot id>`, removed with the slot).                                                                                                                                                                                                                                                |
   | `BROWSERBAY_CHROMIUM_ENV_PASSTHROUGH` | none                       | Comma-separated names of environment variables the browser should also see (see Trust). Never passes `BROWSERBAY_*`.                                                                                                                                                                                                                                                                             |
   | `BROWSERBAY_CHROMIUM_EXECUTABLE`      | the image's                | A Chromium other than the one in the image.                                                                                                                                                                                                                                                                                                                                                      |

   A box can also take remote nodes: set `BROWSERBAY_ENROLLMENT_SECRETS` on it and point the nodes at it. A node that cannot join says why in its log (an unreachable address, a wrong secret, an invalid id or slot count, a duplicate id) and keeps trying.

4. **Check it:**

   ```sh
   curl https://browsers.example.com/health
   curl -H "Authorization: Bearer $BROWSERBAY_API_KEY" https://browsers.example.com/v1/nodes
   ```

### Isolation: a shared Chromium, or one per slot

`BROWSERBAY_ISOLATION` is a node setting (the all-in-one box takes it too).

|                                               | `context` (default)                                        | `process`                                                |
| --------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| Browser                                       | one Chromium per node; each slot is a BrowserContext in it | one Chromium per slot, with its own profile directory    |
| A hostile or runaway page                     | can take every slot on the node with it                    | takes only its own slot                                  |
| Memory and start-up                           | light; a slot is ready at once                             | a few hundred MB per slot; about a second to start       |
| `page.pdf()`, tracing, `browser.newContext()` | refused                                                    | work                                                     |
| Ending a slot                                 | its context is disposed                                    | its Chromium is killed and its profile directory removed |

With `process`, a slot's browser that crashes ends that slot only (its client is disconnected, `slot.isAlive()` turns `false` at once, and the node carries on), where with `context` a crash ends the node. `BROWSERBAY_MAX_CONTEXTS` then counts Chromium processes, so size it for that: measure a slot's memory with your own pages.

What `process` does **not** change is how the slot is held away from the machine: the client still cannot open `file:` or `chrome:` pages, read a file path into a page, or choose where a download goes, and the browser still starts with an allowlisted environment. Those fences never depended on who else was on the browser. A page that escapes Chromium's renderer sandbox is also still inside the node's container or VM, so Chromium's own sandbox (`BROWSERBAY_CHROMIUM_SANDBOX=true`) matters just as much in either mode. Two browser-wide calls become available that you may not want a client to have: `SystemInfo` tells it about the machine's hardware, and `browser.newContext({ proxy })` lets it point a context at a proxy of its choosing, though not one that reaches the node itself (loopback and link-local addresses are refused, however they are spelled), because that is where a slot's own proxy forwarder and, in a box, the relay listen. A slot that was given a proxy keeps it for the contexts its client makes, unless the client names another.

### Secrets: three secrets, three jobs

- the **enrollment secret** lets a node join (node ↔ relay);
- the **API key** lets a service create, list and release browsers (never sent to a browser; one per service if you like);
- the **slot token** reaches one slot's browser (see Trust below for what that means).

## Trust: what a slot token is, and what it is not

**A slot token is control of a browser that runs on the node's machine.** Treat it as a credential for that machine's place on your network, not only for one page.

What the box does enforce, tested against real Chromium (`test/scope.browser.test.ts`):

- **Slots cannot reach each other.** Each slot is its own BrowserContext behind a virtual DevTools endpoint ([`src/node/scope.ts`](src/node/scope.ts)) that cannot see or reach another slot's pages, targets, contexts or sessions, including by guessing ids.
- **A client is held to the web.** It cannot point a page at `file:`, `chrome:`, `devtools:`, `view-source:` or `about:` pages other than blank (only `http(s)`, `data:` and `blob:`), cannot have the browser read a file path into a page (`DOM.setFileInputFiles`, dragging files in), and cannot choose where a download goes (downloads are denied from the start).
- **The browser does not inherit the node's secrets.** Chromium is started with an allowlisted environment, not the node's: `PATH`, `HOME`, the locale (`LANG`, `LC_*`), `TZ`, the display (`DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, `XDG_*`), library and font paths, and proxy and CA settings (`HTTP(S)_PROXY`, `NO_PROXY`, `SSL_CERT_*`). A headful node that needs more (`LIBGL_*`, `MESA_*`, `GTK_*`, `DBUS_SESSION_BUS_ADDRESS`) names it in `BROWSERBAY_CHROMIUM_ENV_PASSTHROUGH`; the box's own `BROWSERBAY_*` settings can never be passed.

What it does **not** do: it limits what a client can _ask_ of the machine, it does not make a client harmless.

- **A slot can browse anything the node's network can reach**: localhost services, the LAN, a cloud metadata address (`169.254.169.254`). That is SSRF, inherent in giving someone a browser.
- **The node process's own environment holds a secret** (a node's enrollment secret; in the all-in-one, the API key) and is readable by the browser's OS user through the process table. The restrictions above keep a client from asking for it; they are a filter on a very capable protocol, not a sandbox. Nothing here is proof against a flaw in that filter or in Chromium.
- **Slots on one node share a browser process** (unless the node runs with `BROWSERBAY_ISOLATION=process`: see Isolation), so a hostile page that crashes or exhausts it takes every slot on that node with it, and a renderer exploit is not contained by a VM. Chromium's own sandbox is the control for that: it is off by default (`--no-sandbox`) because containers rarely allow the user namespaces it needs; set `BROWSERBAY_CHROMIUM_SANDBOX=true` where yours does. A Chromium per slot stops one slot's page crashing the others, but it is not a boundary against an exploit: that still needs the sandbox, or a machine per party.

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
- **Stopping a node.** On `SIGTERM` it stops taking slots, waits up to `BROWSERBAY_DRAIN_SECONDS` for the current ones, then exits. The platform has to wait that long too (`docker stop --time`, Compose `stop_grace_period`, a Kubernetes `terminationGracePeriodSeconds`), or it kills the node first.
- **A create that does not finish.** If a node does not confirm a new slot in time, or its connection drops while it is being made, the relay tells the node to close it and will not adopt it later, so a slow node does not leave a browser holding a place that nobody can use.
- **Mismatched versions.** The node and the relay each announce their protocol version. The relay closes a node that speaks another one (code 4426) and the node logs a warning. Upgrade the relay and the nodes together.
- **Rotating an enrollment secret.** Add the new `name:sha256` to `BROWSERBAY_ENROLLMENT_SECRETS`, move the nodes to the new secret (restart them), then remove the old entry.
- **Bandwidth.** Watching a slot (a DevTools screencast) costs about the frame size times the frame rate through the node and the relay. Measured on loopback against a page that repaints every frame (the worst case), one watcher was about 60 frames per second at about 36 KB each, roughly 2 MB/s; a static page sends frames only when it repaints and costs far less. Budget the relay's network for that figure per concurrent watcher, and measure on your real network (`pnpm test:browser` prints it).

## Limits of this version

- One relay instance. The registry is in memory and recovered from the nodes; sharding it is a later step.
- Use the slot's own context: `browser.contexts()[0]`. On a node with the default isolation, a client may not create its own browser contexts (`browser.newContext()` is refused), because the slot _is_ the context; with `BROWSERBAY_ISOLATION=process` it may, and they are the slot's.
- Pages open only on `http(s)`, `data:`, `blob:` and `about:blank`. Downloads are denied. On a node with the default isolation the `IO` (streams: `page.pdf()`, tracing) and `Tracing` DevTools domains are denied too, as are `Storage`, `Memory` and `SystemInfo`; with `BROWSERBAY_ISOLATION=process` they are open.
- Uploads must be sent as data (Playwright's `setInputFiles({ name, mimeType, buffer })` does this for a remote client): a file path on the node is refused.
- Tested with Playwright 1.62. Other versions that speak a compatible DevTools protocol should work, but the Chromium in the image is the one that version ships.

## Development

```sh
pnpm install
pnpm test           # unit tests: relay, registry, node agent, scope hub (against a fake Chromium), client, CLI
pnpm test:browser   # the same paths against real Chromium, then the whole box as processes (needs Chromium: see below)
pnpm run ci         # typecheck + format check + unit tests (what CI runs first). `pnpm ci` is pnpm's own clean-install, not this
docker build -t browserbay .                         # the box image (Chromium included)
docker build --target relay -t browserbay-relay .    # the relay alone
```

`pnpm test:browser` uses Playwright's Chromium. Install it once with `pnpm exec playwright install chromium` (the first launch afterwards can take 20+ seconds on macOS while the system checks the download, longer than the node's 30 s startup allows, so run it once by hand first). (Playwright's install removes browsers that belong to other Playwright versions in the shared cache; set `PLAYWRIGHT_SKIP_BROWSER_GC=1` if other projects on this machine use that cache.)

Layout: everything is TypeScript under `src/`, compiled to `dist/` by `pnpm build` (which an install from git also runs, as the package's `prepare` step). `src/protocol.ts` (the wire contract, shared), `src/relay/` (the relay), `src/node/` (Chromium launch, the scope hub, the relay agent), `src/client/` (the client), `src/box/` (the all-in-one), `src/cli.ts` (the `browserbay` command). Tests sit next to what they test (`*.test.ts`) and run straight from source; the CLI tests run the built `dist/cli.js`.

The website (landing page and docs) is a separate Astro package in [`site/`](site/README.md), the logo files are in [`brand/`](brand/README.md), the Go and Python clients are in [`clients/`](clients), and the Helm chart is in [`deploy/helm/browserbay`](deploy/helm/browserbay/README.md). Each has its own checks in CI.

When you change `src/node/scope.ts`, re-run `pnpm test:browser`. `src/node/fake-chromium.ts` stands in for Chromium in the unit tests and must stay in step with it. A hub test that passes is not proof: mutate the hub (resume popups early, skip release cleanup, unfiltered `Target.getTargets`) and check that a test notices.

## Contributing

Bug reports, fixes and ideas are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers how to build and test each part, and what fits in the project: it is a box that lends out browsers, and nothing on top of it. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Changes are listed in the [changelog](CHANGELOG.md).

## Security

Please report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes, and not in a public issue. [Trust](#trust-what-a-slot-token-is-and-what-it-is-not) says what the box does and does not protect against.

## License

browserbay is released under the [MIT license](LICENSE). The Docker image also contains Chromium, Node.js and other software, each under its own license.
