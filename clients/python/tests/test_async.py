"""Tests for the asyncio wrappers."""

from __future__ import annotations

import asyncio
import json
import threading
import unittest
from typing import Any

from browserbay import AsyncBrowserBay, AsyncSlot, NoCapacityError

from fakebox import API_KEY, FakeBox


class AsyncClientTests(unittest.IsolatedAsyncioTestCase):
    def box(self, **options: Any) -> FakeBox:
        fake = FakeBox(**options)
        self.addCleanup(fake.close)
        return fake

    async def test_acquire_use_and_release_with_async_with(self) -> None:
        fake = self.box()
        box = AsyncBrowserBay(fake.url, API_KEY, namespace="app", retry_delay=0)
        async with await box.acquire(run_id="job-1", max_lifetime_seconds=600) as slot:
            self.assertIsInstance(slot, AsyncSlot)
            self.assertEqual(fake.calls[0].body["runId"], "app:job-1")  # type: ignore[index]
            self.assertTrue(await slot.is_alive())
            self.assertEqual(slot.cdp_url, f"ws://127.0.0.1:{fake.port}/v1/cdp/{slot.slot_id}")
            self.assertEqual(slot.headers, {"x-browserbay-token": slot.token})
            self.assertEqual([s.run_id for s in await box.list()], ["job-1"])
            self.assertEqual([n.node_id for n in await box.nodes()], ["node-1"])
        self.assertEqual(fake.slots, {})

    async def test_a_stored_slot_round_trips_and_release_by_id_works(self) -> None:
        fake = self.box()
        box = AsyncBrowserBay(fake.url, API_KEY, retry_delay=0)
        slot = await box.acquire("job-2", 600)
        stored = json.loads(json.dumps(slot.to_dict()))
        before = len(fake.calls)
        revived = box.slot(stored)  # no request, so no await
        self.assertEqual(len(fake.calls), before)
        self.assertEqual(revived.cdp_url, slot.cdp_url)
        self.assertTrue(await revived.is_alive())
        await box.release(slot.slot_id)
        self.assertFalse(await revived.is_alive())
        await revived.release()  # idempotent

    async def test_waiting_acquires_do_not_starve_a_release(self) -> None:
        # A full box holds each acquire for the whole wait. Releases are what free room, so they must not queue behind them.
        fake = self.box()
        box = AsyncBrowserBay(fake.url, API_KEY, retry_delay=0)
        gate = threading.Event()

        def blocked_acquire(*args: Any) -> None:
            gate.wait(10)
            raise NoCapacityError()

        box.sync.acquire = blocked_acquire  # type: ignore[method-assign]
        waiting = [asyncio.ensure_future(box.acquire(f"job-{i}", 600)) for i in range(40)]  # more than any default pool
        try:
            await asyncio.sleep(0.2)
            await asyncio.wait_for(box.release("some-slot"), 3)  # on a shared pool this would wait for the acquires
        finally:
            gate.set()
            await asyncio.gather(*waiting, return_exceptions=True)

    async def test_a_full_box_raises_no_capacity_error(self) -> None:
        box = AsyncBrowserBay(self.box(create_status=503).url, API_KEY)
        with self.assertRaises(NoCapacityError):
            await box.acquire("job", 600)

    async def test_async_with_releases_when_the_block_raises(self) -> None:
        fake = self.box()
        box = AsyncBrowserBay(fake.url, API_KEY)
        with self.assertRaisesRegex(RuntimeError, "boom"):
            async with await box.acquire("job", 600):
                raise RuntimeError("boom")
        self.assertEqual(fake.slots, {})

    async def test_reap_accepts_plain_and_coroutine_callbacks(self) -> None:
        fake = self.box()
        fake.seed("live", "run-live", 30)
        fake.seed("dead", "run-dead", 30)
        fake.seed("skipped", "capture-1", 30)
        box = AsyncBrowserBay(fake.url, API_KEY)

        async def is_live(run_id: str) -> bool:
            await asyncio.sleep(0)  # really awaits on the event loop
            return run_id == "run-live"

        released = await box.reap(is_live, skip=lambda run_id: run_id.startswith("capture-"))
        self.assertEqual(released, 1)
        self.assertEqual(sorted(fake.slots), ["live", "skipped"])
        self.assertEqual(await box.reap(lambda run_id: False, grace_ms=0), 2)  # a plain function works too


if __name__ == "__main__":
    unittest.main()
