"""iii engine connection — process-wide singleton."""
from __future__ import annotations

import asyncio
import os
import socket
from typing import Optional

try:
    from iii_sdk import III
except ImportError:  # pragma: no cover
    III = None  # type: ignore[assignment]

_client: Optional["III"] = None


def iii_client() -> "III":
    """Get-or-create the per-process iii client. Connects on first call."""
    global _client
    if _client is None:
        if III is None:
            raise RuntimeError(
                "iii-sdk Python package not installed. `pip install iii-sdk`."
            )
        url = os.environ.get("III_WS_URL", "ws://localhost:49134")
        _client = III(url)
        # iii-sdk Python is opt-in connect (unlike Node which auto-connects).
        # We call .connect() and wait for the connection to be ready.
        # Errors here surface as RuntimeError to the caller.
        connect = getattr(_client, "connect", None)
        if callable(connect):
            result = connect()
            if asyncio.iscoroutine(result):
                # Caller is responsible for awaiting in async context.
                # For non-async callers, schedule synchronously.
                try:
                    asyncio.get_running_loop()
                    # In an async loop — caller must await iii_client_async()
                    raise RuntimeError(
                        "Use `await iii_client_async()` inside an event loop."
                    )
                except RuntimeError:
                    asyncio.run(result)
    return _client  # type: ignore[return-value]


async def iii_client_async() -> "III":
    """Async-safe initializer for use inside an event loop."""
    global _client
    if _client is None:
        if III is None:
            raise RuntimeError("iii-sdk Python package not installed.")
        url = os.environ.get("III_WS_URL", "ws://localhost:49134")
        _client = III(url)
        connect = getattr(_client, "connect", None)
        if callable(connect):
            result = connect()
            if asyncio.iscoroutine(result):
                await result
    return _client  # type: ignore[return-value]


async def start_worker() -> None:
    """
    Block forever serving registered agents. Call this at the end of your
    entry script after all `@define_agent(...)` decorators have run.

    The iii Python SDK keeps a WebSocket connection alive in a background
    task; this function just sleeps so the process doesn't exit.
    """
    await iii_client_async()
    name = os.environ.get("SNOOPY_WORKER_NAME", f"snoopy-py-{socket.gethostname()}-{os.getpid()}")
    print(f"[snoopy] worker {name} ready")
    while True:
        await asyncio.sleep(3600)
