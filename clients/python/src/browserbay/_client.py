"""The synchronous browserbay client (standard library only)."""

from __future__ import annotations

import http.client
import json
import logging
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union
from urllib.parse import quote, urlsplit

from ._protocol import (
    MAX_LIFETIME_SECONDS,
    MAX_RUN_ID_LENGTH,
    MIN_LIFETIME_SECONDS,
    NAME_PATTERN,
    NODES_PATH,
    SLOTS_PATH,
    TOKEN_HEADER,
)
from ._types import NodeSummary, Proxy, SlotSummary, StoredSlot
from ._version import __version__

# Longer than the relay's own wait, so a full box is answered with 503 and not cut off by this side's timer.
_ACQUIRE_TIMEOUT_MARGIN_S = 20.0
_USER_AGENT = f"browserbay-python/{__version__}"

_log = logging.getLogger("browserbay")


class BrowserBayError(Exception):
    """The box refused or could not do what was asked.

    ``status`` is the HTTP status the box answered with, or ``None`` when it could not be reached at all.
    Messages never contain the API key or a slot token.
    """

    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


class NoCapacityError(BrowserBayError):
    """The box has no browser to give: every node is full, or none is connected (HTTP 503 ``no_capacity``)."""

    def __init__(self) -> None:
        super().__init__("No browser capacity is available right now", 503)


class ForbiddenError(BrowserBayError):
    """The API key may not do this (HTTP 403).

    A key confined to a namespace on the box can only use run ids in it (make the client with the matching
    ``namespace``) and cannot list nodes.
    """

    def __init__(self) -> None:
        super().__init__(
            "The API key is not allowed to do this. A key confined to a namespace can only use run ids in it "
            "(set the client's `namespace` to match) and cannot list nodes",
            403,
        )


class QuotaExceededError(BrowserBayError):
    """The API key's namespace already holds as many browsers as its quota allows (HTTP 429).

    Unlike :class:`NoCapacityError` the box answers at once: it does not wait for a slot to free up.
    """

    def __init__(self) -> None:
        super().__init__("This API key's quota of browsers is used up", 429)


class UnsupportedError(BrowserBayError):
    """The box cannot give what ``acquire`` asked for: a proxy, a time zone, a language or a node label.

    Either no node it has can (HTTP 422), or the box is older than the option and would have answered with a plain browser,
    which here is a browser that goes out from the box's own address. Nothing is left running: a browser made without what
    was asked for is released before this is raised.
    """


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: it could carry the API key or a slot token to another host."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        return None


_opener = urllib.request.build_opener(_NoRedirects)


