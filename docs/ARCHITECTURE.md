# Architecture

## Three layers, clean separation

```
┌──────────────────────────────────────────────────────────────────────────┐
│  L3: snoopy (agent-specific glue — what we own)                          │
│                                                                          │
│  • defineAgent / defineTool / defineTrigger                              │
│  • Session class (prompt/skill/shell/fs/compact)                         │
│  • MCP server export (snoopy agents → MCP host tools)                    │
│  • Dashboard + traces server                                             │
│  • Dedupe (hash + semantic), conversation persistence                    │
│                                                                          │
│  ── this layer is THIN. it does NOT wrap iii primitives ──               │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ uses
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  L2: iii ecosystem workers (from workers.iii.dev — `iii worker add`)     │
│                                                                          │
│  • iii-state          ← KV + reactive change triggers                    │
│  • iii-sandbox        ← microVMs (14 sandbox::* triggers)                │
│  • iii-observability  ← OTel traces / metrics / logs / alerts            │
│  • iii-cron           ← schedule functions                               │
│  • iii-queue          ← async jobs with retries + DLQ                    │
│  • iii-stream         ← durable streams for real-time data               │
│  • iii-pubsub         ← topic-based pub/sub                              │
│  • iii-bridge         ← cross-engine federation                          │
│  • provider-openai    ← OpenAI Chat Completions as iii functions         │
│  • provider-anthropic ← Anthropic Messages as iii functions              │
│  • provider-router    ← multi-provider routing + assistant management    │
│  • auth-credentials   ← credential vault for API keys / OAuth tokens     │
│  • turn-orchestrator  ← agent turn state machine                         │
│  • approval-gate      ← function call approval workflow                  │
│  • policy-denylist    ← function call blocking policy                    │
│  • models-catalog     ← model capabilities knowledge base                │
│  ...20+ more in the registry                                             │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ runs on
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  L1: iii engine (workers, functions, triggers, state, streams, queues)   │
│      `~/.local/bin/iii --config iii-config.yaml`                         │
└──────────────────────────────────────────────────────────────────────────┘
```

## Founder's feedback (acknowledged)

> "Wrapping should not be required. iii already has workers, functions, triggers,
> state, streams, queues, cron. To add capabilities, use `iii worker add iii-state`,
> `iii worker add iii-sandbox`, etc."

He's right. Earlier drafts of snoopy had `StateKV`, `IIIStore`, `IIIState` as required
runtime layers between user code and iii. **That wrapping is unnecessary.** State,
sandbox, observability, providers, and credentials all already exist as ecosystem workers
in the iii registry — you `iii worker add <name>` and they're there.

The corrected positioning:

- snoopy provides **only** what's *agent-specific* and not already in the iii ecosystem
- For everything else, users `iii worker add <worker-name>` and call functions directly via `iii.trigger({function_id: "..."})`
- Our `StateKV` / `IIIStore` / `IIIState` classes are **typed sugar**, not required abstraction

## What snoopy actually contributes (the agent-specific glue)

