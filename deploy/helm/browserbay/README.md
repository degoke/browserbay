# browserbay Helm chart

Runs [browserbay](../../../README.md) on Kubernetes: one relay, and browser nodes that scale on their own.

The full guide, with the reasoning behind each setting, is in the docs: `site/src/content/docs/docs/deploy/kubernetes.mdx`.

## Modes

| `mode`            | What runs                                                        | Scales                                                           |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `split` (default) | A relay Deployment (one replica) and a separate node Deployment. | Nodes scale on their own: `node.replicas` or `node.autoscaling`. |
| `allInOne`        | One pod that is the relay and a Chromium node together.          | It does not.                                                     |

## Install

```sh
# split mode: the nodes need the relay's https address (they refuse plain http), so serve the relay first
helm install browserbay ./deploy/helm/browserbay -n browserbay --create-namespace \
  --set node.relayUrl=https://browsers.example.com \
  --set relay.ingress.enabled=true --set relay.ingress.className=nginx \
  --set 'relay.ingress.hosts[0].host=browsers.example.com' \
  --set 'relay.ingress.hosts[0].paths[0].path=/' \
  --set 'relay.ingress.tls[0].secretName=browsers-tls' \
  --set 'relay.ingress.tls[0].hosts[0]=browsers.example.com'

# all-in-one, to try it
helm install browserbay ./deploy/helm/browserbay -n browserbay --create-namespace --set mode=allInOne
kubectl -n browserbay port-forward svc/browserbay 8788:8788
```

The install prints how to read the API key.

## Scale the nodes

```sh
kubectl -n browserbay scale deploy/browserbay-node --replicas=5
```

or `--set node.autoscaling.enabled=true` (CPU based, with a slow scale-down). A node being removed finishes its browsers first, up to `node.drainSeconds`; the pod's grace period is that plus 10 seconds.

## Values

| Key                                                  | Default                                  | Meaning                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `mode`                                               | `split`                                  | `split` or `allInOne`.                                                                                                  |
| `image.repository` / `tag`                           | `ghcr.io/degoke/browserbay` / appVersion | The box image: the nodes, and the all-in-one pod.                                                                       |
| `relayImage.repository` / `tag`                      | `ghcr.io/degoke/browserbay-relay`        | The relay image (no Chromium).                                                                                          |
| `auth.existingSecret`                                | none                                     | A Secret you manage, with `apiKey`, `enrollmentSecret` and `enrollmentSecrets`.                                         |
| `auth.apiKey`, `auth.enrollmentSecret`               | generated                                | Choose your own (16+ characters). Otherwise made once and kept across upgrades.                                         |
| `relay.ingress.*`                                    | off                                      | Serve the relay over HTTPS, with WebSocket support and long timeouts.                                                   |
| `relay.maxAcquireWaitMs`                             | `60000`                                  | The longest a client may wait for a free slot.                                                                          |
| `node.relayUrl`                                      | none                                     | **Required in split mode.** The relay's `https://` address.                                                             |
| `node.allowInsecureRelay`                            | `false`                                  | Let nodes reach the relay's in-cluster Service over plain http, on a network you trust.                                 |
| `node.replicas`                                      | `2`                                      | Nodes, unless autoscaling is on.                                                                                        |
| `node.maxContexts`                                   | `5`                                      | Browsers per node.                                                                                                      |
| `node.headless`                                      | `xvfb`                                   | `xvfb`: headful on a virtual display (no `HeadlessChrome`). `true`: headless. About 150 MB less.                        |
| `node.labels`, `node.exclusive`                      | none, `false`                            | Names for the nodes (`residential`) that a client can ask for; `exclusive` keeps them for those slots.                  |
| `webBotAuth.*`                                       | `mode: off`                              | Sign the browsers' requests (Web Bot Auth): `mode`, `agentUrl`, `existingSecret` or `key`. The relay publishes the key. |
| `node.drainSeconds`                                  | `120`                                    | How long a stopping node waits for its browsers.                                                                        |
| `node.resources`                                     | 1 CPU / 2 Gi, limit 4 Gi                 | Per node pod. Chromium needs several hundred MB per browser.                                                            |
| `node.autoscaling.*`                                 | off                                      | A HorizontalPodAutoscaler on the node Deployment.                                                                       |
| `node.podDisruptionBudget.*`                         | on, `maxUnavailable: 1`                  | Keeps most nodes through a cluster drain.                                                                               |
| `node.networkPolicy.dnsPeers`                        | kube-dns pods                            | Where the node pods may send DNS. Change it for NodeLocal DNSCache or differently labelled DNS.                         |
| `node.networkPolicy.*`                               | off                                      | Keeps browsers off private ranges and the metadata address.                                                             |
| `node.extraEnv`, `extraVolumes`, `extraVolumeMounts` | none                                     | For example a private CA bundle.                                                                                        |
| `allInOne.acceptRemoteNodes`                         | `false`                                  | Let nodes elsewhere join the all-in-one box.                                                                            |

## Things to know

- **Several API keys and isolation.** The chart makes one unrestricted key. `BROWSERBAY_API_KEYS` (keys confined to namespaces, with quotas) and `BROWSERBAY_ISOLATION=process` (a Chromium per slot) are plain environment variables: pass them with `relay.extraEnv` and `node.extraEnv` (both in `node.extraEnv` for all-in-one). The chart does not test them.
- **Nodes and plain http.** A node refuses a plain `http://` relay on another machine, because the enrollment secret travels to it. `node.allowInsecureRelay: true` opts in for a private network you trust (a public address is still refused): the nodes then use the in-cluster Service (`http://<release>-browserbay.<namespace>.svc:8788`) with no ingress or certificate, and log a warning on every start.
- **Rolling updates.** `node.minReadySeconds` (30) keeps a node that exits at once, because of a bad address or secret, from replacing a working one. A node that stays up but cannot reach the relay is not caught: check `/v1/nodes` after an upgrade.
- **The relay is one replica.** It uses the `Recreate` strategy, so an upgrade of the relay has a short gap. Nodes reconnect within about 15 seconds and keep their browsers.
- **Generated secrets and GitOps.** The chart reads existing secrets back with `lookup`, which `helm template` and Argo CD cannot do. There, set `auth.existingSecret`.
- **Values are validated.** `values.schema.json` rejects unknown keys and wrong types, so a misspelled setting such as `node.networkpolicy.enabled` is an install error, not silently ignored.
- **No Helm repository yet.** Install from a checkout, as above.

## Checks

```sh
helm lint deploy/helm/browserbay -f deploy/helm/browserbay/ci/split-values.yaml
for f in deploy/helm/browserbay/ci/*.yaml; do helm template t deploy/helm/browserbay -f "$f" > /dev/null; done
```

Both modes were also installed on a Kubernetes 1.27 cluster (kind) and driven with Playwright.
