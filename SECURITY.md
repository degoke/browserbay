# Security policy

browserbay lends out browsers that run on your machines, so security reports matter here. Thank you for taking the time to send one.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately instead:

1. Go to the repository's **Security** tab and choose **Report a vulnerability** (a private GitHub security advisory): https://github.com/degoke/browserbay/security/advisories/new
2. Say what you found, the version (`browserbay` image tag or package version), how it is deployed (all-in-one, relay and nodes, Kubernetes), and the steps to reproduce it. A small proof of concept helps most.

You will get a reply within a few days. We will work out the fix with you in the private advisory, release it, and credit you in the advisory and the changelog if you want that. Please give us a reasonable time to fix the problem before you publish details.

## What counts

Reports we want, because the box says it enforces them (see [Trust and isolation](README.md#trust-what-a-slot-token-is-and-what-it-is-not)):

- A way for one slot to see or reach another slot's pages, targets, contexts or sessions.
- A way around the limits on what a slot's client can do: opening `file:`, `chrome:`, `devtools:` or `view-source:` pages, having the browser read a file path into a page, choosing where a download goes, or using the denied DevTools domains.
- A flaw in the API key, slot token or enrollment secret checks: skipping them, guessing them, or learning one from another.
- The node's secrets reaching the browser's environment.
- A flaw in the relay and node protocol, such as one node impersonating another, or a client taking over a node.
- A secret written to a log or an error message.

## What does not count

These are documented limits of giving someone a browser, not vulnerabilities:

- **A slot can browse anything the node's network can reach**, including the LAN and cloud metadata addresses. Keep nodes on machines with nothing to steal and block private ranges with egress rules (the Helm chart has an optional network policy for this).
- **A slot token is control of a browser on the node's machine.** What someone does with a token you gave them is not a flaw in browserbay.
- **Slots on one node share a Chromium process** (unless the node runs with `BROWSERBAY_ISOLATION=process`, and even then a renderer exploit is not contained), so a hostile page can take down the other slots on that node.
- **The node's own process environment holds a secret** that its OS user can read.
- **`BROWSERBAY_ALLOW_INSECURE_RELAY`** sends the enrollment secret without TLS to a private address, by choice.
- **Bugs in Chromium itself.** Report those to the Chromium project.
- Denial of service by someone who already holds the API key or a slot token.

If you are unsure, report it anyway. We would rather read a report that turns out to be a known limit.

## Supported versions

Only the latest release gets security fixes while the project is on 0.x. Upgrade the relay and the nodes together.
