"""Tests for the synchronous client, against a fake box on a local HTTP server."""

from __future__ import annotations

import dataclasses
import json
import logging
import unittest
from typing import Any, List

from browserbay import (
    BrowserBay,
    BrowserBayError,
    ForbiddenError,
    NodeSummary,
    NoCapacityError,
    Proxy,
    QuotaExceededError,
    Slot,
    SlotSummary,
    UnsupportedError,
)

from fakebox import API_KEY, TOKEN_HEADER, FakeBox

NOW = 1_800_000_000.0  # a fixed clock for the grace-period tests


class BoxTestCase(unittest.TestCase):
    def box(self, **options: Any) -> FakeBox:
        fake = FakeBox(**options)
        self.addCleanup(fake.close)
        return fake

    def client(self, fake: FakeBox, **options: Any) -> BrowserBay:
        options.setdefault("retry_delay", 0)
        return BrowserBay(options.pop("url", fake.url), API_KEY, **options)

    def acquire(self, service: BrowserBay, run_id: str = "run-1", **extra: Any) -> Slot:
        return service.acquire(run_id, extra.pop("max_lifetime_seconds", 3000), **extra)


class ConstructionTests(BoxTestCase):
    def test_refuses_an_address_or_key_it_cannot_use_up_front(self) -> None:
        with self.assertRaisesRegex(ValueError, "not a URL"):
            BrowserBay("not a url", API_KEY)
        with self.assertRaisesRegex(ValueError, r"http\(s\)"):
            BrowserBay("ftp://browsers.example.com", API_KEY)
        with self.assertRaisesRegex(ValueError, "credentials"):
            BrowserBay("https://user:pw@browsers.example.com", API_KEY)
        for with_query in ["https://b.example.com?tenant=a", "https://b.example.com/#top", "https://b.example.com?"]:
            with self.assertRaisesRegex(ValueError, "query or a fragment", msg=with_query):
                BrowserBay(with_query, API_KEY)
        with self.assertRaisesRegex(ValueError, "api_key"):
            BrowserBay("https://browsers.example.com", "")
        with self.assertRaises(TypeError):
            BrowserBay("https://browsers.example.com", None)  # type: ignore[arg-type]

    def test_refuses_a_namespace_that_could_be_mistaken_for_another(self) -> None:
        for namespace in ["app:staging", "has space", "a/b", "é", "ok\n"]:
            with self.assertRaisesRegex(ValueError, "namespace", msg=repr(namespace)):
                BrowserBay("https://browsers.example.com", API_KEY, namespace=namespace)
        for namespace in ["production", "eu-west_1.app"]:
            BrowserBay("https://browsers.example.com", API_KEY, namespace=namespace)

    def test_an_empty_namespace_is_no_namespace(self) -> None:
        fake = self.box()
        self.acquire(self.client(fake, namespace=""), "plain")
        self.assertEqual(fake.calls[0].body["runId"], "plain")  # type: ignore[index]

    def test_a_list_of_addresses_that_are_not_addresses_is_found_at_once(self) -> None:
        with self.assertRaisesRegex(ValueError, "not a URL"):
            BrowserBay("https://b.example.com", API_KEY, allow_other_boxes=["not a url"])
        with self.assertRaisesRegex(ValueError, r"http\(s\)"):
            BrowserBay("https://b.example.com", API_KEY, allow_other_boxes=["ftp://old.example.com"])
        with self.assertRaises(TypeError):
            BrowserBay("https://b.example.com", API_KEY, allow_other_boxes="https://old.example.com")  # type: ignore[arg-type]


