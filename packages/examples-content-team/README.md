# content-team example

Port of [Arindam200/awesome-ai-apps content_team_agent](https://github.com/Arindam200/awesome-ai-apps/tree/main/advance_ai_agents/content_team_agent) (originally on Agno + Nebius) to **snoopy on iii.dev**.

5 specialist agents + 1 orchestrator. Generates SEO content briefs or audits existing articles for Google AI Search ranking.

## Architecture (founder's "no wrapping required" model)

```
┌─────────────────────────────────────────────────────────────────┐
│ content.workflow         ← snoopy orchestrator (this example)   │
│   └─ ctx.call("content.topic-extract", …)                       │
│   └─ ctx.call("content.serp-analyze",  …)                       │
│   └─ ctx.call("content.brief", …)  or  ("content.article-audit")│
│   └─ ctx.call("content.section-edits", …)                       │
│                                                                 │
│   ── Direct iii primitive calls (no wrapping) ──                │
│   await sdk.trigger({ function_id: "state::set",                │
│                       payload: { scope, key, value } });        │
│   await sdk.trigger({ function_id: "state::get", … });          │
│   await sdk.trigger({ function_id: "state::list", … });         │
└─────────────────────────────────────────────────────────────────┘
              │
              ▼ all dispatched via the iii engine
┌─────────────────────────────────────────────────────────────────┐
│ iii ecosystem workers (install with `iii worker add <name>`)    │
│                                                                 │
│   iii-state          ← KV for run records                       │
│   iii-observability  ← OTel traces of every agent call          │
│   iii-cron           ← optional: scheduled runs                 │
│   provider-openai    ← optional: LLM as iii functions           │
│   auth-credentials   ← optional: SERPAPI_API_KEY vault          │
└─────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│ iii engine                                                      │
│   `iii --config iii-config.yaml`                                │
└─────────────────────────────────────────────────────────────────┘
```

## What's NOT wrapped

The workflow handler calls iii state primitives **directly** — no `StateKV`, no `IIIStore`:

```ts
// in workflow.ts — survives engine restart when iii-state is file-backed
await sdk.trigger({
  function_id: "state::set",
  payload: {
    scope: "content.workflow:runs",
    key: `${ctx.runId}:serp-analyzed`,
    value: { step, data, ts: Date.now() },
  },
});
```

Every meaningful step persists a record. After a run completes you can query:

```bash
# fetch a specific step's output
iii trigger state::get --json '{"scope":"content.workflow:runs","key":"run_abc:brief-complete"}'

# list every record this workflow has produced
iii trigger state::list --json '{"scope":"content.workflow:runs"}'
```

That's iii-state being used directly — exactly the surface `iii worker add iii-state` exposes. snoopy adds zero wrapping on this path.

## What snoopy DOES contribute

| Concern | Where it lives |
|---|---|
| `defineAgent({ id, handler, result, ... })` kernel | `@snoopy/core` |
| `ctx.call(childAgentId, payload, { timeoutMs })` | `@snoopy/core` AgentContext |
| `ctx.session.prompt(text, { result: zodSchema })` | `@snoopy/core` Session |
| Markdown roles in `roles/*.md` | discovered by `@snoopy/core` at runtime |
| Zod schema → JSON Schema → tool params | `@snoopy/core` `defineTool` |
| Dedupe on payload hash (same input within 10min → cached) | `@snoopy/core` defineAgent |
| Trace span emission to dashboard | `@snoopy/core` tracing |

## Quick start

```bash
# 1. Install iii (one binary) and ecosystem workers
curl -fsSL https://iii.dev/install.sh | sh
bash ../../scripts/setup-workers.sh

# 2. Start iii with this directory's config
iii --config iii-config.yaml &

# 3. Set API keys (or move them to `auth-credentials` worker once installed)
export OPENAI_API_KEY=sk-...
# Optional: real SERP data instead of mock fallback
export SERPAPI_API_KEY=your-key-here

# 4. Start the worker
pnpm install && pnpm build
npx tsx run.ts &

# 5. Fire it (three ways — all hit the same agent via iii)
iii trigger content.workflow --json '{"topic":"rate limiting for REST APIs"}'

curl -X POST http://localhost:3111/api/triggers/http/content-seo \
  -H 'content-type: application/json' \
  -d '{"topic":"observability for AI agents"}'

# Or from any MCP host (Claude Desktop / Cursor / Continue) since
# snoopy auto-exposes agents at http://localhost:4280/mcp
```

## Three modes (same workflow, branches on inputs)

```bash
# 1. Pre-writing brief — just a topic
iii trigger content.workflow --json '{"topic":"distributed agent frameworks"}'

# 2. Audit + rewrite an existing article from a URL
iii trigger content.workflow --json '{"url":"https://example.com/blog/x"}'

# 3. Audit + rewrite when you already have the article text
iii trigger content.workflow --json '{
  "title":"My Article",
  "content":"... full article body ..."
}'
```

Reports written to `.tmp/reports/content_seo/`:
- `search_insights.md` — keyword research + competitor analysis
- `content_brief.md` *(brief mode)* — outline + headings + FAQs + writing guidelines
- `article_audit.md` *(audit mode)* — gaps, opportunities, E-E-A-T assessment
- `section_edits.md` *(audit mode)* — keyword-optimized rewrites

Run records also persist in iii state (`scope: content.workflow:runs`) — queryable after the fact, distributable across workers, durable when `iii-state` is file-backed.

## Result of one live run (verified)

| Metric | Value |
|---|---|
| Input | `{"topic": "rate limiting for REST APIs"}` |
| Mode | brief (no URL/content) |
| Sub-agents called | `content.serp-analyze` → `content.brief` |
| Tools invoked over iii | `google_ai_mode_search`, `google_ai_overview_search` |
| Total wall time | ~71 seconds |
| LLM token spend | ~5K in / 4K out across 4 OpenAI calls |
| Reports generated | 2 markdown files (real keyword research + 16-section brief) |
| Run records in iii state | 4 (`inputs-normalized`, `serp-analyzed`, `brief-complete`, `done`) |

## How this differs from the Agno original

| Concern | Agno original | snoopy port |
|---|---|---|
| LLM | Nebius (Moonshot/Llama Nemotron) | OpenAI gpt-5-mini (any pi-ai provider if `@snoopy/llm-pi-ai`) |
| Orchestration | `Workflow.arun()` in one Python process | Each sub-agent is a separate **iii function** — distributable across workers |
| Tools | `@tool()` decorator, in-process | `defineTool()` → registers as `<agent>::tool::<name>` iii function — callable from anywhere |
| Sub-agent calls | Direct in-process method calls | `ctx.call()` → `iii.trigger()` — runs on whichever worker has the function |
| Dynamic agent instructions | Mutates `agent.instructions` at runtime | Two separate agents (`content.brief`, `content.article-audit`) — cleaner separation |
| Run history | None | Persisted via direct `state::set` calls — queryable, distributable, durable |
| Dedupe | None | Payload-hash dedupe with 10min TTL |
| Triggers | Streamlit/CLI only | HTTP + MCP server (Claude Desktop ready) + direct `iii trigger` |
| Auth on triggers | None | `defineTrigger.http({ auth: {type:'bearer', secretEnv:'X'} })` opt-in |
| Trace observability | None | Spans → stdout + Postgres + `iii-observability` worker (when installed) |
