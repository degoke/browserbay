"""Wire constants shared with the box (mirrors ``src/protocol.ts`` in the browserbay repository)."""

from __future__ import annotations

import re

#: Sent by whoever drives or watches a slot's browser, on the CDP socket and on the slot lookup.
TOKEN_HEADER = "x-browserbay-token"

#: A name (a namespace, say): letters, digits, ``_``, ``.`` and ``-`` only. ASCII on purpose, like the box's own rule.
NAME_PATTERN = re.compile(r"[A-Za-z0-9_.\-]+")

MIN_LIFETIME_SECONDS = 60
MAX_LIFETIME_SECONDS = 86_400
#: ``run_id`` length, counted in UTF-16 code units like the box does. A namespace prefix counts.
MAX_RUN_ID_LENGTH = 200

SLOTS_PATH = "/v1/slots"
NODES_PATH = "/v1/nodes"