class AcquireTests(BoxTestCase):
    def test_validates_run_id_lifetime_and_wait_before_asking_the_box(self) -> None:
        fake = self.box()
        service = self.client(fake, namespace="production")
        for run_id in ["", "x" * 200]:
            with self.assertRaisesRegex(ValueError, "run_id must be"):
                service.acquire(run_id, 600)
        with self.assertRaisesRegex(TypeError, "run_id must be"):
            service.acquire(None, 600)  # type: ignore[arg-type]
        for lifetime in [0, 59, 86_401, 1.5, float("nan"), float("inf")]:
            with self.assertRaisesRegex(ValueError, "max_lifetime_seconds must be a whole number from 60 to 86400"):
                service.acquire("ok", lifetime)  # type: ignore[arg-type]
        for lifetime in ["600", None, True]:
            with self.assertRaisesRegex(TypeError, "max_lifetime_seconds must be a whole number"):
                service.acquire("ok", lifetime)  # type: ignore[arg-type]
        for wait in [2.5, -1, float("nan"), float("inf")]:
            with self.assertRaisesRegex(ValueError, "wait_ms must be a whole number of milliseconds"):
                service.acquire("ok", 600, wait)  # type: ignore[arg-type]
        for wait in ["5", None]:
            with self.assertRaisesRegex(TypeError, "wait_ms must be a whole number of milliseconds"):
                service.acquire("ok", 600, wait)  # type: ignore[arg-type]
        self.assertEqual(fake.calls, [], "nothing was asked of the box to find that out")
        service.acquire("ok", 600, wait_ms=0)
        service.acquire("x" * (200 - len("production:")), 60)
        service.acquire("ok", 86_400)
        service.acquire("ok", 600.0)  # a whole number, however it is spelled

    def test_the_run_id_limit_counts_like_the_box_does(self) -> None:
        # 100 emoji are 100 characters in Python but 200 UTF-16 units in JavaScript, which is what the box counts.
        service = self.client(self.box())
        service.acquire("\U0001f600" * 100, 600)
        with self.assertRaisesRegex(ValueError, "run_id must be"):
            service.acquire("\U0001f600" * 101, 600)

    def test_asks_the_box_for_a_slot_with_the_api_key_the_wait_and_the_lifetime(self) -> None:
        fake = self.box()
        self.acquire(self.client(fake, url=f"{fake.url}/"))
        call = fake.calls[0]
        self.assertEqual((call.method, call.path), ("POST", "/v1/slots"))
        self.assertEqual(call.headers["authorization"], f"Bearer {API_KEY}")
        self.assertEqual(call.headers["content-type"], "application/json")
        self.assertEqual(call.body, {"runId": "run-1", "maxLifetimeSeconds": 3000, "waitMs": 30_000})

        impatient = self.box()
        self.acquire(self.client(impatient), "run-2", wait_ms=5000)
        self.assertEqual(impatient.calls[0].body["waitMs"], 5000)  # type: ignore[index]
        no_wait = self.box()
        self.acquire(self.client(no_wait), "run-3", wait_ms=0)
        self.assertEqual(no_wait.calls[0].body["waitMs"], 0, 'zero means do not wait, not "use the default"')  # type: ignore[index]

    def test_accepts_keyword_arguments(self) -> None:
        fake = self.box()
        slot = self.client(fake).acquire(run_id="kw", max_lifetime_seconds=120, wait_ms=10)
        self.assertEqual(fake.calls[0].body, {"runId": "kw", "maxLifetimeSeconds": 120, "waitMs": 10})
        self.assertEqual(slot.slot_id, "slot-1")

    def test_with_a_namespace_the_run_id_is_prefixed(self) -> None:
        fake = self.box()
        self.acquire(self.client(fake, namespace="production"))
        self.assertEqual(fake.calls[0].body["runId"], "production:run-1")  # type: ignore[index]
        plain = self.box()
        self.acquire(self.client(plain))
        self.assertEqual(plain.calls[0].body["runId"], "run-1")  # type: ignore[index]

    def test_a_slot_carries_what_it_takes_to_drive_it_and_nothing_of_the_api_key(self) -> None:
        fake = self.box()
        slot = self.acquire(self.client(fake, url=f"{fake.url}/"))
        token = fake.slots["slot-1"]["token"]
        self.assertEqual(slot.url, fake.url, "the trailing slash is dropped")
        self.assertEqual(slot.slot_id, "slot-1")
        self.assertEqual(slot.node_id, "node-1")
        self.assertEqual(slot.token, token)
        self.assertEqual(slot.cdp_url, f"ws://127.0.0.1:{fake.port}/v1/cdp/slot-1")
        self.assertEqual(slot.headers, {TOKEN_HEADER: token})
        self.assertIsNot(slot.headers, slot.headers, "a fresh dict each time")
        slot.headers["x"] = "changed"
        self.assertEqual(slot.headers, {TOKEN_HEADER: token})
        self.assertNotIn(API_KEY, json.dumps(slot.to_dict()))
        self.assertNotIn(token, repr(slot), "the token stays out of logs")
        with self.assertRaises(AttributeError):
            slot.token = "other"  # type: ignore[misc]
        second = self.acquire(self.client(fake), "run-2")
        self.assertNotEqual(second.token, token, "each slot has its own token")

    def test_a_confined_key_and_an_exhausted_quota_are_told_apart_from_a_full_box(self) -> None:
        with self.assertRaises(ForbiddenError) as forbidden:
            self.acquire(self.client(self.box(create_status=403)))
        self.assertIsInstance(forbidden.exception, BrowserBayError)
        self.assertNotIsInstance(forbidden.exception, NoCapacityError)
        self.assertEqual(forbidden.exception.status, 403)
        self.assertIn("namespace", str(forbidden.exception))
        self.assertNotIn(API_KEY, str(forbidden.exception))

        with self.assertRaises(QuotaExceededError) as exhausted:
            self.acquire(self.client(self.box(create_status=429)))
        self.assertIsInstance(exhausted.exception, BrowserBayError)
        self.assertNotIsInstance(exhausted.exception, NoCapacityError)
        self.assertEqual(exhausted.exception.status, 429)
        self.assertIn("quota", str(exhausted.exception))

    def test_a_full_box_is_no_capacity_error_other_failures_carry_the_status(self) -> None:
        with self.assertRaises(NoCapacityError) as full:
            self.acquire(self.client(self.box(create_status=503)))
        self.assertIsInstance(full.exception, BrowserBayError)
        self.assertEqual(full.exception.status, 503)
        self.assertEqual(str(full.exception), "No browser capacity is available right now")

        with self.assertRaises(BrowserBayError) as refused:
            self.acquire(self.client(self.box(create_status=401)))
        self.assertNotIsInstance(refused.exception, NoCapacityError)
        self.assertEqual(refused.exception.status, 401)
        self.assertRegex(str(refused.exception), r"could not start a browser \(401\)")
        self.assertNotIn(API_KEY, str(refused.exception))

        with self.assertRaisesRegex(BrowserBayError, "incomplete slot"):
            self.acquire(self.client(self.box(create_body={"slotId": "slot-1"})))

    def test_a_box_that_cannot_be_reached_is_a_box_error_without_a_status(self) -> None:
        fake = self.box()
        fake.close()
        with self.assertRaises(BrowserBayError) as down:
            self.acquire(BrowserBay(fake.url, API_KEY))
        self.assertIsNone(down.exception.status)
        self.assertNotIn(API_KEY, str(down.exception))

    def test_a_redirect_is_not_followed_with_the_api_key(self) -> None:
        elsewhere = self.box()
        redirecting = self.box()

        def redirect(h: Any) -> None:
            h.send_response(307)
            h.send_header("Location", f"{elsewhere.address}/v1/slots")
            h.send_header("Content-Length", "0")
            h.end_headers()

        redirecting._handle = redirect  # type: ignore[method-assign]
        with self.assertRaises(BrowserBayError) as refused:
            self.acquire(self.client(redirecting))
        self.assertEqual(refused.exception.status, 307)
        self.assertEqual(elsewhere.calls, [], "the key went nowhere else")

    def test_the_cdp_socket_scheme_and_path_prefix_follow_the_box_address(self) -> None:
        cases = [
            ("http://box.internal:8080", "ws://box.internal:8080/v1/cdp/slot-1"),
            ("http://box.internal", "ws://box.internal/v1/cdp/slot-1"),
            ("https://box.example.com", "wss://box.example.com/v1/cdp/slot-1"),
            ("HTTPS://Box.Example.com:443", "wss://box.example.com/v1/cdp/slot-1"),
            ("https://box.example.com:8443", "wss://box.example.com:8443/v1/cdp/slot-1"),
            ("https://example.com/browsers", "wss://example.com/browsers/v1/cdp/slot-1"),
            ("https://example.com/browsers/", "wss://example.com/browsers/v1/cdp/slot-1"),
            ("http://[::1]:8788", "ws://[::1]:8788/v1/cdp/slot-1"),
        ]
        for url, expected in cases:
            service = BrowserBay(url, API_KEY)
            self.assertEqual(service.slot({"slotId": "slot-1", "token": "t"}).cdp_url, expected, url)
        self.assertEqual(
            BrowserBay("https://b.example.com", API_KEY).slot({"slotId": "a b/c", "token": "t"}).cdp_url,
            "wss://b.example.com/v1/cdp/a%20b%2Fc",
            "the slot id is escaped like encodeURIComponent",
        )

    def test_a_path_prefix_is_also_where_the_calls_go(self) -> None:
        fake = self.box(prefix="/browsers")
        slot = self.acquire(self.client(fake))
        self.assertEqual(slot.cdp_url, f"ws://127.0.0.1:{fake.port}/browsers/v1/cdp/slot-1")
        self.assertTrue(slot.is_alive())
        self.assertEqual([c.path for c in fake.calls], ["/browsers/v1/slots", "/browsers/v1/slots/slot-1"])


