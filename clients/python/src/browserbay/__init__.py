"""browserbay: borrow isolated Chromium browsers from a self-hosted browserbay box.

    from browserbay import BrowserBay

    box = BrowserBay("https://browsers.example.com", api_key)
    with box.acquire(run_id="task-42", max_lifetime_seconds=1800) as slot:
        ...  # e.g. playwright.chromium.connect_over_cdp(slot.cdp_url, headers=slot.headers)

Standard library only. :class:`AsyncBrowserBay` is the same client for asyncio.
"""

from ._async import AsyncBrowserBay, AsyncSlot
from ._client import (
    BrowserBay,
    BrowserBayError,
    ForbiddenError,
    NoCapacityError,
    QuotaExceededError,
    Slot,
    __version__,
)
from ._types import NodeSummary, SlotSummary, StoredSlot

__all__ = [
    "AsyncBrowserBay",
    "AsyncSlot",
    "BrowserBay",
    "BrowserBayError",
    "ForbiddenError",
    "NoCapacityError",
    "QuotaExceededError",
    "NodeSummary",
    "Slot",
    "SlotSummary",
    "StoredSlot",
    "__version__",
]
