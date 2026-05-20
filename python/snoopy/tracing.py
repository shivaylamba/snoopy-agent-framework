"""Span emission — stdout + pluggable external sinks."""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

TRACE_STREAM = "snoopy.trace"


@dataclass
class Span:
    agent_id: str
    run_id: str
    parent_run_id: Optional[str] = None


@dataclass
class SpanEvent:
    agent_id: str
    run_id: str
    event: str
    ts: int = field(default_factory=lambda: int(time.time() * 1000))
    data: Any = None
    parent_run_id: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "agentId": self.agent_id,
            "runId": self.run_id,
            "parentRunId": self.parent_run_id,
            "event": self.event,
            "data": self.data,
            "ts": self.ts,
        }


class TraceSink(Protocol):
    async def record(self, event: SpanEvent) -> None: ...


_external_sinks: list[TraceSink] = []


def add_trace_sink(sink: TraceSink) -> None:
    _external_sinks.append(sink)


def emit_span(span: Span, *, event: str, data: Any = None, memory=None) -> None:
    """
    Best-effort span emission. Goes to stdout, optional Memory stream
    (Redis), and any registered external sinks. Never raises.
    """
    ev = SpanEvent(
        agent_id=span.agent_id,
        run_id=span.run_id,
        parent_run_id=span.parent_run_id,
        event=event,
        data=data,
    )

    if os.environ.get("SNOOPY_TRACE_STDOUT", "true").lower() not in ("false", "0"):
        run_short = ev.run_id[:8] if ev.run_id else ""
        print(f"[trace {ev.agent_id} {run_short}] {ev.event} {data or ''}")

    if memory is not None:
        try:
            import asyncio

            asyncio.create_task(_safe_append(memory, ev))
        except Exception:
            pass

    for sink in _external_sinks:
        try:
            import asyncio

            asyncio.create_task(_safe_record(sink, ev))
        except Exception:
            pass


async def _safe_append(memory, ev: SpanEvent) -> None:
    try:
        await memory.append(TRACE_STREAM, ev.to_dict())
    except Exception:
        pass


async def _safe_record(sink: TraceSink, ev: SpanEvent) -> None:
    try:
        await sink.record(ev)
    except Exception:
        pass