class IsAliveTests(BoxTestCase):
    def test_asks_with_the_slots_own_token_never_the_api_key(self) -> None:
        fake = self.box()
        slot = self.acquire(self.client(fake))
        self.assertIs(slot.is_alive(), True)
        lookup = fake.lookups()[0]
        self.assertEqual(lookup.path, "/v1/slots/slot-1")
        self.assertEqual(lookup.headers[TOKEN_HEADER], fake.slots["slot-1"]["token"])
        self.assertNotIn("authorization", lookup.headers, "a slot asks about itself without the API key")

    def test_is_false_when_the_slot_is_gone_or_its_token_refused_and_that_is_final(self) -> None:
        fake = self.box()
        slot = self.acquire(self.client(fake))
        fake.slots["slot-1"]["token"] = "a-completely-different-token"
        self.assertIs(slot.is_alive(), False, "401: the slot now belongs to another run")
        self.assertEqual(len(fake.lookups()), 1, "a refusal is not retried")
        fake.slots.clear()
        self.assertIs(slot.is_alive(), False, "404: the slot is gone")
        self.assertEqual(len(fake.lookups()), 2)

    def test_retries_once_on_a_network_error_or_a_server_error_and_never_raises(self) -> None:
        def after(slot_lookups: List[Any]) -> tuple:  # type: ignore[type-arg]
            fake = self.box(slot_lookups=slot_lookups)
            slot = self.acquire(self.client(fake))
            return slot.is_alive(), len(fake.lookups())

        self.assertEqual(after(["network"]), (True, 2))
        self.assertEqual(after([500]), (True, 2))
        self.assertEqual(after([503]), (True, 2))
        self.assertEqual(after(["network", "network"]), (False, 2))
        self.assertEqual(after([502, "network"]), (False, 2))
        self.assertEqual(after([404]), (False, 1))
        self.assertEqual(after([401]), (False, 1))
        self.assertEqual(after([]), (True, 1))

    def test_a_box_that_cannot_be_asked_is_not_alive_rather_than_an_error(self) -> None:
        fake = self.box()
        slot = self.acquire(self.client(fake))
        fake.close()
        self.assertIs(slot.is_alive(), False)

    def test_the_retry_pause_is_configurable(self) -> None:
        sleeps: List[float] = []
        import browserbay._client as module

        original = module.time.sleep
        module.time.sleep = sleeps.append  # type: ignore[assignment]
        self.addCleanup(setattr, module.time, "sleep", original)
        fake = self.box(slot_lookups=[500])
        slot = self.acquire(self.client(fake, retry_delay=0.25))
        self.assertTrue(slot.is_alive())
        self.assertEqual(sleeps, [0.25])


