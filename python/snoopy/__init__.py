"""
snoopy — distributed agent framework, Python SDK.

Pairs with the TypeScript framework in `packages/`. Both register Functions
against the same iii engine; you can run some agents in TS and others in
Python on the same orchestration layer.

The Python SDK is harness-agnostic on purpose: the LLM call lives inside
your handler function so you can plug in OpenAI, Anthropic, transformers,
LiteLLM, or anything else. We provide the iii registration, memory,
dedupe, tracing, sub-agent spawn/call, and the AgentContext.

Quick start:

    from snoopy import define_agent, define_trigger

    @define_agent(
        id="research.summarize",
        triggers=[define_trigger.http(path="/summarize")],
    )
    async def summarize(payload, ctx):
        import openai
        r = await openai.chat.completions.create(
            model="gpt-5-mini",
            messages=[{"role": "user", "content": payload["text"]}],
        )
        return {"summary": r.choices[0].message.content}
"""
from .agent import define_agent, AgentContext, RegisteredAgent
from .triggers import define_trigger, TriggerDef
from .tools import define_tool, ToolDef
from .memory import Memory, InMemoryStore, RedisStore
from .tracing import Span, emit_span, add_trace_sink, TraceSink
from .runtime import iii_client, start_worker

__all__ = [
    "define_agent",
    "define_tool",
    "define_trigger",
    "AgentContext",
    "RegisteredAgent",
    "TriggerDef",
    "ToolDef",
    "Memory",
    "InMemoryStore",
    "RedisStore",
    "Span",
    "emit_span",
    "add_trace_sink",
    "TraceSink",
    "iii_client",
    "start_worker",
]
