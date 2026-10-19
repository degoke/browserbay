"""asyncio wrappers: the synchronous client run in worker threads (no extra dependencies)."""

from __future__ import annotations

import asyncio
import functools
import inspect
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Sequence, Union

from ._client import BrowserBay, Slot
from ._types import NodeSummary, Proxy, SlotSummary, StoredSlot


# `acquire` blocks a thread for up to `wait_ms` while a full box waits for room. On the loop's shared default pool
# (cpu + 4 threads) enough of them would leave no thread for the `release` that frees the room, so they get their own.
_ACQUIRE_WORKERS = 32


class AsyncSlot:
    """A :class:`Slot` for asyncio code: its network calls are awaited. Use ``async with`` to release on exit."""

    __slots__ = ("_slot",)

    def __init__(self, slot: Slot) -> None:
        self._slot = slot

    @property
    def sync(self) -> Slot:
        """The underlying blocking :class:`Slot`."""
        return self._slot

    @property
    def url(self) -> str:
        """The box this slot lives on."""
        return self._slot.url

    @property
    def slot_id(self) -> str:
        """The box's id for this slot."""
        return self._slot.slot_id

    @property
    def node_id(self) -> Optional[str]:
        """The node that runs this slot's browser, when known."""
        return self._slot.node_id

    @property
    def token(self) -> str:
        """Reaches this slot's browser and nothing else. Treat it as a secret."""
        return self._slot.token

    @property
    def cdp_url(self) -> str:
        """The DevTools endpoint to hand to Playwright's or Puppeteer's connect, together with :attr:`headers`."""
        return self._slot.cdp_url

    @property
    def headers(self) -> Dict[str, str]:
        """The headers every DevTools connection to this slot must carry. A fresh dict each time."""
        return self._slot.headers

    async def is_alive(self) -> bool:
        """True while the slot's browser is reachable. Never raises; see :meth:`Slot.is_alive`."""
        return await asyncio.to_thread(self._slot.is_alive)

    async def release(self) -> None:
        """Closes the browser. Idempotent; see :meth:`Slot.release`."""
        await asyncio.to_thread(self._slot.release)

    def to_dict(self) -> StoredSlot:
        """What to store to come back to this browser later; see :meth:`Slot.to_dict`."""
        return self._slot.to_dict()

    async def __aenter__(self) -> "AsyncSlot":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if exc_type is None:
            await self.release()
            return
        try:  # do not hide the error that is already on its way out
            await self.release()
        except Exception as error:
            logging.getLogger("browserbay").warning(
                "Could not release browser %s while leaving an async with block: %s", self.slot_id, error
            )

    def __repr__(self) -> str:
        return f"Async{self._slot!r}"


class AsyncBrowserBay:
    """The asyncio flavour of :class:`BrowserBay`: same arguments, same methods, awaited.

    ::

        box = AsyncBrowserBay("https://browsers.example.com", api_key)
        async with await box.acquire(run_id="task-42", max_lifetime_seconds=1800) as slot:
            ...

    Each call runs the blocking client in a worker thread with :func:`asyncio.to_thread`.
    """

    def __init__(
        self,
        url: str,
        api_key: str,
        namespace: Optional[str] = None,
        allow_other_boxes: Union[bool, Sequence[str], None] = None,
        logger: Optional[logging.Logger] = None,
        **options: Any,
    ) -> None:
        self._box = BrowserBay(url, api_key, namespace, allow_other_boxes, logger, **options)
        self._acquire_pool = ThreadPoolExecutor(max_workers=_ACQUIRE_WORKERS, thread_name_prefix="browserbay-acquire")

    @property
    def sync(self) -> BrowserBay:
        """The underlying blocking :class:`BrowserBay`."""
        return self._box

    @property
    def url(self) -> str:
        """The box's address, without trailing slashes."""
        return self._box.url

    async def acquire(
        self,
        run_id: str,
        max_lifetime_seconds: int,
        wait_ms: int = 30_000,
        *,
        proxy: Union[Proxy, Mapping[str, Any], None] = None,
        timezone: Optional[str] = None,
        locale: Optional[str] = None,
        node_labels: Optional[Sequence[str]] = None,
        sign_requests: Optional[bool] = None,
    ) -> AsyncSlot:
        """Takes a browser; see :meth:`BrowserBay.acquire`. Raises ``NoCapacityError`` when the box stays full."""
        call = functools.partial(
            self._box.acquire,
            run_id,
            max_lifetime_seconds,
            wait_ms,
            proxy=proxy,
            timezone=timezone,
            locale=locale,
            node_labels=node_labels,
            sign_requests=sign_requests,
        )
        slot = await asyncio.get_running_loop().run_in_executor(self._acquire_pool, call)
        return AsyncSlot(slot)

    def slot(self, stored: Mapping[str, Any]) -> AsyncSlot:
        """A slot you stored earlier. Makes no request (so it is not a coroutine); see :meth:`BrowserBay.slot`."""
        return AsyncSlot(self._box.slot(stored))

    async def release(self, slot_id: str, url: Optional[str] = None) -> None:
        """Releases a slot by its id; see :meth:`BrowserBay.release`."""
        await asyncio.to_thread(self._box.release, slot_id, url)

    async def list(self) -> List[SlotSummary]:
        """This service's slots; see :meth:`BrowserBay.list`."""
        return await asyncio.to_thread(self._box.list)

    async def nodes(self) -> List[NodeSummary]:
        """The box's nodes and their load; see :meth:`BrowserBay.nodes`."""
        return await asyncio.to_thread(self._box.nodes)

    async def reap(
        self,
        is_live: Callable[[str], Union[bool, Awaitable[bool]]],
        grace_ms: int = 3 * 60_000,
        skip: Optional[Callable[[str], Union[bool, Awaitable[bool]]]] = None,
    ) -> int:
        """Releases slots whose run ``is_live`` says no to; see :meth:`BrowserBay.reap`.

        ``is_live`` and ``skip`` may be plain functions or coroutine functions; coroutines run on the calling event loop.
        """
        loop = asyncio.get_running_loop()

        def settle(value: Any) -> Any:
            if not inspect.isawaitable(value):
                return value

            async def wait() -> Any:
                return await value

            return asyncio.run_coroutine_threadsafe(wait(), loop).result()

        def live(run_id: str) -> bool:
            return bool(settle(is_live(run_id)))

        skipper = None if skip is None else (lambda run_id: bool(settle(skip(run_id))))
        return await asyncio.to_thread(self._box.reap, live, grace_ms, skipper)