class StoredSlotTests(BoxTestCase):
    def test_a_stored_slot_comes_back_without_a_request_and_says_where_it_lives(self) -> None:
        fake = self.box()
        original = self.acquire(self.client(fake))
        stored = json.loads(json.dumps(original.to_dict()))
        self.assertEqual(sorted(stored), ["nodeId", "slotId", "token", "url"])
        self.assertNotIn(API_KEY, json.dumps(stored))

        before = len(fake.calls)
        revived = self.client(fake).slot(stored)
        self.assertEqual(len(fake.calls), before, "nothing is asked of the box just to rebuild a slot")
        self.assertEqual(revived.cdp_url, original.cdp_url)
        self.assertEqual(revived.headers, original.headers)
        self.assertEqual(revived.to_dict(), original.to_dict())
        self.assertIs(revived.is_alive(), True)

        service = self.client(fake)
        for broken in [{"slotId": "slot-1"}, {"token": "x"}, {"slotId": "", "token": "x"}, {"slotId": "a", "token": 3}]:
            with self.assertRaisesRegex(ValueError, "slotId and a token"):
                service.slot(broken)
        with self.assertRaises(TypeError):
            service.slot("slot-1")  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, r"http\(s\)"):
            service.slot({**stored, "url": "ftp://browsers.example.com"})
        with self.assertRaisesRegex(ValueError, "not a URL"):
            service.slot({**stored, "url": "not a url"})

    def test_snake_case_keys_are_accepted_and_a_missing_node_is_not_stored(self) -> None:
        service = BrowserBay("https://b.example.com", API_KEY)
        slot = service.slot({"slot_id": "s1", "token": "t", "node_id": "n1"})
        self.assertEqual((slot.slot_id, slot.node_id), ("s1", "n1"))
        bare = service.slot({"slotId": "s1", "token": "t"})
        self.assertIsNone(bare.node_id)
        self.assertEqual(bare.to_dict(), {"url": "https://b.example.com", "slotId": "s1", "token": "t"})

    def test_a_stored_slot_naming_another_box_gets_no_credentials_unless_allowed(self) -> None:
        fake = self.box()
        service = self.client(fake)
        stored = {"slotId": "slot-1", "token": "a-slot-token", "url": "https://attacker.example.net"}

        with self.assertRaisesRegex(ValueError, "not on this client's box"):
            service.slot(stored)
        with self.assertRaisesRegex(ValueError, "Its credentials are only sent to the box"):
            service.release("slot-1", url=stored["url"])
        self.assertEqual(fake.calls, [], "nothing was sent anywhere")

        # The same box under another spelling is the same box; another path on the host is another box.
        self.assertEqual(service.slot({**stored, "url": f"{fake.url}/"}).url, fake.url)
        with self.assertRaisesRegex(ValueError, "not on this client's box"):
            service.slot({**stored, "url": f"{fake.url}/other-prefix"})
        self.assertEqual(service.slot({"slotId": "slot-1", "token": "t"}).url, fake.url, "no address means this box")

        trusting = self.client(fake, allow_other_boxes=True)
        self.assertEqual(trusting.slot(stored).url, stored["url"])

    def test_the_same_box_spelled_differently_is_still_the_same_box(self) -> None:
        service = BrowserBay("https://browsers.example.com", API_KEY)
        for url in [
            "https://browsers.example.com/",
            "HTTPS://Browsers.Example.COM",
            "https://browsers.example.com:443",
            "https://browsers.example.com:443/",
        ]:
            service.slot({"slotId": "s", "token": "t", "url": url})
        for url in ["http://browsers.example.com", "https://browsers.example.com:8443", "https://browsers.example.org"]:
            with self.assertRaisesRegex(ValueError, "not on this client's box", msg=url):
                service.slot({"slotId": "s", "token": "t", "url": url})

    def test_allow_other_boxes_names_the_boxes_a_stored_slot_may_live_on_and_only_those(self) -> None:
        old = "https://old-box.example.com"
        fake = self.box()
        service = BrowserBay(
            fake.url, API_KEY, allow_other_boxes=[old, "https://other-old.example.com/prefix"], retry_delay=0
        )
        self.assertEqual(service.slot({"slotId": "s1", "token": "t1", "url": old}).url, old)
        self.assertEqual(
            service.slot({"slotId": "s1", "token": "t1", "url": "HTTPS://Old-Box.Example.com:443/"}).cdp_url,
            "wss://old-box.example.com/v1/cdp/s1",
        )
        self.assertEqual(
            service.slot({"slotId": "s1", "token": "t1", "url": "https://other-old.example.com/prefix/"}).url,
            "https://other-old.example.com/prefix",
        )
        self.assertEqual(service.slot({"slotId": "s1", "token": "t1"}).url, fake.url, "this box needs no listing")

        for url in [
            "https://attacker.example.net",
            f"{old}:8443",
            "http://old-box.example.com",
            "https://other-old.example.com",
            "https://other-old.example.com/prefix/deeper",
        ]:
            with self.assertRaisesRegex(ValueError, "not on this client's box", msg=url):
                service.slot({"slotId": "s1", "token": "t1", "url": url})
            with self.assertRaisesRegex(ValueError, "not on this client's box", msg=url):
                service.release("s1", url=url)
        self.assertEqual(fake.calls, [], "nothing was sent to any of them")

        # A listed box really is where the call goes (this one is the fake, reached under another name).
        elsewhere = BrowserBay(old, API_KEY, allow_other_boxes=[f"http://localhost:{fake.port}"])
        elsewhere.release("s1", url=f"HTTP://LOCALHOST:{fake.port}/")
        self.assertEqual(fake.calls[0].path, "/v1/slots/s1")
        self.assertEqual(fake.calls[0].headers["authorization"], f"Bearer {API_KEY}")

        # An empty list trusts nobody; True still trusts anybody.
        with self.assertRaisesRegex(ValueError, "not on this client's box"):
            BrowserBay(fake.url, API_KEY, allow_other_boxes=[]).slot({"slotId": "s1", "token": "t1", "url": old})
        anywhere = BrowserBay(fake.url, API_KEY, allow_other_boxes=True)
        self.assertEqual(
            anywhere.slot({"slotId": "s1", "token": "t1", "url": "https://anywhere.example.org"}).url,
            "https://anywhere.example.org",
        )

    def test_a_stored_slot_is_released_at_the_box_it_names_with_the_api_key(self) -> None:
        fake = self.box()
        slot = self.acquire(self.client(fake))
        stored = json.loads(json.dumps(slot.to_dict()))
        slot.release()
        call = next(c for c in fake.calls if c.method == "DELETE")
        self.assertEqual(call.path, "/v1/slots/slot-1")
        self.assertEqual(call.headers["authorization"], f"Bearer {API_KEY}")
        self.assertEqual(fake.slots, {})
        self.assertIs(slot.is_alive(), False, "a released slot is gone")

        # The box moved since the slot was stored: the slot still decides where it lives.
        other = self.box()
        moved = BrowserBay("https://new-box.example.com", API_KEY, allow_other_boxes=True)
        moved.slot({**stored, "url": other.url}).release()
        self.assertEqual(other.calls[0].path, "/v1/slots/slot-1")
        self.assertEqual(other.calls[0].headers["authorization"], f"Bearer {API_KEY}")


