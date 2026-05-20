"""Stable payload hashing for dedupe keys."""
from __future__ import annotations

import hashlib
import json
from typing import Any


def default_dedupe_key(payload: Any) -> str:
    """SHA-1 over stable-serialized JSON. Key-order independent."""
    raw = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()
