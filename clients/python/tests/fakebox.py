"""A stand-in for the relay's REST surface, served by http.server on a thread.

It has the same auth rules as the real box: the API key for create, list and release, the slot's own token for
looking a slot up. ``slot_lookups`` scripts the next lookups before the table answers, to simulate a box that is
restarting (``"network"`` drops the connection without answering) or answers with an error status.
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Union
from urllib.parse import unquote

API_KEY = "box-api-key-0123456789"
TOKEN_HEADER = "x-browserbay-token"


@dataclass
class Call:
    method: str
    path: str
    headers: Dict[str, str]  # lower-cased names
    body: Optional[Dict[str, Any]]


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


class FakeBox:
    def __init__(
        self,
        prefix: str = "",
        create_status: Optional[int] = None,
        create_body: Optional[Dict[str, Any]] = None,
        delete_status: Optional[Callable[[str], int]] = None,
        list_status: Optional[int] = None,
        slot_lookups: Optional[List[Union[str, int]]] = None,
        now: Optional[Callable[[], float]] = None,
        nodes: Optional[List[Dict[str, Any]]] = None,
        modern: bool = False,
    ) -> None:
        self.prefix = prefix
        self.create_status = create_status
        self.create_body = create_body
        self.delete_status = delete_status
        self.list_status = list_status
        self.slot_lookups = list(slot_lookups or [])
        self.nodes = nodes
        # A box that knows the slot options says which of the request's it applied; off, it predates them and says nothing.
        self.modern = modern
        self.now = now or (lambda: datetime.now(timezone.utc).timestamp())
        self.calls: List[Call] = []
        self.slots: Dict[str, Dict[str, str]] = {}
        self._counter = 0
        self._lock = threading.Lock()
        box = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:  # keep test output quiet
                pass

            def _serve(self) -> None:
                box._handle(self)

            do_GET = do_POST = do_DELETE = _serve

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self.address = f"http://127.0.0.1:{self.port}"
        self.url = f"{self.address}{prefix}"
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(5)

    # ---- helpers for tests ------------------------------------------------------------------------------------

    def seed(self, slot_id: str, run_id: str, age_minutes: float) -> None:
        """A slot that already exists on the box, as the reaper sees it."""
        created = datetime.fromtimestamp(self.now() - age_minutes * 60, timezone.utc)
        self.slots[slot_id] = {
            "slotId": slot_id,
            "runId": run_id,
            "nodeId": "node-1",
            "createdAt": iso(created),
            "token": f"token-of-{slot_id}",
        }

    def lookups(self) -> List[Call]:
        return [c for c in self.calls if c.method == "GET" and re.fullmatch(r"/v1/slots/[^/]+", c.path)]

    def deleted(self) -> List[str]:
        return [c.path.rsplit("/", 1)[-1] for c in self.calls if c.method == "DELETE"]

    # ---- the box ----------------------------------------------------------------------------------------------

    def _handle(self, h: BaseHTTPRequestHandler) -> None:
        method = h.command
        raw = h.rfile.read(int(h.headers.get("Content-Length") or 0)) if h.headers.get("Content-Length") else b""
        body = json.loads(raw) if raw else None
        headers = {k.lower(): v for k, v in h.headers.items()}
        with self._lock:
            self.calls.append(Call(method, h.path, headers, body))

            def reply(status: int, payload: Any = None) -> None:
                data = b"" if status == 204 else json.dumps(payload if payload is not None else {}).encode()
                h.send_response(status)
                h.send_header("Content-Type", "application/json")
                h.send_header("Content-Length", str(len(data)))
                h.end_headers()
                h.wfile.write(data)

            if not h.path.startswith(self.prefix):
                return reply(404, {"error": "not_found"})
            path = h.path[len(self.prefix) :]
            as_owner = headers.get("authorization") == f"Bearer {API_KEY}"

            if path == "/v1/slots" and method == "POST":
                if not as_owner:
                    return reply(401, {"error": "unauthorized"})
                if self.create_status and self.create_status != 201:
                    return reply(self.create_status, self.create_body)
                if self.create_body is not None:
                    return reply(201, self.create_body)
                self._counter += 1
                slot_id = f"slot-{self._counter}"
                slot = {
                    "slotId": slot_id,
                    "runId": str(body["runId"]),
                    "nodeId": "node-1",
                    "createdAt": iso(datetime.fromtimestamp(self.now(), timezone.utc)),
                    "token": f"slot-token-{self._counter}-PLAINTEXT",
                }
                self.slots[slot_id] = slot
                created: Dict[str, Any] = {"slotId": slot_id, "token": slot["token"], "nodeId": slot["nodeId"]}
                if self.modern:
                    created["applied"] = [n for n in ("proxy", "timezone", "locale", "nodeLabels", "signRequests") if n in body]
                return reply(201, created)

            if path == "/v1/slots" and method == "GET":
                if not as_owner:
                    return reply(401, {"error": "unauthorized"})
                if self.list_status and self.list_status != 200:
                    return reply(self.list_status)
                return reply(200, {"slots": [{k: v for k, v in s.items() if k != "token"} for s in self.slots.values()]})

            if path == "/v1/nodes" and method == "GET":
                if not as_owner:
                    return reply(401, {"error": "unauthorized"})
                if self.nodes is not None:
                    return reply(200, {"nodes": self.nodes})
                node = {"nodeId": "node-1", "maxContexts": 5, "contexts": len(self.slots), "draining": False, "lastSeenAt": "x"}
                return reply(200, {"nodes": [node]})

            match = re.fullmatch(r"/v1/slots/([^/]+)", path)
            if match:
                slot_id = unquote(match.group(1))
                if method == "DELETE":
                    if not as_owner:
                        return reply(401, {"error": "unauthorized"})
                    status = self.delete_status(slot_id) if self.delete_status else 204
                    if status == 204:
                        self.slots.pop(slot_id, None)
                    return reply(status)
                if method == "GET":
                    scripted = self.slot_lookups.pop(0) if self.slot_lookups else None
                    if scripted == "network":
                        h.close_connection = True
                        return  # no answer at all: the connection just closes
                    if scripted is not None:
                        return reply(int(scripted))
                    slot = self.slots.get(slot_id)
                    if slot is None:
                        return reply(404, {"error": "not_found"})
                    if headers.get(TOKEN_HEADER) != slot["token"]:
                        return reply(401, {"error": "unauthorized"})
                    return reply(200, {k: v for k, v in slot.items() if k != "token"})
            return reply(404, {"error": "not_found"})