class ReleaseTests(BoxTestCase):
    def test_releasing_is_idempotent_a_missing_slot_is_fine_a_failure_carries_its_status(self) -> None:
        fake = self.box()
        slot = self.acquire(self.client(fake))
        slot.release()
        slot.release()
        self.assertEqual(len(fake.deleted()), 2)

        stored = {"slotId": slot.slot_id, "token": slot.token}
        self.client(self.box(delete_status=lambda _: 404)).slot(stored).release()
        for status in (500, 401):
            with self.assertRaises(BrowserBayError, msg=str(status)) as failed:
                self.client(self.box(delete_status=lambda _, s=status: s)).slot(stored).release()  # type: ignore[misc]
            self.assertEqual(failed.exception.status, status)
            self.assertNotIn(API_KEY, str(failed.exception))
            self.assertNotIn(slot.token, str(failed.exception))

    def test_a_slot_can_be_released_by_its_id_alone(self) -> None:
        fake = self.box()
        fake.seed("orphan", "run-a", 30)
        self.client(fake).release("orphan")
        self.assertEqual(fake.deleted(), ["orphan"])
        self.assertEqual(fake.calls[0].path, "/v1/slots/orphan")
        self.assertEqual(fake.calls[0].headers["authorization"], f"Bearer {API_KEY}")

        self.client(self.box(delete_status=lambda _: 404)).release("already-gone")
        with self.assertRaises(BrowserBayError) as stuck:
            self.client(self.box(delete_status=lambda _: 500)).release("stuck")
        self.assertEqual(stuck.exception.status, 500)
        with self.assertRaisesRegex(ValueError, "needs a slot_id"):
            self.client(fake).release("")
        with self.assertRaisesRegex(ValueError, r"http\(s\)"):
            self.client(fake).release("x", url="ftp://nope")

    def test_the_slot_id_is_escaped_in_the_path(self) -> None:
        fake = self.box()
        self.client(fake).release("a b/c")
        self.assertEqual(fake.calls[0].path, "/v1/slots/a%20b%2Fc")


class ListAndNodesTests(BoxTestCase):
    def test_list_shows_the_services_slots_and_with_a_namespace_only_that_one_with_the_prefix_removed(self) -> None:
        fake = self.box()
        fake.seed("mine", "production:run-a", 30)
        fake.seed("theirs", "staging:run-a", 30)
        fake.seed("bare", "run-a", 30)

        everything = self.client(fake).list()
        self.assertEqual(sorted(s.slot_id for s in everything), ["bare", "mine", "theirs"], "no namespace sees all")
        listed = self.client(fake, namespace="production").list()
        self.assertEqual([(s.slot_id, s.run_id) for s in listed], [("mine", "run-a")])
        self.assertIsInstance(listed[0], SlotSummary)
        self.assertEqual((listed[0].node_id, listed[0].created_at != ""), ("node-1", True))
        self.assertNotIn("token", json.dumps([dataclasses.asdict(s) for s in listed]), "a listing carries no secret")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            listed[0].run_id = "x"  # type: ignore[misc]

        with self.assertRaisesRegex(BrowserBayError, r"could not list browsers \(500\)"):
            self.client(self.box(list_status=500)).list()
        with self.assertRaises(BrowserBayError) as unauthorized:
            self.client(self.box(list_status=401)).list()
        self.assertEqual(unauthorized.exception.status, 401)

    def test_nodes_lists_the_machines_that_run_the_browsers(self) -> None:
        fake = self.box()
        nodes = self.client(fake).nodes()
        self.assertEqual(
            nodes, [NodeSummary(node_id="node-1", max_contexts=5, contexts=0, draining=False, last_seen_at="x")]
        )
        self.assertEqual(fake.calls[0].headers["authorization"], f"Bearer {API_KEY}")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            nodes[0].contexts = 3  # type: ignore[misc]


    def test_a_malformed_node_is_skipped_and_does_not_hide_the_others(self) -> None:
        good = {"nodeId": "ok", "maxContexts": 5, "contexts": 2, "draining": True, "lastSeenAt": "t"}
        fake = self.box(
            nodes=[
                {"nodeId": "words", "maxContexts": "many", "contexts": 0},
                {"nodeId": "flag", "maxContexts": True},
                {"nodeId": "fraction", "contexts": 1.5},
                {"nodeId": "bare"},
                good,
                {"maxContexts": 1},
            ]
        )
        nodes = self.client(fake).nodes()
        self.assertEqual([n.node_id for n in nodes], ["bare", "ok"], "bad counts and a missing id are skipped")
        self.assertEqual((nodes[0].max_contexts, nodes[0].contexts), (0, 0), "a missing count is 0")
        self.assertEqual((nodes[1].max_contexts, nodes[1].contexts, nodes[1].draining), (5, 2, True))


