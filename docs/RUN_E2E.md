# Running snoopy end-to-end locally

This is the complete checklist. Follow it once and you have the full stack running: iii engine + Redis + Postgres + your snoopy worker registering agents + the SRE demo firing on a webhook + traces flowing into the embedded dashboard.

## What you need from your side

| Thing | Why | How |
|---|---|---|
| **`iii` binary** | The distributed runtime. Not on npm or Docker Hub — installs as a native binary via curl. | `curl -fsSL https://iii.dev/install.sh \| sh` |
| **`OPENAI_API_KEY`** | The default model is `openai/gpt-5-mini`. pi-ai reads this env var. | Already set on your machine ✓ |
| **Docker + Compose** | For Redis (memory backend) and Postgres (trace store). | Already installed ✓ |
| **Node ≥ 20, pnpm ≥ 8** | The framework runtime. | Already installed ✓ |

That's it. No accounts to create, no cloud services needed, no API keys beyond OpenAI.

## Already verified for you

Running `bash scripts/preflight.sh` confirms: 11 of 12 checks already pass. The only missing piece is the `iii` binary.

Past that, the e2e test suite (run earlier) confirmed **17/17 assertions pass** across:
- Memory KV + streams (in-memory + Redis)
- Vector memory (in-memory cosine)
- Postgres trace store (schema auto-create, record, list, getByRun)
- Traces HTTP server (`/`, `/traces`, `/traces/:runId`, `/health`)
- Embedded dashboard HTML serves
- Dedupe hash stability
- Flue-shim skill/role discovery
- Python SDK imports and async memory

## Run the full stack — step by step

### 1. Install iii (one time)

```bash
curl -fsSL https://iii.dev/install.sh | sh
iii --version   # verify
```

### 2. Boot infrastructure

```bash
cd /Users/shivaylamba/Downloads/weaviate-olostep/rohit
docker compose up -d         # redis + postgres
bash scripts/preflight.sh    # should now show 12 pass, 0 fail
```

### 3. Start the iii engine in its own terminal

```bash
# In a fresh terminal:
cd /tmp && iii project init snoopy-engine --template quickstart
cd snoopy-engine
iii --config config.yaml
```

This blocks. You should see something like `engine listening on ws://localhost:49134`.

### 4. Start your worker

In another terminal:

```bash
cd /Users/shivaylamba/Downloads/weaviate-olostep/rohit
pnpm install
pnpm build

cd packages/examples-sre
pnpm dev
```

This:
- Imports `snoopy.config.ts` (which imports each agent file)
- Each `defineAgent({...})` registers a function + triggers on iii
- Starts watching files for hot-reload
- Tails the trace stream to stdout

Expected output:
```
→ Loading /…/snoopy.config.ts
✓ iii engine ready
✓ Agents registered
Tailing snoopy.trace from redis…
```

### 5. Optionally start the dashboard

In a third terminal:

```bash
cd /Users/shivaylamba/Downloads/weaviate-olostep/rohit/packages/examples-sre
node -e "
const { PgTraceStore, startTracesServer, addTraceSink } =
  await import('@snoopy/core');
const pg = new PgTraceStore();
addTraceSink(pg);
startTracesServer({ store: pg, port: 3210 });
console.log('dashboard at http://localhost:3210');
await new Promise(() => {});
"
```

Open http://localhost:3210 in a browser — you'll see the agents sidebar and live-updating run trees as you fire triggers.

### 6. Fire a real test invocation

```bash
# Direct synchronous invoke (easiest):
agent invoke sre.triage --payload '{"service":"payments","msg":"5xx spike"}'

# Or via the actual webhook trigger registered on iii:
curl -X POST http://localhost:3113/api/triggers/webhook/alerts/pagerduty \
  -H 'content-type: application/json' \
  -d '{"service":"payments","msg":"5xx spike"}'
```

