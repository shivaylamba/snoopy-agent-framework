"""define_agent — the kernel of the Python SDK."""
from __future__ import annotations

import asyncio
import os
import random
import string
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, Union

from .dedupe import default_dedupe_key
from .memory import InMemoryStore, Memory
from .tracing import Span, emit_span
from .runtime import iii_client_async
from .triggers import TriggerDef
from .tools import ToolDef

DEFAULT_DEDUPE_TTL_SEC = 300

AgentHandler = Callable[[Any, "AgentContext"], Awaitable[Any]]


@dataclass
class AgentContext:
    """
    Per-invocation context passed to the agent's handler. Mirror of the
    TS @snoopy/core AgentContext.
    """
    run_id: str
    memory: Memory
    _iii: Any  # iii-sdk client
    _span: Span

    def emit(self, event: str, data: Any = None) -> None:
        emit_span(self._span, event=event, data=data, memory=self.memory)

    async def spawn(self, child_agent_id: str, payload: Any) -> Any:
        """Fire-and-forget sub-agent. Returns iii's enqueue receipt."""
        emit_span(self._span, event="agent.spawn", data={"child": child_agent_id}, memory=self.memory)
        # iii-sdk Python — TriggerAction.Void()
        try:
            from iii_sdk import TriggerAction  # type: ignore
            return await self._iii.trigger(
                function_id=child_agent_id,
                payload=payload,
                action=TriggerAction.Void(),
            )
        except (ImportError, AttributeError):
            return await self._iii.trigger(function_id=child_agent_id, payload=payload)

    async def call(
        self, child_agent_id: str, payload: Any, *, timeout_ms: Optional[int] = None
    ) -> Any:
        """Synchronous sub-agent. Awaits the child's return value."""
        emit_span(self._span, event="agent.call", data={"child": child_agent_id}, memory=self.memory)
        kwargs: dict[str, Any] = {"function_id": child_agent_id, "payload": payload}
        if timeout_ms is not None:
            kwargs["timeout_ms"] = timeout_ms
        result = await self._iii.trigger(**kwargs)
        emit_span(
            self._span, event="agent.call.return", data={"child": child_agent_id}, memory=self.memory
        )
        return result


@dataclass
class RegisteredAgent:
    id: str
    memory: Memory


def _generate_run_id() -> str:
    return "run_" + format(int(time.time() * 1000), "x") + "_" + "".join(
        random.choices(string.ascii_lowercase + string.digits, k=8)
    )


def define_agent(
    *,
    id: str,
    triggers: Optional[list[TriggerDef]] = None,
    tools: Optional[list[ToolDef]] = None,
    memory: Optional[Memory] = None,
    dedupe: Union[bool, Callable[[Any], str]] = True,
    dedupe_ttl_sec: int = DEFAULT_DEDUPE_TTL_SEC,
) -> Callable[[AgentHandler], RegisteredAgent]:
    """
    Decorator. Registers an async function as an iii Function whose body
    is the agent loop:

        @define_agent(
            id="sre.triage",
            triggers=[define_trigger.webhook(path="/alerts/pagerduty")],
        )
        async def triage(payload, ctx):
            ...
            return {"severity": "sev2"}

    The decorator does NOT block — call `await start_worker()` at the end
    of your script to keep the process alive.

    Tools currently surface as metadata only — the Python SDK doesn't
    have a built-in harness loop (you call your LLM inline). Pass tools
    if you want the dashboard to know which tools an agent can use.
    """
    _ = tools  # reserved for future use

    def decorator(handler: AgentHandler) -> RegisteredAgent:
        mem = memory or InMemoryStore()

        async def _bootstrap() -> None:
            iii = await iii_client_async()

            async def function_handler(payload: Any) -> Any:
                run_id = _generate_run_id()
                span = Span(agent_id=id, run_id=run_id)

                # Dedupe gate.
                key: Optional[str] = None
                if dedupe is True:
                    key = default_dedupe_key(payload)
                elif callable(dedupe):
                    key = dedupe(payload)
                if key:
                    cached = await mem.get(f"dedupe:{id}:{key}")
                    if cached is not None:
                        emit_span(span, event="agent.dedupe.hit", data={"key": key}, memory=mem)
                        return cached

                emit_span(span, event="agent.start", data={"payload": payload}, memory=mem)
                ctx = AgentContext(run_id=run_id, memory=mem, _iii=iii, _span=span)
                try:
                    result = await handler(payload, ctx)
                    emit_span(span, event="agent.end", data={"result": result}, memory=mem)
                    if key:
                        await mem.set(f"dedupe:{id}:{key}", result, ttl_sec=dedupe_ttl_sec)
                    return result
                except Exception as e:
                    emit_span(span, event="agent.error", data={"error": str(e)}, memory=mem)
                    raise

            # iii-sdk Python: register_function(function_id, handler)
            register = getattr(iii, "register_function", None) or getattr(
                iii, "registerFunction", None
            )
            if register is None:
                raise RuntimeError("iii-sdk: no register_function method found")
            await _maybe_await(register(id, function_handler))

            for trig in triggers or []:
                register_trigger = getattr(iii, "register_trigger", None) or getattr(
                    iii, "registerTrigger", None
                )
                if register_trigger is None:
                    continue
                await _maybe_await(
                    register_trigger(
                        type=trig.type,
                        function_id=id,
                        config=trig.config,
                    )
                )

        # Kick off the registration in the background. If we're already in
        # an event loop, schedule it; otherwise run synchronously now.
        try:
            asyncio.get_running_loop()
            asyncio.create_task(_bootstrap())
        except RuntimeError:
            asyncio.run(_bootstrap())

        return RegisteredAgent(id=id, memory=mem)

    return decorator


async def _maybe_await(value: Any) -> Any:
    if asyncio.iscoroutine(value):
        return await value
    return value