PASSWORD = "python-client-must-not-show-this-password"


class SlotOptionTests(BoxTestCase):
    def test_a_proxy_a_time_zone_a_language_and_node_labels_are_sent_when_asked_for(self) -> None:
        fake = self.box(modern=True)
        proxy = Proxy("http://proxy.example.com:8080", "user", PASSWORD, "*.internal.test")
        slot = self.acquire(
            self.client(fake), proxy=proxy, timezone="Europe/Berlin", locale="de-DE", node_labels=["home", "eu"]
        )
        self.assertEqual(
            fake.calls[0].body,
            {
                "runId": "run-1",
                "maxLifetimeSeconds": 3000,
                "waitMs": 30_000,
                "proxy": {
                    "server": "http://proxy.example.com:8080",
                    "username": "user",
                    "password": PASSWORD,
                    "bypass": "*.internal.test",
                },
                "timezone": "Europe/Berlin",
                "locale": "de-DE",
                "nodeLabels": ["home", "eu"],
            },
        )
        self.assertNotIn(PASSWORD, json.dumps(slot.to_dict()), "a stored slot has no proxy credential")

        # A dict works as well as a Proxy, only what is asked for is sent, and an empty list of labels is no labels.
        again = self.box(modern=True)
        self.acquire(self.client(again), proxy={"server": "socks5://10.0.0.7:1080"}, node_labels=[])
        self.assertEqual(again.calls[0].body["proxy"], {"server": "socks5://10.0.0.7:1080"})
        self.assertNotIn("nodeLabels", again.calls[0].body)
        self.assertNotIn("timezone", again.calls[0].body)

    def test_a_plain_request_is_the_one_a_box_has_always_taken(self) -> None:
        fake = self.box()  # an old box: it says nothing of what it applied
        self.acquire(self.client(fake))
        self.assertEqual(fake.calls[0].body, {"runId": "run-1", "maxLifetimeSeconds": 3000, "waitMs": 30_000})
        self.assertEqual(len(fake.slots), 1, "and nothing was refused for the box being old")

    def test_a_box_that_predates_the_options_would_make_a_plain_browser_so_it_is_released_and_the_ask_refused(self) -> None:
        fake = self.box()
        with self.assertRaises(UnsupportedError) as caught:
            self.acquire(self.client(fake), proxy=Proxy("http://proxy.example.com:8080", "u", PASSWORD))
        self.assertIsInstance(caught.exception, BrowserBayError)
        self.assertRegex(str(caught.exception), r"did not apply proxy.*older")
        self.assertNotIn(PASSWORD, str(caught.exception))
        self.assertEqual([c.method for c in fake.calls], ["POST", "DELETE"], "the browser made without it was released")
        self.assertEqual(fake.slots, {})

    def test_a_box_that_applied_only_some_is_refused_too_and_says_which(self) -> None:
        fake = self.box(create_body={"slotId": "slot-9", "token": "t", "nodeId": "n", "applied": ["timezone"]})
        with self.assertRaisesRegex(UnsupportedError, "did not apply proxy, locale"):
            self.acquire(self.client(fake), proxy={"server": "http://p.example:1"}, timezone="UTC", locale="fr")
        self.assertEqual([(c.method, c.path) for c in fake.calls], [("POST", "/v1/slots"), ("DELETE", "/v1/slots/slot-9")])

    def test_when_the_browser_cannot_be_released_it_says_so_and_still_refuses(self) -> None:
        fake = self.box(delete_status=lambda _: 500)
        with self.assertLogs("browserbay", level="WARNING") as logged:
            with self.assertRaises(UnsupportedError):
                self.acquire(self.client(fake), proxy=Proxy("http://p.example:1", "u", PASSWORD))
        self.assertNotIn(PASSWORD, "\n".join(logged.output))

    def test_422_says_what_no_node_offers_and_400_says_what_was_wrong(self) -> None:
        unsupported = self.box(create_status=422, create_body={"error": "unsupported", "message": "No node offers proxy"})
        with self.assertRaises(UnsupportedError) as caught:
            self.acquire(self.client(unsupported), proxy=Proxy("http://p.example:1", "u", PASSWORD))
        self.assertEqual(caught.exception.status, 422)
        self.assertIn("No node offers proxy", str(caught.exception))
        self.assertNotIn(PASSWORD, str(caught.exception))
        self.assertEqual(len(unsupported.calls), 1, "nothing was made, so nothing is released")

        refused = self.box(create_status=400, create_body={"error": "invalid_request", "message": "proxy.server must be http://host:port"})
        with self.assertRaises(BrowserBayError) as bad:
            self.acquire(self.client(refused), proxy={"server": "nope"})
        self.assertNotIsInstance(bad.exception, UnsupportedError)
        self.assertEqual(bad.exception.status, 400)
        self.assertIn("proxy.server must be", str(bad.exception))
        with self.assertRaisesRegex(BrowserBayError, r"refused the request \(400\)$"):
            self.acquire(self.client(self.box(create_status=400)))

    def test_options_of_the_wrong_type_are_refused_before_anything_is_sent(self) -> None:
        fake = self.box(modern=True)
        service = self.client(fake)
        for kwargs in [
            {"proxy": "http://proxy.example.com:8080"},
            {"proxy": {}},
            {"proxy": {"server": 5}},
            {"proxy": {"server": "http://p.example:1", "password": 5}},
            {"timezone": 5},
            {"locale": b"de"},
            {"node_labels": "home"},
            {"node_labels": [1]},
        ]:
            with self.assertRaises(TypeError, msg=repr(kwargs)):
                self.acquire(service, **kwargs)
        self.assertEqual(fake.calls, [])

    def test_a_proxys_repr_hides_its_password(self) -> None:
        proxy = Proxy("http://proxy.example.com:8080", "user", PASSWORD)
        for text in (repr(proxy), str(proxy), f"{proxy}", repr([proxy]), repr({"p": proxy})):
            self.assertNotIn(PASSWORD, text)
        self.assertIn("password='***'", repr(proxy))
        self.assertIn("password=None", repr(Proxy("http://p.example:1")))
        self.assertEqual(proxy.to_dict()["password"], PASSWORD, "it is hidden from logs, not from the request")
        self.assertEqual(Proxy("http://p.example:1").to_dict(), {"server": "http://p.example:1"})

    def test_nodes_say_what_they_can_do_what_they_are_called_and_whether_they_are_kept_for_their_labels(self) -> None:
        fake = self.box(
            nodes=[
                {
                    "nodeId": "home",
                    "maxContexts": 2,
                    "contexts": 1,
                    "draining": False,
                    "lastSeenAt": "t",
                    "features": ["proxy", 5, "locale"],
                    "labels": ["home"],
                    "exclusive": True,
                },
                {"nodeId": "old", "maxContexts": 2, "contexts": 0},
                {"nodeId": "odd", "features": "proxy", "labels": {"a": 1}},
            ]
        )
        home, old, odd = self.client(fake).nodes()
        self.assertEqual((home.features, home.labels, home.exclusive), (("proxy", "locale"), ("home",), True))
        self.assertEqual((old.features, old.labels, old.exclusive), ((), (), False), "a box that predates them sends none")
        self.assertEqual((odd.features, odd.labels), ((), ()), "something that is not a list is none")


