"""Plain data shapes returned by (and stored for) the client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TypedDict


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
