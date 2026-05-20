"""Memory backends: KV + append-only streams."""
from __future__ import annotations

import json
import os
import time
from typing import Any, AsyncIterator, Optional, Protocol


class Memory(Protocol):
    async def get(self, key: str) -> Optional[Any]: ...
    async def set(self, key: str, value: Any, ttl_sec: Optional[int] = None) -> None: ...
    async def delete(self, key: str) -> None: ...
    async def append(self, stream: str, event: Any) -> str: ...
    def range(self, stream: str, from_: Optional[str] = None) -> AsyncIterator[Any]: ...
    def tail(self, stream: str, from_: Optional[str] = None) -> AsyncIterator[Any]: ...


class InMemoryStore:
    """Process-local KV + streams. Dev-only."""

    def __init__(self) -> None:
        self._kv: dict[str, tuple[Any, Optional[float]]] = {}
        self._streams: dict[str, list[tuple[str, Any]]] = {}
        self._seq = 0

    async def get(self, key: str) -> Optional[Any]:
        entry = self._kv.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if expires_at is not None and expires_at < time.time():
            del self._kv[key]
            return None
        return value

    async def set(self, key: str, value: Any, ttl_sec: Optional[int] = None) -> None:
        expires_at = time.time() + ttl_sec if ttl_sec else None
        self._kv[key] = (value, expires_at)

    async def delete(self, key: str) -> None:
        self._kv.pop(key, None)

    async def append(self, stream: str, event: Any) -> str:
        self._seq += 1
        sid = f"{int(time.time() * 1000)}-{self._seq}"
        self._streams.setdefault(stream, []).append((sid, event))
        return sid

    async def range(self, stream: str, from_: Optional[str] = None):
        for sid, value in self._streams.get(stream, []):
            if from_ is None or sid > from_:
                yield value

    async def tail(self, stream: str, from_: Optional[str] = None):
        # Best-effort poll for in-memory mode.
        import asyncio

        cursor = from_
        while True:
            yielded = False
            for sid, value in self._streams.get(stream, []):
                if cursor is None or sid > cursor:
                    cursor = sid
                    yielded = True
                    yield value
            if not yielded:
                await asyncio.sleep(0.5)


class RedisStore:
    """Redis-backed Memory. Streams use XADD/XRANGE/XREAD BLOCK."""

    def __init__(self, *, url: Optional[str] = None, prefix: str = "snoopy:") -> None:
        try:
            import redis.asyncio as redis_async
        except ImportError as e:
            raise RuntimeError("redis not installed. `pip install redis`.") from e
        self._client = redis_async.from_url(
            url or os.environ.get("REDIS_URL", "redis://localhost:6379"),
            decode_responses=True,
        )
        self._prefix = prefix

    def _k(self, key: str) -> str:
        return f"{self._prefix}{key}"

    async def get(self, key: str) -> Optional[Any]:
        raw = await self._client.get(self._k(key))
        return json.loads(raw) if raw else None

    async def set(self, key: str, value: Any, ttl_sec: Optional[int] = None) -> None:
        raw = json.dumps(value, default=str)
        if ttl_sec:
            await self._client.set(self._k(key), raw, ex=ttl_sec)
        else:
            await self._client.set(self._k(key), raw)

    async def delete(self, key: str) -> None:
        await self._client.delete(self._k(key))

    async def append(self, stream: str, event: Any) -> str:
        return await self._client.xadd(
            self._k(f"stream:{stream}"), {"v": json.dumps(event, default=str)}
        )

    async def range(self, stream: str, from_: Optional[str] = None):
        entries = await self._client.xrange(
            self._k(f"stream:{stream}"), min=from_ or "-", max="+"
        )
        for _sid, fields in entries:
            v = fields.get("v")
            if v:
                try:
                    yield json.loads(v)
                except json.JSONDecodeError:
                    yield v

    async def tail(self, stream: str, from_: Optional[str] = None):
        cursor = from_ or "$"
        key = self._k(f"stream:{stream}")
        while True:
            res = await self._client.xread({key: cursor}, block=0)
            if not res:
                continue
            for _, entries in res:
                for sid, fields in entries:
                    cursor = sid
                    v = fields.get("v")
                    if v:
                        try:
                            yield json.loads(v)
                        except json.JSONDecodeError:
                            yield v