class ReapTests(BoxTestCase):
    def recorder(self) -> logging.Logger:
        logger = logging.getLogger(f"browserbay-test-{id(self)}")
        logger.propagate = False
        self.records: List[logging.LogRecord] = []

        class Capture(logging.Handler):
            def emit(handler, record: logging.LogRecord) -> None:  # noqa: N805
                self.records.append(record)

        logger.addHandler(Capture())
        return logger

    def test_releases_slots_no_live_run_needs_and_spares_young_ones_live_runs_and_the_skipped(self) -> None:
        fake = self.box()
        fake.seed("live", "run-live", 30)
        fake.seed("finished", "run-finished", 30)
        fake.seed("lost", "run-missing", 30)
        fake.seed("young", "run-finished", 1)
        fake.seed("capture", "capture-1b4e28ba-2fa1-11d2-883f-0016d3cca427", 30)
        fake.seed("broken", "run-broken", 30)
        fake.seed("anonymous", "", 30)
        service = self.client(fake, logger=self.recorder())

        asked: List[str] = []

        def is_live(run_id: str) -> bool:
            asked.append(run_id)
            if run_id == "run-broken":
                raise RuntimeError("invalid input syntax for type uuid")
            return run_id == "run-live"

        released = service.reap(is_live, skip=lambda run_id: run_id.startswith("capture-"))

        self.assertEqual((fake.calls[0].method, fake.calls[0].path), ("GET", "/v1/slots"))
        self.assertEqual(sorted(fake.deleted()), ["anonymous", "finished", "lost"])
        self.assertEqual(released, 3)
        self.assertEqual(asked, ["run-live", "run-finished", "run-missing", "run-broken"])
        self.assertEqual(sorted(fake.slots), ["broken", "capture", "live", "young"], "not knowing is not a reason")
        self.assertEqual(len(self.records), 1, "the failed lookup is logged")
        for call in fake.calls:
            if call.method == "DELETE":
                self.assertEqual(call.headers["authorization"], f"Bearer {API_KEY}")

    def test_with_a_namespace_only_that_namespace_is_touched_and_the_bare_run_id_is_asked_about(self) -> None:
        fake = self.box()
        fake.seed("mine-orphan", "production:run-orphan", 30)
        fake.seed("mine-live", "production:run-live", 30)
        fake.seed("mine-capture", "production:capture-1b4e28ba-2fa1-11d2-883f-0016d3cca427", 30)
        fake.seed("mine-young", "production:run-orphan", 1)
        fake.seed("staging", "staging:run-orphan", 30)
        fake.seed("unprefixed", "run-orphan", 30)
        fake.seed("lookalike", "production-eu:run-orphan", 30)
        service = self.client(fake, namespace="production")

        asked: List[str] = []

        def is_live(run_id: str) -> bool:
            asked.append(run_id)
            return run_id == "run-live"

        released = service.reap(is_live, skip=lambda run_id: run_id.startswith("capture-"))
        self.assertEqual(fake.deleted(), ["mine-orphan"])
        self.assertEqual(released, 1)
        self.assertEqual(asked, ["run-orphan", "run-live"], "the prefix is stripped before the run is looked up")
        self.assertEqual(
            sorted(fake.slots),
            ["lookalike", "mine-capture", "mine-live", "mine-young", "staging", "unprefixed"],
            "another service's slots on a shared box are untouched",
        )

    def test_a_slot_is_spared_during_the_grace_period_and_reaped_after_it(self) -> None:
        clock = [NOW]
        fake = self.box(now=lambda: clock[0])
        service = self.client(fake, namespace="production", now=lambda: clock[0])
        self.acquire(service)

        clock[0] = NOW + 60
        self.assertEqual(service.reap(lambda _: False), 0, "one minute old: it may not be saved on its run yet")
        self.assertEqual(len(fake.slots), 1)

        clock[0] = NOW + 10 * 60
        asked: List[str] = []
        self.assertEqual(service.reap(lambda run_id: asked.append(run_id) or False), 1)
        self.assertEqual(asked, ["run-1"])
        self.assertEqual(fake.slots, {})

        patient = self.box(now=lambda: clock[0])
        strict = self.client(patient, now=lambda: clock[0])
        self.acquire(strict, "run-2")
        clock[0] += 10 * 60
        self.assertEqual(strict.reap(lambda _: False, grace_ms=30 * 60_000), 0, "the grace period is configurable")
        self.assertEqual(strict.reap(lambda _: False, grace_ms=0), 1, "and zero means no grace at all")

    def test_a_failed_listing_stops_the_reaper_and_a_failed_release_is_not_counted_or_logged_with_a_secret(self) -> None:
        unavailable = self.box(list_status=500)
        unavailable.seed("orphan", "run-orphan", 30)
        with self.assertRaisesRegex(BrowserBayError, r"could not list browsers \(500\)"):
            self.client(unavailable).reap(lambda _: False)
        self.assertEqual(unavailable.deleted(), [], "nothing is released on a listing that failed")

        fake = self.box(delete_status=lambda slot_id: 500 if slot_id == "stuck" else 204)
        fake.seed("stuck", "run-a", 30)
        fake.seed("fine", "run-b", 30)
        released = self.client(fake, logger=self.recorder()).reap(lambda _: False)
        self.assertEqual(released, 1, "only the release that worked is counted")
        self.assertEqual(fake.deleted(), ["stuck", "fine"], "one failure does not stop the others")
        self.assertEqual(len(self.records), 1)
        logged = self.records[0].getMessage()
        self.assertIn("stuck", logged, "the slot id says which browser")
        self.assertNotIn(API_KEY, logged)
        self.assertNotIn("token-of-", logged)

    def test_the_default_grace_period_is_three_minutes(self) -> None:
        fake = self.box()
        fake.seed("two-minutes", "run-a", 2)
        fake.seed("four-minutes", "run-b", 4)
        self.assertEqual(self.client(fake).reap(lambda _: False), 1)
        self.assertEqual(sorted(fake.slots), ["two-minutes"])


