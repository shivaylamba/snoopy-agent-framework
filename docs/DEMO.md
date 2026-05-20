# Live Demo Runbook

How to show snoopy to someone in ~5 minutes.

## What the audience will see

| | What it is | URL / command |
|---|---|---|
| **The product** | The framework: agents + tools + triggers + memory + traces | `packages/core/src/defineAgent.ts` (one screen) |
| **The dashboard** | Live trace UI: agent stats, run timelines, JSON inspection | http://localhost:3210/ |
| **The demo flow** | Fire a webhook → real OpenAI call → structured triage result | `iii trigger sre.triage --json …` |
| **The story** | "Most agent frameworks stop at chat. This treats agents as distributed software." | the pitch below |

## 3 windows on your screen

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│                                     │                                     │
│   Browser: http://localhost:3210    │   Terminal A (engine + worker)      │
│   ← agent cards, stats, runs        │   ← agent dev output streaming      │
│                                     │                                     │
├─────────────────────────────────────┴─────────────────────────────────────┤
│                                                                           │
│   Terminal B (where you fire triggers)                                    │
│   ← iii trigger sre.triage --json '{...}'                                 │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

## Setup (one-time, ~2 min)

```bash
# 1. Install iii
curl -fsSL https://iii.dev/install.sh | sh    # OR
gh release download iii/v0.12.0 --repo iii-hq/iii \
   --pattern "iii-aarch64-apple-darwin.tar.gz"
tar -xzf iii-aarch64-apple-darwin.tar.gz
mv iii ~/.local/bin/iii

# 2. Boot infrastructure
cd /Users/shivaylamba/Downloads/weaviate-olostep/rohit
docker compose up -d
pnpm install && pnpm build

# 3. Set the LLM key
export OPENAI_API_KEY='sk-…'
```

## Run the demo (~3 min)

### Terminal A — start everything

```bash
# iii engine (Rust binary)
~/.local/bin/iii --use-default-config &

# Worker (registers agents + wires Postgres trace sink)
cd packages/examples-sre
npx tsx run-with-postgres-trace.ts &

# Dashboard
node -e "
const c = await import('@snoopy/core');
const pg = new c.PgTraceStore();
c.startTracesServer({store: pg, port: 3210});
console.log('dashboard at http://localhost:3210');
await new Promise(()=>{});
" &
```

**Open http://localhost:3210/** in your browser. You should see the snoopy header with stats (0 runs initially), `sre.triage`, `sre.investigator`, `sre.fixer` in the sidebar.

### Terminal B — fire triggers live

The demo is firing real triggers from this terminal and watching them land in the dashboard. Each one is a real OpenAI call.

**Trigger 1 — a normal alert:**
```bash
~/.local/bin/iii trigger sre.triage \
  --json '{"service":"payments","msg":"5xx spike on payments — 35% error rate"}'
```

Talk through what's happening while it runs (≈30s):
- iii engine dispatched to the worker over WebSocket
- `defineAgent` wrapper opened a Flue session
- The model is currently calling `kubectl` and `prometheus_query` tools
- Result will be Zod-parsed against the schema before returning
- All spans are flowing to the dashboard right now

You can refresh the browser as it runs — you'll see `agent.start` appear, then the run sits in "running…" state, then flips to ✓ when done.

**Trigger 2 — different service, different severity:**
```bash
~/.local/bin/iii trigger sre.triage \
  --json '{"service":"checkout","msg":"checkout latency p99 exceeded 2s for 5 minutes"}'
```

**Trigger 3 — show dedupe:**
```bash
# Same exact payload twice
~/.local/bin/iii trigger sre.triage --json '{"service":"auth","msg":"login p99 1.8s"}'
~/.local/bin/iii trigger sre.triage --json '{"service":"auth","msg":"login p99 1.8s"}'
```

The second one returns instantly (0s) — dedupe cache hit. Show the worker log: `agent.dedupe.hit { key: '…' }`.

### What to show in the dashboard

1. **Top-of-screen stats** — runs, success rate, p50/p99 latency, agent count, live pulse
2. **Sidebar** — `sre.triage` selected. Each agent shows a sparkline of recent runs (green/red squares colored by duration).
3. **Run cards** — click one to expand. Shows the timeline:
   - `agent.start` (input payload)
   - `agent.end` (full LLM output)
   - Timing bars proportional to wall clock
4. **JSON viewer** — the full structured output (severity, suspectedRootCause, recommendedAction, spawnFixer) lives inside each event's pre block

### The pitch (90 seconds)

> Most agent frameworks treat agents as ephemeral chatbots-with-tools — synchronous prompt chains, no retries, no observability.
>
> snoopy treats agents as **distributed software**:
> - **Flue** runs the reasoning loop (real LLM + tool calling)
> - **iii.dev** runs the orchestration (workers, triggers, retries, queues — 10 trigger types)
> - **Our glue** wires the two with durable memory, dedupe, retry-resume, semantic recall, full trace
>
> The agent you saw fire is registered on a real distributed engine. It would survive a worker crash, dedupe duplicate alerts, fan out to sub-agents synchronously or async, persist to Redis or Postgres or Weaviate.
>
> And you can write the next agent in Python — same engine, same dashboard, same memory store.

## Commands worth showing

```bash
# What's registered on iii right now
~/.local/bin/iii trigger engine::functions::list

# Same data as the dashboard, but in your terminal
node packages/cli/dist/bin.js traces --flat --replay

# Agent-filtered logs
node packages/cli/dist/bin.js logs --agent sre.triage

# Direct invoke (skip the trigger layer)
node packages/cli/dist/bin.js invoke sre.triage \
  --payload '{"service":"db","msg":"connection pool exhausted"}'

# Spans in Postgres
docker exec rohit-postgres-1 psql -U snoopy -d snoopy \
  -c "SELECT agent_id, event, ts FROM snoopy_spans ORDER BY id DESC LIMIT 10"
```

## If something looks weird

| Symptom | Likely cause / fix |
|---|---|
| Dashboard says "offline" | Worker died, restart with `npx tsx run-with-postgres-trace.ts` |
| Run stuck at "running…" | OpenAI is slow — wait. The dashboard polls every 2s. |
| `OpenAI API error 401` | Update `$OPENAI_API_KEY` and restart the worker |
| `kubectl: connection refused` in the output | Expected — the demo doesn't have a real K8s cluster. The agent handles it gracefully and produces a severity classification anyway. |
| `iii trigger: ...: timeout` | First call sometimes takes longer; bump `--timeout-ms 180000` |

## Cleanup

```bash
# Kill background processes
kill $(cat /tmp/iii.pid /tmp/worker.pid /tmp/dash.pid 2>/dev/null) 2>/dev/null
docker compose down
```
