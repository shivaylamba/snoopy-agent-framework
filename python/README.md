# snoopy (Python SDK)

Python sibling of the TypeScript framework. Same iii engine, same trace stream — agents written in either language interoperate.

The Python SDK is intentionally harness-agnostic: the LLM call lives inside your handler so you can plug in any Python library (openai, anthropic, transformers, LiteLLM, langchain, etc.).

## Install

```bash
pip install -e .
# or with extras
pip install -e ".[weaviate,postgres]"
```

## Quick start

```python
import asyncio
from snoopy import define_agent, define_trigger, start_worker

@define_agent(
    id="research.summarize",
    triggers=[define_trigger.http(path="/summarize")],
)
async def summarize(payload, ctx):
    import openai
    r = openai.chat.completions.create(
        model="gpt-5-mini",
        messages=[{"role": "user", "content": f"Summarize: {payload['text']}"}],
    )
    summary = r.choices[0].message.content

    # Cross-language fan-out: call a TS-defined agent
    classification = await ctx.call("sre.triage", {"text": summary})

    await ctx.memory.append(f"sums:{ctx.run_id}", {"summary": summary})
    ctx.emit("summarized", {"length": len(summary)})
    return {"summary": summary, "classification": classification}

if __name__ == "__main__":
    asyncio.run(start_worker())
```

## Interop with the TypeScript framework

Both SDKs register against the same iii engine, so:

- A TS agent can `ctx.call("research.summarize", ...)` and reach a Python handler.
- A Python agent can `ctx.call("sre.triage", ...)` and reach a TS handler.
- Both write to the same `snoopy.trace` Redis stream and Postgres table — the same dashboard shows both.
- `agent traces`, `agent logs`, and `agent invoke` from the TS CLI all work against Python-registered functions.

## What the Python SDK does NOT include

- Built-in LLM harness loop (you call the LLM yourself — pick any library).
- Flue-style skill markdown discovery (use your prompt strings directly).
- Zod-style schema parsing (use pydantic models in `define_tool(input_model=...)`).

These are intentional scope decisions. If you want a Flue-backed loop, define those agents in TS and `ctx.call` them from Python where convenient.