def _request(
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: Optional[bytes],
    timeout: float,
) -> Tuple[int, bytes]:
    """One HTTP call. Returns ``(status, body)`` for any answer; raises ``BrowserBayError`` if there was none."""
    request = urllib.request.Request(url, data=body, method=method)
    request.add_header("User-Agent", _USER_AGENT)
    for name, value in headers.items():
        request.add_header(name, value)
    try:
        with _opener.open(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:  # a non-2xx answer is still an answer
        try:
            return error.code, error.read()
        finally:
            error.close()
    except (OSError, http.client.HTTPException, ValueError) as error:
        # URLError, timeouts, resets and a dropped connection are all "the box could not be asked".
        reason = getattr(error, "reason", None) or error
        raise BrowserBayError(f"The browser service could not be reached ({type(reason).__name__}: {reason})") from error


def _strings(value: Any) -> Tuple[str, ...]:
    """The strings in a list the box sent, and nothing if it sent something else (a box that predates the field sent none)."""
    return tuple(item for item in value if isinstance(item, str)) if isinstance(value, list) else ()


def _proxy_body(proxy: Union[Proxy, Mapping[str, Any]]) -> Dict[str, Any]:
    """What is sent for a proxy: a :class:`Proxy` or a dict with a ``server``. Checked only as far as its types."""
    fields = proxy.to_dict() if isinstance(proxy, Proxy) else dict(proxy) if isinstance(proxy, Mapping) else None
    if fields is None or not isinstance(fields.get("server"), str):
        raise TypeError('proxy must be a Proxy, or a dict with a server such as {"server": "http://proxy.example.com:8080"}')
    for name, value in fields.items():
        if not isinstance(value, str):
            raise TypeError(f"proxy.{name} must be a string")
    return fields


def _json_object(body: bytes) -> Dict[str, Any]:
    try:
        value = json.loads(body.decode("utf-8")) if body else {}
    except (ValueError, UnicodeDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _trim_slashes(value: str) -> str:
    return value.rstrip("/")


def _assert_box_url(value: Any) -> str:
    """Checks a box address and returns it without trailing slashes."""
    if not isinstance(value, str):
        raise TypeError("The browserbay URL must be a string")
    try:
        parts = urlsplit(value)
        host = parts.hostname
        parts.port  # noqa: B018 - raises ValueError for a bad port
    except ValueError:
        raise ValueError(f"The browserbay URL is not a URL: {value}") from None
    if not parts.scheme or not host:
        raise ValueError(f"The browserbay URL is not a URL: {value}")
    if parts.scheme.lower() not in ("http", "https"):
        raise ValueError("The browserbay URL must be http(s)://, e.g. https://browsers.example.com")
    if parts.username is not None or parts.password is not None:
        raise ValueError("The browserbay URL must not contain credentials; pass the API key as api_key")
    if "?" in value or "#" in value:  # the paths are appended to it, so a query or fragment would swallow them
        raise ValueError(f"The browserbay URL must not have a query or a fragment: {value}")
    return _trim_slashes(value)


def _canonical(value: str) -> str:
    """The same address however it is spelled: scheme and host in lower case, a default port dropped, no trailing slash."""
    parts = urlsplit(value)
    scheme = parts.scheme.lower()
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    port = parts.port
    netloc = host if port is None or port == (443 if scheme == "https" else 80) else f"{host}:{port}"
    query = f"?{parts.query}" if parts.query else ""
    return _trim_slashes(f"{scheme}://{netloc}{parts.path}{query}")


def _encode_component(value: str) -> str:
    """Like JavaScript's ``encodeURIComponent``."""
    return quote(value, safe="-_.!~*'()")


def _cdp_url_for(box_url: str, slot_id: str) -> str:
    """The box's CDP socket for a slot: the box's own address with the scheme swapped and any path prefix kept."""
    parts = urlsplit(box_url)
    scheme = "wss" if parts.scheme.lower() == "https" else "ws"
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    port = parts.port
    netloc = host if port is None or port == (443 if scheme == "wss" else 80) else f"{host}:{port}"
    return f"{scheme}://{netloc}{parts.path.rstrip('/')}/v1/cdp/{_encode_component(slot_id)}"


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _whole_number(name: str, value: Any, detail: str) -> int:
    """``value`` as an int, if it is a whole number (``600`` or ``600.0``); otherwise the right exception."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be {detail}")
    if isinstance(value, float) and not value.is_integer():  # also rejects nan and inf
        raise ValueError(f"{name} must be {detail}")
    return int(value)


_ISO = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$", re.IGNORECASE
)


def _parse_timestamp(value: str) -> Optional[float]:
    """An ISO 8601 timestamp as epoch seconds, or ``None`` when it is not one (a missing zone means UTC)."""
    match = _ISO.match(value.strip()) if isinstance(value, str) else None
    if not match:
        return None
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    offset = timedelta(0)
    if zone and zone.upper() != "Z":
        digits = zone[1:].replace(":", "")
        offset = timedelta(hours=int(digits[:2]), minutes=int(digits[2:] or 0))
        if zone[0] == "-":
            offset = -offset
    try:
        moment = datetime(
            int(year), int(month), int(day), int(hour), int(minute), int(second),
            int((fraction or "0")[:6].ljust(6, "0")),
            tzinfo=timezone(offset),
        )  # fmt: skip
    except ValueError:
        return None
    return moment.timestamp()


class BrowserBay:
    """A client for one browserbay box.

    ::

        box = BrowserBay("https://browsers.example.com", api_key)
        with box.acquire(run_id="task-42", max_lifetime_seconds=1800) as slot:
            ...  # connect Playwright or Puppeteer to slot.cdp_url with slot.headers

    Everything the client does is a plain HTTP call made with the standard library. Calls block; use
    :class:`AsyncBrowserBay` from asyncio code.

    :param url: The box's base URL, e.g. ``https://browsers.example.com``. A path prefix is kept.
    :param api_key: The box's API key: lets this service create, list and release browsers. It never reaches a browser.
    :param namespace: Marks this service's slots (as a prefix on their run ids) so :meth:`list` and :meth:`reap` leave
        another service's alone when several share a box. Letters, digits, ``_``, ``.`` and ``-`` only. A naming
        convention, not an access control.
    :param allow_other_boxes: Which boxes other than this client's a stored slot (:meth:`slot`, :meth:`release` with
        ``url``) may name. None by default: the API key and slot tokens are sent to the box a slot names, so an address
        read back from storage that someone else could have written would be somewhere to send them. Pass a list of the
        boxes your slots may have been made on; addresses are compared however they are spelled. ``True`` allows any
        address, which is only safe for storage nobody else can write.
    :param logger: A :class:`logging.Logger` for warnings (default: the ``browserbay`` logger).
    :param timeout: Seconds to wait for ``list`` and ``nodes``. Default 15.
    :param lookup_timeout: Seconds to wait for each ask of :meth:`Slot.is_alive`. Default 3.
    :param release_timeout: Seconds to wait for a release. Default 10.
    :param retry_delay: Seconds between :meth:`Slot.is_alive`'s two asks. Default 0.3; tests set 0.
    :param now: A clock returning epoch seconds (default :func:`time.time`), used by :meth:`reap`.
    """

    def __init__(
        self,
        url: str,
        api_key: str,
        namespace: Optional[str] = None,
        allow_other_boxes: Union[bool, Sequence[str], None] = None,
        logger: Optional[logging.Logger] = None,
        *,
        timeout: float = 15.0,
        lookup_timeout: float = 3.0,
        release_timeout: float = 10.0,
        retry_delay: float = 0.3,
        now: Optional[Callable[[], float]] = None,
    ) -> None:
        self._url = _assert_box_url(url)
        if not isinstance(api_key, str):
            raise TypeError("BrowserBay needs an api_key string")
        if not api_key:
            raise ValueError("BrowserBay needs an api_key")
        self._api_key = api_key
        # A ':' would let namespace `app` see and reap the slots of `app:staging`, which is the one thing a namespace is for.
        if namespace and not NAME_PATTERN.fullmatch(namespace):
            raise ValueError('A namespace may only contain letters, digits, "_", "." and "-"')
        self._namespace_prefix = f"{namespace}:" if namespace else None
        self._allow_any = allow_other_boxes is True
        if allow_other_boxes is None or isinstance(allow_other_boxes, bool):
            others: Sequence[str] = []
        elif isinstance(allow_other_boxes, str):
            raise TypeError("allow_other_boxes must be a list of addresses, or True")
        else:
            others = allow_other_boxes
        # Other boxes a stored slot may name (a box that moved while slots were live): listed, so each is checked up front.
        self._own_box = _canonical(self._url)
        self._other_boxes = {_canonical(_assert_box_url(address)) for address in others}
        self._logger = logger or _log
        self._timeout = timeout
        self._lookup_timeout = lookup_timeout
        self._release_timeout = release_timeout
        self._retry_delay = retry_delay
        self._now = now or time.time

    def __repr__(self) -> str:
        return f"BrowserBay(url={self._url!r}, namespace={self._namespace_prefix and self._namespace_prefix[:-1]!r})"

    @property
    def url(self) -> str:
        """The box's address, without trailing slashes."""
        return self._url

    # ---- internals ---------------------------------------------------------------------------------------------

    def _box_of(self, url: Optional[str]) -> str:
        """The box a slot lives on.

        The API key (to release) and the slot token (to look it up) are sent there, so an address read back from
        storage is only used when it is this client's own box or one ``allow_other_boxes`` lists.
        """
        if url is None:
            return self._url
        base = _assert_box_url(url)
        known = _canonical(base)
        if known != self._own_box and not self._allow_any and known not in self._other_boxes:
            raise ValueError(
                f"This slot is on {_origin(base)}, not on this client's box ({_origin(self._url)}). "
                "Its credentials are only sent to the box this client was made for or one listed in allow_other_boxes."
            )
        return base

    def _api(
        self, base: str, path: str, method: str = "GET", body: Optional[Dict[str, Any]] = None, timeout: Optional[float] = None
    ) -> Tuple[int, bytes]:
        """A call to the box as its owner (create, list, release). The address is a parameter: a stored slot names its own."""
        headers = {"Authorization": f"Bearer {self._api_key}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        return _request(method, f"{base}{path}", headers, data, self._timeout if timeout is None else timeout)

    def _delete(self, base: str, slot_id: str) -> None:
        status, _ = self._api(
            base, f"{SLOTS_PATH}/{_encode_component(slot_id)}", "DELETE", timeout=self._release_timeout
        )
        # A slot that is already gone is the goal, not a problem.
        if not 200 <= status < 300 and status != 404:
            raise BrowserBayError(f"The browser service could not release a browser ({status})", status)

    def _lookup(self, base: str, slot_id: str, token: str) -> bool:
        """Asking the box is the liveness check: it answers 200 only while the slot's browser is reachable."""
        for attempt in range(2):
            try:
                status, _ = _request(
                    "GET",
                    f"{base}{SLOTS_PATH}/{_encode_component(slot_id)}",
                    {TOKEN_HEADER: token},
                    None,
                    self._lookup_timeout,
                )
                if 200 <= status < 300:
                    return True
                # 404 or 401: the slot is gone, or the address now belongs to another. Only a server error is worth another try.
                if status < 500:
                    return False
            except BrowserBayError:
                pass  # A restart of the box or a dropped request is not proof the slot is gone, so try once more.
            if attempt == 0 and self._retry_delay > 0:
                time.sleep(self._retry_delay)
        return False

    def _make_slot(self, url: Optional[str], slot_id: str, token: str, node_id: Optional[str]) -> "Slot":
        base = self._box_of(url)
        return Slot(self, base, slot_id, token, node_id)

    # ---- public API --------------------------------------------------------------------------------------------

    def acquire(
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
    ) -> "Slot":
        """Takes a browser.

        :param run_id: Your own id for what the browser is for (a run, a task, a job), up to 200 characters with the
            namespace. :meth:`list` and :meth:`reap` hand it back to you.
        :param max_lifetime_seconds: The browser's node closes it after this long, whether or not anyone is still
            connected. 60 to 86400.
        :param wait_ms: How long to wait for a free slot before giving up with :class:`NoCapacityError`, in whole
            milliseconds (0 means do not wait). The box caps it at its own maximum. Default 30000.
        :param proxy: Send the slot's traffic through this proxy: a :class:`Proxy`, or a dict with a ``server`` and
            optionally ``username``, ``password`` and ``bypass``. The credentials stay on the box's node.
        :param timezone: The IANA time zone the slot's browser runs in, such as ``Europe/Berlin``. Only a box whose nodes
            run ``BROWSERBAY_ISOLATION=process`` can.
        :param locale: The slot's browser language, such as ``de-DE``. Only a box whose nodes run
            ``BROWSERBAY_ISOLATION=process`` can.
        :param node_labels: Only place the slot on a node that carries every one of these labels.
        :param sign_requests: Sign every request of the slot's browser (Web Bot Auth), so sites that know the box can tell
            whose browser it is. ``True`` needs a node that signs and ``False`` one that can leave a slot unsigned; left
            out (``None``), the node's own setting decides.
        :raises NoCapacityError: The box stayed full for the whole wait.
        :raises UnsupportedError: Options were asked for and the box cannot give them (no node can, or the box is older
            than the options). A browser made without them is released first.
        :raises QuotaExceededError: The API key's quota of browsers is used up.
        :raises ForbiddenError: The API key may not use this run id (it is confined to another namespace).
        :raises BrowserBayError: The box refused, answered oddly, or could not be reached.
        :raises ValueError: An argument is outside what the box accepts (nothing is sent).
        :raises TypeError: An argument has the wrong type (nothing is sent).
        """
        if not isinstance(run_id, str):
            raise TypeError(f"run_id must be a string of 1 to {MAX_RUN_ID_LENGTH} characters (the namespace counts)")
        full_run_id = f"{self._namespace_prefix}{run_id}" if self._namespace_prefix else run_id
        if not run_id or _utf16_length(full_run_id) > MAX_RUN_ID_LENGTH:
            raise ValueError(f"run_id must be a string of 1 to {MAX_RUN_ID_LENGTH} characters (the namespace counts)")
        lifetime = _whole_number(
            "max_lifetime_seconds", max_lifetime_seconds, f"a whole number from {MIN_LIFETIME_SECONDS} to {MAX_LIFETIME_SECONDS}"
        )
        if not MIN_LIFETIME_SECONDS <= lifetime <= MAX_LIFETIME_SECONDS:
            raise ValueError(
                f"max_lifetime_seconds must be a whole number from {MIN_LIFETIME_SECONDS} to {MAX_LIFETIME_SECONDS}"
            )
        wait = _whole_number("wait_ms", wait_ms, "a whole number of milliseconds, 0 or more")
        if wait < 0:
            raise ValueError("wait_ms must be a whole number of milliseconds, 0 or more")
        # Only what was asked for is sent, so a request without options is the one a box has always taken.
        options: Dict[str, Any] = {}
        if proxy is not None:
            options["proxy"] = _proxy_body(proxy)
        for name, value in (("timezone", timezone), ("locale", locale)):
            if value is None:
                continue
            if not isinstance(value, str):
                raise TypeError(f"{name} must be a string")
            options[name] = value
        if node_labels is not None:
            if isinstance(node_labels, str) or not all(isinstance(label, str) for label in node_labels):
                raise TypeError("node_labels must be a list of strings")
            if len(node_labels) > 0:
                options["nodeLabels"] = list(node_labels)
        if sign_requests is not None:
            if not isinstance(sign_requests, bool):
                raise TypeError("sign_requests must be True or False")
            options["signRequests"] = sign_requests
        request: Dict[str, Any] = {"runId": full_run_id, "maxLifetimeSeconds": lifetime, "waitMs": wait, **options}
        # What was asked for is exactly the options: the plain fields are not among them, whatever is added to either part.
        asked = list(options)
        status, body = self._api(
            self._url,
            SLOTS_PATH,
            "POST",
            request,
            timeout=wait / 1000 + _ACQUIRE_TIMEOUT_MARGIN_S,
        )
        # The box held the request for the whole wait and still found no node with room (or lost the node it chose).
        if status == 503:
            raise NoCapacityError()
        # A key confined to another namespace, or out of quota: told apart from a box that is merely full.
        if status == 403:
            raise ForbiddenError()
        if status == 429:
            raise QuotaExceededError()
        if status in (400, 422):
            # The box says what is wrong with what was asked for. It never repeats a credential, so the text is safe to show.
            try:
                said = _json_object(body).get("message")
            except BrowserBayError:
                said = None
            detail = f": {said}" if isinstance(said, str) and said else ""
            if status == 422:
                raise UnsupportedError(f"The box cannot give this browser{detail}", 422)
            raise BrowserBayError(f"The browser service refused the request (400){detail}", 400)
        if not 200 <= status < 300:
            raise BrowserBayError(f"The browser service could not start a browser ({status})", status)
        created = _json_object(body)
        slot_id, token, node_id = created.get("slotId"), created.get("token"), created.get("nodeId")
        if not (slot_id and token and node_id) or not all(isinstance(v, str) for v in (slot_id, token, node_id)):
            raise BrowserBayError("The browser service returned an incomplete slot", status)
        # A box older than these options answers 201 and ignores what it does not know: the browser it made is a plain one.
        applied = created.get("applied")
        missing = [name for name in asked if not (isinstance(applied, list) and name in applied)]
        if missing:
            try:
                self._delete(self._url, slot_id)
            except BrowserBayError as error:
                _log.warning("Could not release a browser made without the options asked for (%s)", error.status)
            raise UnsupportedError(
                f"The box did not apply {', '.join(missing)}: it is older than these options. "
                "Upgrade the box (its relay and nodes)"
            )
        return self._make_slot(self._url, slot_id, token, node_id)

    def slot(self, stored: Mapping[str, Any]) -> "Slot":
        """A slot you stored earlier (see :meth:`Slot.to_dict`). Makes no request.

        Use :meth:`Slot.is_alive` to find out whether it still exists. Both the camelCase keys of the stored form
        (``slotId``, ``nodeId``) and snake_case ones (``slot_id``, ``node_id``) are accepted.

        :raises ValueError: The stored slot lacks a slot id or token, or names a box this client may not talk to.
        """
        if not isinstance(stored, Mapping):
            raise TypeError("A stored slot must be a dict with a slotId and a token")
        slot_id = stored.get("slotId", stored.get("slot_id"))
        token = stored.get("token")
        if not isinstance(slot_id, str) or not slot_id or not isinstance(token, str) or not token:
            raise ValueError("A stored slot needs a slotId and a token")
        node_id = stored.get("nodeId", stored.get("node_id"))
        url = stored.get("url")
        return self._make_slot(url if url is not None else self._url, slot_id, token, node_id)

    def release(self, slot_id: str, url: Optional[str] = None) -> None:
        """Releases a slot by its id, for when you no longer hold its token (an orphan found by :meth:`list`).

        Idempotent: a slot that is already gone is fine.

        :param url: The box the slot is on, if not this client's own (it must be in ``allow_other_boxes``).
        :raises BrowserBayError: The box refused, with its HTTP ``status``.
        """
        if not isinstance(slot_id, str) or not slot_id:
            raise ValueError("release needs a slot_id")
        self._delete(self._box_of(url), slot_id)

    def list(self) -> List[SlotSummary]:
        """This service's slots: all of them, or only those in the namespace, with the namespace removed from their run ids.

        :raises BrowserBayError: The box refused, with its HTTP ``status``.
        """
        status, body = self._api(self._url, SLOTS_PATH)
        if not 200 <= status < 300:
            raise BrowserBayError(f"The browser service could not list browsers ({status})", status)
        slots = _json_object(body).get("slots")
        mine: List[SlotSummary] = []
        prefix = self._namespace_prefix
        for item in slots if isinstance(slots, list) else []:
            if not isinstance(item, dict) or not item.get("slotId") or not isinstance(item.get("runId"), str):
                continue
            run_id: str = item["runId"]
            # Another service's slots on a shared box carry its prefix, or none: not ours to see.
            if prefix and not run_id.startswith(prefix):
                continue
            mine.append(
                SlotSummary(
                    slot_id=str(item["slotId"]),
                    run_id=run_id[len(prefix) :] if prefix else run_id,
                    node_id=str(item.get("nodeId") or ""),
                    created_at=str(item.get("createdAt") or ""),
                )
            )
        return mine

    def nodes(self) -> List[NodeSummary]:
        """The machines that run the box's browsers, with their capacity and load.

        :raises BrowserBayError: The box refused, with its HTTP ``status``.
        """
        status, body = self._api(self._url, NODES_PATH)
        if not 200 <= status < 300:
            raise BrowserBayError(f"The browser service could not list nodes ({status})", status)
        nodes = _json_object(body).get("nodes")
        result: List[NodeSummary] = []
        for item in nodes if isinstance(nodes, list) else []:
            if not isinstance(item, dict) or not item.get("nodeId"):
                continue
            counts = [item.get(key) for key in ("maxContexts", "contexts")]
            # A missing count is 0. One that is not a whole number is a malformed entry: skipped, like list() does.
            if any(c is not None and (isinstance(c, bool) or not isinstance(c, int)) for c in counts):
                continue
            result.append(
                NodeSummary(
                    node_id=str(item["nodeId"]),
                    max_contexts=counts[0] or 0,
                    contexts=counts[1] or 0,
                    draining=bool(item.get("draining")),
                    last_seen_at=str(item.get("lastSeenAt") or ""),
                    features=_strings(item.get("features")),
                    labels=_strings(item.get("labels")),
                    exclusive=bool(item.get("exclusive")),
                )
            )
        return result

    def reap(
        self,
        is_live: Callable[[str], bool],
        grace_ms: int = 3 * 60_000,
        skip: Optional[Callable[[str], bool]] = None,
    ) -> int:
        """Releases slots whose run ``is_live`` says no to, for when a crash lost track of them.

        Only this client's slots are considered (the namespace's, if one is set), and ``is_live`` is given the run id
        without the namespace. A slot is left alone when it is younger than ``grace_ms`` (it may be between "created"
        and "saved on its run"), when ``skip(run_id)`` is true (run ids that nothing can vouch for and that close
        themselves at their lifetime), when ``is_live`` says yes, and when ``is_live`` raises (not knowing is not a
        reason to release someone's browser). A failed release is logged and does not stop the others.

        :returns: How many slots were released.
        :raises BrowserBayError: The listing failed (nothing is released then).
        """
        released = 0
        for item in self.list():
            created = _parse_timestamp(item.created_at)
            # A slot younger than the grace period may be between "created" and "saved on its run".
            if created is not None and (self._now() - created) * 1000 < grace_ms:
                continue
            if skip is not None and skip(item.run_id):
                continue
            if item.run_id:
                try:
                    if is_live(item.run_id):
                        continue
                except Exception as error:
                    # Not knowing is not a reason to release someone's browser, or to stop checking the others.
                    self._logger.warning(
                        "Could not tell whether a browser is still needed (slot %s): %s: %s",
                        item.slot_id,
                        type(error).__name__,
                        error,
                    )
                    continue
            try:
                self._delete(self._url, item.slot_id)
                released += 1
            except Exception as error:
                self._logger.warning(
                    "Could not release an orphaned browser (slot %s): %s", item.slot_id, error
                )
        return released


def _origin(value: str) -> str:
    parts = urlsplit(value)
    return f"{parts.scheme.lower()}://{parts.netloc.rpartition('@')[2].lower()}"


class Slot:
    """One isolated browser (a browser context on whichever node had room) and how to reach it.

    Get one from :meth:`BrowserBay.acquire` or :meth:`BrowserBay.slot`. A slot is immutable and can be used as a
    context manager: the browser is released when the ``with`` block ends.
    """

    __slots__ = ("_box", "_url", "_slot_id", "_node_id", "_token", "_cdp_url")

    def __init__(self, box: BrowserBay, url: str, slot_id: str, token: str, node_id: Optional[str] = None) -> None:
        self._box = box
        self._url = url
        self._slot_id = slot_id
        self._node_id = node_id
        self._token = token
        self._cdp_url = _cdp_url_for(url, slot_id)

    @property
    def url(self) -> str:
        """The box this slot lives on (without trailing slashes)."""
        return self._url

    @property
    def slot_id(self) -> str:
        """The box's id for this slot."""
        return self._slot_id

    @property
    def node_id(self) -> Optional[str]:
        """The node that runs this slot's browser, when known."""
        return self._node_id

    @property
    def token(self) -> str:
        """Reaches this slot's browser and nothing else. Treat it as a secret."""
        return self._token

    @property
    def cdp_url(self) -> str:
        """The DevTools endpoint to hand to Playwright's or Puppeteer's connect, together with :attr:`headers`."""
        return self._cdp_url

    @property
    def headers(self) -> Dict[str, str]:
        """The headers every DevTools connection to this slot must carry. A fresh dict each time."""
        return {TOKEN_HEADER: self._token}

    def is_alive(self) -> bool:
        """True while the slot's browser is reachable.

        Never raises: the box is asked twice, a short pause apart, and a box that cannot be asked counts as "not alive".
        """
        try:
            return self._box._lookup(self._url, self._slot_id, self._token)
        except Exception:
            return False

    def release(self) -> None:
        """Closes the browser. Safe to call for one that is already gone (idempotent).

        :raises BrowserBayError: The box refused, with its HTTP ``status``.
        """
        self._box._delete(self._url, self._slot_id)

    def to_dict(self) -> StoredSlot:
        """What is worth keeping to come back to this browser later: pass it to :meth:`BrowserBay.slot`.

        A plain dict (``json.dumps`` it), with the same keys the Node client's ``JSON.stringify(slot)`` writes. It
        contains the slot token, so store it like a secret. The API key is never part of it.
        """
        stored: StoredSlot = {"url": self._url, "slotId": self._slot_id, "token": self._token}
        if self._node_id is not None:
            stored["nodeId"] = self._node_id
        return stored

    def __enter__(self) -> "Slot":
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if exc_type is None:
            self.release()
            return
        try:  # do not hide the error that is already on its way out
            self.release()
        except BrowserBayError as error:
            _log.warning("Could not release browser %s while leaving a with block: %s", self._slot_id, error)

    def __repr__(self) -> str:  # the token stays out of logs and tracebacks
        return f"Slot(slot_id={self._slot_id!r}, node_id={self._node_id!r}, url={self._url!r})"

