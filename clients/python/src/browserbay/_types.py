"""Plain data shapes returned by (and stored for) the client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional, Tuple, TypedDict


@dataclass(frozen=True)
class SlotSummary:
    """One slot as ``BrowserBay.list()`` shows it. It carries no secret."""

    #: The box's id for the slot.
    slot_id: str
    #: Your run id (with the client's namespace removed).
    run_id: str
    #: The node that runs the slot's browser.
    node_id: str
    #: When the slot was created, as the ISO 8601 string the box sent.
    created_at: str


@dataclass(frozen=True)
class NodeSummary:
    """One node as ``BrowserBay.nodes()`` shows it."""

    node_id: str
    #: How many slots the node offers.
    max_contexts: int
    #: How many are in use.
    contexts: int
    #: True while the node is finishing its slots and taking no new ones.
    draining: bool
    #: When the box last heard from the node, as the ISO 8601 string the box sent.
    last_seen_at: str
    #: What the node can do for a slot beyond giving it a browser (``proxy``, ``locale``). Empty for a box that predates them.
    features: Tuple[str, ...] = ()
    #: What the node's operator calls it: ``acquire(node_labels=...)`` can ask for them.
    labels: Tuple[str, ...] = ()
    #: True when the node only takes slots that ask for one of its labels.
    exclusive: bool = False


@dataclass(frozen=True, repr=False)
class Proxy:
    """A proxy for one slot: ``acquire(proxy=Proxy("http://proxy.example.com:8080", "user", "password"))``.

    ``server`` is ``http://``, ``https://`` or ``socks5://`` with ``host:port``, and nothing else in it. The credentials stay
    on the box's node, which reaches the proxy for the browser: the browser never holds them and a page cannot read them.
    A plain ``dict`` with the same keys (``server``, ``username``, ``password``, ``bypass``) works too.

    Its ``repr`` hides the password, so a log line or a traceback that shows it does not leak it.
    """

    server: str
    username: Optional[str] = None
    password: Optional[str] = None
    #: Chromium's proxy bypass list: host patterns that go direct, separated by ``,`` or ``;``.
    bypass: Optional[str] = None

    def to_dict(self) -> Dict[str, str]:
        """What is sent to the box: only the fields that are set."""
        fields = {"server": self.server, "username": self.username, "password": self.password, "bypass": self.bypass}
        return {name: value for name, value in fields.items() if value is not None}

    def __repr__(self) -> str:
        hidden = "'***'" if self.password is not None else "None"
        return f"Proxy(server={self.server!r}, username={self.username!r}, password={hidden}, bypass={self.bypass!r})"


class _StoredSlotRequired(TypedDict):
    slotId: str
    token: str


class StoredSlot(_StoredSlotRequired, total=False):
    """The part of a slot worth keeping to come back to it later (``Slot.to_dict()``, ``BrowserBay.slot()``).

    The keys match what the Node client's ``JSON.stringify(slot)`` writes, so a slot stored by one can be revived by
    the other. It contains the slot token: store it like a secret.
    """

    #: The box the slot is on. Defaults to the client's own box.
    url: str
    nodeId: str
