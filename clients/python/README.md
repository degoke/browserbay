# browserbay for Python

A Python client for [browserbay](https://github.com/degoke/browserbay): ask a box for an isolated Chromium browser (a "slot"), drive it over the DevTools protocol with Playwright, Puppeteer or anything else that speaks CDP, and hand it back.

It uses the standard library only, so installing it adds no dependencies. Python 3.9 or newer.

## Install

This client is not on PyPI yet, so `pip install browserbay` finds nothing. Install it from the repository:

```sh
pip install "git+https://github.com/degoke/browserbay.git#subdirectory=clients/python"
```

## Quick start

With [Playwright for Python](https://playwright.dev/python/) (install it yourself: this package does not depend on it):

```python
import os
from browserbay import BrowserBay
from playwright.sync_api import sync_playwright

box = BrowserBay("https://browsers.example.com", os.environ["BROWSERBAY_API_KEY"])

with sync_playwright() as p, box.acquire(run_id="task-42", max_lifetime_seconds=1800) as slot:
    browser = p.chromium.connect_over_cdp(slot.cdp_url, headers=slot.headers)
    page = browser.contexts[0].new_page()
    page.goto("https://example.com")
    print(page.title())
# leaving the with block releases the browser
```

`acquire` waits up to `wait_ms` (default 30000) for a free slot. `max_lifetime_seconds` (60 to 86400) is a hard stop: the box closes the browser after that long whether or not anyone is connected. `run_id` is your own id for what the browser is for; `list()` and `reap()` hand it back to you.

## The client

```python
box = BrowserBay(url, api_key, namespace=None, allow_other_boxes=None, logger=None,
                 timeout=15.0, lookup_timeout=3.0, release_timeout=10.0, retry_delay=0.3)

box.acquire(run_id, max_lifetime_seconds, wait_ms=30000)  # -> Slot
box.slot(stored)                     # a Slot from what you saved earlier; makes no request
box.release(slot_id, url=None)       # releases a slot you only know the id of
box.list()                           # -> [SlotSummary] (this namespace's, if you set one)
box.nodes()                          # -> [NodeSummary]
box.reap(is_live, grace_ms=180000, skip=None)  # releases slots whose owner is gone; returns how many

slot.cdp_url  slot.headers  slot.slot_id  slot.node_id  slot.token
slot.is_alive()   # never raises; a box that cannot be asked counts as "not alive"
slot.release()    # idempotent
slot.to_dict()    # what to save to come back to this browser later
```

`SlotSummary` (`slot_id`, `run_id`, `node_id`, `created_at`) and `NodeSummary` (`node_id`, `max_contexts`, `contexts`, `draining`, `last_seen_at`) are frozen dataclasses.

**Reconnecting.** Save `json.dumps(slot.to_dict())`, later `box.slot(json.loads(saved))`, check `is_alive()` and connect again: the same pages are still there. The saved dict holds the slot token, so store it like a secret (it never contains the API key). It uses the same keys as the Node client's `JSON.stringify(slot)`, so either client can revive the other's slots.

**Where credentials go.** The API key and slot tokens are only sent to the box the client was made for. A stored slot that names a different box is refused, so a tampered row cannot redirect them. If your box moved while slots were live, list the old addresses: `allow_other_boxes=["https://old-box.example.com"]` (spelling does not matter: case, default ports and a trailing slash are normalised). `allow_other_boxes=True` trusts any address and is only for storage nobody else can write. Redirects are never followed.

**Sharing one box between projects.** Give each project a `namespace`: slots are created as `<namespace>:<run_id>`, and `list()` and `reap()` only see that project's, with the prefix removed. It is a naming convention, not access control.

**Reaping orphans.** After a crash, slots may outlive the work they were for:

```python
released = box.reap(
    is_live=lambda run_id: my_db.run_is_active(run_id),
    grace_ms=180_000,                              # slots younger than this are never reaped
    skip=lambda run_id: run_id.startswith("adhoc-"),  # ids nothing can vouch for
)
```

If `is_live` raises, that slot is left alone and the others are still checked.

## Async

`AsyncBrowserBay` and `AsyncSlot` take the same arguments and have the same methods, awaited. They run the blocking client in worker threads (`asyncio.to_thread`), with no extra dependencies:

```python
import asyncio
import os
from browserbay import AsyncBrowserBay
from playwright.async_api import async_playwright

box = AsyncBrowserBay("https://browsers.example.com", os.environ["BROWSERBAY_API_KEY"])

async def main() -> None:
    async with async_playwright() as p, await box.acquire(run_id="task-42", max_lifetime_seconds=1800) as slot:
        browser = await p.chromium.connect_over_cdp(slot.cdp_url, headers=slot.headers)
        page = await browser.contexts[0].new_page()
        await page.goto("https://example.com")
        print(await page.title())

asyncio.run(main())
```

`box.slot(stored)` makes no request, so it is not a coroutine. `box.reap` accepts plain or `async def` callbacks for `is_live` and `skip`.

## Errors

Every failure of the box or the network is a `BrowserBayError`; its `status` is the HTTP status, or `None` when the box could not be reached. A full box is a `NoCapacityError` (a subclass, status 503):

A key whose quota is used up is a `QuotaExceededError` (status 429, answered at once), and a key confined to another namespace is a `ForbiddenError` (403): make the client with the matching `namespace`. Both are subclasses too.

```python
from browserbay import BrowserBayError, NoCapacityError

try:
    slot = box.acquire(run_id="task-42", max_lifetime_seconds=1800, wait_ms=5000)
except NoCapacityError:
    ...  # every browser is busy: retry later, or queue the work
except BrowserBayError as error:
    print(error.status, error)  # e.g. 401 for a wrong API key
```

Bad arguments are caught before anything is sent: a `ValueError` for a value the box would refuse (a `run_id` over 200 characters counting the namespace, a lifetime outside 60 to 86400, an unusable box address or namespace) and a `TypeError` for the wrong type. Error messages never contain the API key or a slot token, and `repr(slot)` leaves the token out.

Leaving a `with` block releases the browser even when the block raised; a failing release does not replace the original error.

## License

This client is released under the [MIT license](LICENSE), like the rest of browserbay.