Both will:
1. Hit your worker via iii's WebSocket
2. Build a FlueContext, init the harness, open a session named after the runId
3. Send the prompt to OpenAI (`gpt-5-mini`) via pi-ai
4. Run any tool calls the model requests
5. Parse the structured result against the Zod schema
6. Emit spans to stdout, Redis, OTel, and Postgres
7. Persist the session for retry resume
8. Cache the result under a dedupe key

### 7. Watch traces

```bash
agent traces                          # live tree
agent traces --run <runId>            # single run
agent traces --flat                   # flat chronological
agent logs --agent sre.triage         # prose log tail
```

Or via HTTP:
```bash
curl http://localhost:3210/traces?agent=sre.triage&limit=20 | jq
curl http://localhost:3210/traces/<runId> | jq
```

Or visually: http://localhost:3210/

## Testing the Python SDK

In a fresh terminal:

```bash
cd /Users/shivaylamba/Downloads/weaviate-olostep/rohit/python
pip install -e .

# Write a python agent
cat > demo.py <<'EOF'
import asyncio, os
from snoopy import define_agent, define_trigger, start_worker

@define_agent(
    id="research.echo",
    triggers=[define_trigger.http(path="/echo")],
)
async def echo(payload, ctx):
    # In real code: call OpenAI / Anthropic / whatever here.
    ctx.emit("echoed", {"len": len(str(payload))})
    return {"echoed": payload}

if __name__ == "__main__":
    asyncio.run(start_worker())
EOF

python3 demo.py
```

Then in another terminal, call the Python-registered agent (works identically to TS):
```bash
agent invoke research.echo --payload '{"hello":"world"}'
```

## What to expect on cost

The SRE demo prompt + tool calls is ~3-5K tokens. With `gpt-5-mini` at current rates, one full triage run costs around **\$0.001 – \$0.005**. Dedupe (default 5-min TTL on payload hash) prevents duplicate spend on repeated identical webhooks.

If you want zero LLM spend during smoke testing, set `SNOOPY_TRACE_STDOUT=true` and use the `agent invoke` command — but the harness will still make the OpenAI call when prompted. To truly skip the LLM, swap the model with a mock by setting `model: "openai/..."` to a non-existent string and catching the error inside the agent's `prompt` builder for the testing path.

## When to use what

| Use case | Command |
|---|---|
| Iterate on agent code | `pnpm dev` in `examples-sre/` (hot-reload) |
| Test a payload locally | `agent invoke sre.triage --payload '{...}'` |
| Tail live activity | `agent traces` |
| Replay history | `agent traces --replay` |
| Visual exploration | `http://localhost:3210/` |
| Ship to a remote engine | `agent deploy --engine ws://prod:49134` |
| Ship as a Docker image | `agent deploy --build --registry ghcr.io/me --image snoopy-sre` |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `iii: command not found` | Step 1 — run the curl installer |
| `iii engine not reachable on :49134` | Step 3 — start the engine in its own terminal |
| `ECONNREFUSED 127.0.0.1:6379` | `docker compose up -d` |
| `ECONNREFUSED 127.0.0.1:5432` | `docker compose up -d` |
| Agent doesn't appear in traces | Check the `agent dev` console for "Agents registered" |
| Webhook 404 | iii's HTTP path format is `/api/triggers/webhook/<path>` — note the `/api/` prefix |
| 401 from OpenAI | `echo $OPENAI_API_KEY` — confirm it's exported in the worker shell |

## What you can confirm I tested

Run:
```bash
cd /Users/shivaylamba/Downloads/weaviate-olostep/rohit/packages/examples-sre
node e2e-test.mjs
```

You should see `17/17 passed`. That covers Memory, VectorMemory, PgTraceStore, the traces HTTP server, dashboard HTML serving, dedupe hashing, flue-shim exports, and skill discovery — all the framework primitives that don't require iii to be running.

The remaining "needs iii" path is: iii install → start engine → run worker → fire trigger → see real OpenAI call → see span in dashboard. Each of those is a single step in the runbook above.