class ContextManagerTests(BoxTestCase):
    def test_leaving_a_with_block_releases_the_browser(self) -> None:
        fake = self.box()
        with self.acquire(self.client(fake)) as slot:
            self.assertIsInstance(slot, Slot)
            self.assertEqual(len(fake.slots), 1)
        self.assertEqual(fake.slots, {})
        self.assertEqual(fake.deleted(), ["slot-1"])

    def test_it_is_released_when_the_block_raises_and_that_error_is_not_hidden(self) -> None:
        fake = self.box()
        with self.assertRaisesRegex(RuntimeError, "boom"):
            with self.acquire(self.client(fake)):
                raise RuntimeError("boom")
        self.assertEqual(fake.slots, {})

        broken = self.box(delete_status=lambda _: 500)
        with self.assertLogs("browserbay", "WARNING"), self.assertRaisesRegex(RuntimeError, "boom"):
            with self.acquire(self.client(broken)):
                raise RuntimeError("boom")  # a failed release must not replace this error

    def test_a_failed_release_at_the_end_of_a_clean_block_is_raised(self) -> None:
        broken = self.box(delete_status=lambda _: 500)
        with self.assertRaises(BrowserBayError):
            with self.acquire(self.client(broken)):
                pass


class PackageTests(unittest.TestCase):
    def test_slot_summaries_json_round_trip(self) -> None:
        summary = SlotSummary(slot_id="a", run_id="b", node_id="c", created_at="d")
        self.assertEqual(json.loads(json.dumps(dataclasses.asdict(summary)))["run_id"], "b")

    def test_the_package_ships_a_py_typed_marker(self) -> None:
        import os

        import browserbay

        self.assertTrue(os.path.exists(os.path.join(os.path.dirname(browserbay.__file__), "py.typed")))


if __name__ == "__main__":
    unittest.main()
