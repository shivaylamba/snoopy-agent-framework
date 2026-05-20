"""Typed builders for all 10 iii trigger types."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Optional

TriggerType = Literal[
    "http", "cron", "webhook", "queue", "event",
    "stream", "state", "subscribe", "log", "direct",
]


@dataclass
class TriggerDef:
    type: TriggerType
    config: dict[str, Any]


class _TriggerBuilders:
    @staticmethod
    def http(*, path: str, method: str = "POST") -> TriggerDef:
        return TriggerDef("http", {"api_path": path, "http_method": method})

    @staticmethod
    def cron(*, schedule: str, timezone: Optional[str] = None) -> TriggerDef:
        return TriggerDef("cron", {"schedule": schedule, "timezone": timezone})

    @staticmethod
    def webhook(*, path: str, secret_header: Optional[str] = None) -> TriggerDef:
        return TriggerDef("webhook", {"api_path": path, "secret_header": secret_header})

    @staticmethod
    def queue(*, queue: str, concurrency: int = 1) -> TriggerDef:
        return TriggerDef("queue", {"queue": queue, "concurrency": concurrency})

    @staticmethod
    def event(*, event: str, filter: Optional[str] = None) -> TriggerDef:
        return TriggerDef("event", {"event": event, "filter": filter})

    @staticmethod
    def stream(*, channel: str, event: str = "message") -> TriggerDef:
        return TriggerDef("stream", {"channel": channel, "event": event})

    @staticmethod
    def state(*, key: str) -> TriggerDef:
        return TriggerDef("state", {"key": key})

    @staticmethod
    def subscribe(*, topic: str) -> TriggerDef:
        return TriggerDef("subscribe", {"topic": topic})

    @staticmethod
    def log(*, pattern: str, level: Optional[str] = None) -> TriggerDef:
        return TriggerDef("log", {"pattern": pattern, "level": level})

    @staticmethod
    def direct() -> TriggerDef:
        return TriggerDef("direct", {})


define_trigger = _TriggerBuilders()