| Concern | iii has it | snoopy adds |
|---|---|---|
| Workers, functions, triggers | ✅ Built-in | — |
| State KV | ✅ `iii worker add iii-state` | — (use directly) |
| Sandbox | ✅ `iii worker add iii-sandbox` | — (use directly) |
| Observability | ✅ `iii worker add iii-observability` | Dashboard UI on top |
| Cron | ✅ `iii worker add iii-cron` | `defineAgent({schedule: "..."})` shorthand |
| Queues | ✅ `iii worker add iii-queue` | — |
| LLM provider | ✅ `iii worker add provider-openai/anthropic` | Direct-fetch fallback for users who skip the worker |
| Credential vault | ✅ `iii worker add auth-credentials` | — |
| Turn orchestration | ✅ `iii worker add turn-orchestrator` | — (or use ours; user's choice) |
| **Reasoning loop with tool-calling, Zod-validated structured output, skill markdown, MCP server export, dedupe, session class** | ❌ | ✅ This is snoopy's actual job |

## Correct setup workflow

```bash
# 1. install iii (one binary)
curl -fsSL https://iii.dev/install.sh | sh

# 2. install the iii ecosystem workers you need
iii worker add iii-state            # KV memory
iii worker add iii-sandbox          # isolated shell + fs ops
iii worker add iii-observability    # OTel
iii worker add iii-cron             # scheduling
iii worker add provider-openai      # OpenAI as iii functions
iii worker add provider-anthropic   # Anthropic as iii functions
iii worker add auth-credentials     # secrets vault

# 3. start the engine — it picks up everything from config.yaml + iii.lock
iii --config iii-config.yaml

# 4. install snoopy in your project
pnpm add @snoopy/core @snoopy/cli

# 5. write your agent
# packages/my-project/agents/foo.ts:
#   import { defineAgent, defineTool, defineTrigger } from "@snoopy/core";
#   export const foo = defineAgent({ id: "foo", ... });

# 6. start your snoopy worker (registers your agents on iii)
npx tsx run.ts
```

## How user code SHOULD look (direct iii primitives, no wrapping)

```ts
import { registerWorker } from "iii-sdk";
import { defineAgent, defineTool, defineTrigger } from "@snoopy/core";
import { z } from "zod";

const iii = registerWorker(process.env.III_WS_URL!);

// State — call iii-state worker directly. No wrapper class needed.
await iii.trigger({
  function_id: "state::set",
  payload: { scope: "incidents", key: "inc_42", value: { status: "open" } },
});
const incident = await iii.trigger({
  function_id: "state::get",
  payload: { scope: "incidents", key: "inc_42" },
});

// Sandbox — call iii-sandbox worker directly.
const result = await iii.trigger({
  function_id: "sandbox::exec",
  payload: { command: ["kubectl", "get", "pods"], timeoutMs: 10_000 },
});

// LLM — call provider-openai worker directly (or use snoopy's defineAgent).
const llmResponse = await iii.trigger({
  function_id: "openai::chat",
  payload: { model: "gpt-5-mini", messages: [...], tools: [...] },
});

// Agent — this is where snoopy adds value: the reasoning loop +
// structured output + MCP server + dashboard wiring.
export const triage = defineAgent({
  id: "sre.triage",
  tools: [...],
  triggers: [defineTrigger.webhook({ path: "/alerts" })],
  result: z.object({ severity: z.enum(["sev1","sev2","sev3"]) }),
  handler: async (alert, ctx) => {
    // Inside the handler, ctx.iii is the same iii-sdk client. Call another
    // agent or any iii function directly — no ctx.call wrapper:
    const enrichment = await ctx.iii.trigger({
      function_id: "snoopy.enrichment",
      payload: { alert },
    });
    return await ctx.session.prompt(`triage: ${alert.msg}`, { result });
  },
});
```

## Why our wrapper classes still ship (optional sugar)

| Class | What it is | When to use |
|---|---|---|
| `StateKV(iii)` | Typed `get/set/update/delete/list<T>` over `state::*` | TS users who want generics + autocomplete |
| `IIIStore` | Full `Memory` interface backed by iii state | Drop-in for `defineAgent({memory: new IIIStore()})` |
| `IIIState(scope)` | Scoped shortcut for ad-hoc KV in agent code | Convenience when you don't want a `Memory` |
| `iiiClient()` | Cached singleton SDK with snoopy-flavored config | Lazy-init in plain agent code; not required |

None of these are required. They wrap nothing the user couldn't do themselves with a one-line `iii.trigger(...)` call. They exist because TypeScript developers tend to prefer typed methods over stringly-typed function ids.

## Files actually owned by snoopy (everything in `packages/core/src/`)

The agent-specific value (what we'd write even if iii did everything else):

- `defineAgent.ts` — the kernel
- `session.ts` — the Session class with prompt/skill/shell/fs/compact
- `loop.ts` — multi-turn tool-calling reasoning loop
- `defineTool.ts` — registers tools as `<agent>::tool::<name>` iii functions + zod parse + idempotent replay
- `defineTrigger.ts` — typed builders over iii's 10 trigger types
- `discovery.ts` + `skills.ts` — role/skill markdown loaders
- `mcp.ts` + `mcpServer.ts` — bidirectional MCP (consume + expose)
- `dashboardHtml.ts` + `tracesServer.ts` — embedded dashboard
- `dedupe.ts` — payload hash + semantic dedupe
- `llm.ts` — direct fetch fallback (will be deprecated in favor of `provider-openai` worker)

The rest (`stateKv.ts`, `iiiState.ts`, `memory.ts` `IIIStore`, etc.) is sugar.

## Path forward

| Priority | Item |
|---|---|
| High | Switch default LLM call path from direct fetch to `provider-openai` worker (when installed) |
| High | Switch trace storage from PgTraceStore to `iii-observability` worker (when installed) |
| High | Switch credential lookup from env vars to `auth-credentials` worker (when installed) |
| Medium | Evaluate replacing our reasoning loop with `turn-orchestrator` worker |
| Medium | Add `iii worker add` recommendations to `agent doctor` |
| Medium | Ship a `scripts/setup-workers.sh` that installs the recommended ecosystem |
| Low | Deprecate wrapper classes; keep as sugar |
