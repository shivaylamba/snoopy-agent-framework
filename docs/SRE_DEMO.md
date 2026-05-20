# SRE Demo Walkthrough

End-to-end test of every Phase 1 surface.

## Prereqs

- Docker running locally
- pnpm 9+
- `OPENAI_API_KEY` exported in the shell (default model is `openai/gpt-5-mini`). To switch providers, pass `model: 'anthropic/claude-sonnet-4-5'` (and set `ANTHROPIC_API_KEY`) — pi-ai supports anthropic, openai, google, deepseek, xai, groq, mistral, openrouter, and more.
- Optionally `kubectl` and a Prometheus URL in `PROMETHEUS_URL` for the tools to return real data — without them, the tools error out gracefully and the agent still runs

## Setup

```bash
pnpm install
pnpm build
```

## Run

```bash
cd packages/examples-sre
pnpm dev
```

This:

1. Runs `docker compose up -d` (iii engine, redis, postgres).
2. Waits for `http://localhost:3111/health` to respond.
3. Imports `snoopy.config.ts`, which imports each agent file. Each `defineAgent({...})` call registers a function + triggers on iii.
4. Subscribes to the `snoopy.trace` stream and prints events as they arrive.
5. Watches `agents/**/*.ts`, `tools/**/*.ts`, `snoopy.config.ts` for changes — re-registers on edit.

## Fire an alert

In another shell:

```bash
curl -X POST http://localhost:3111/triggers/webhook/alerts/pagerduty \
  -H 'content-type: application/json' \
  -d '{"service":"payments","msg":"5xx spike","severity":"high"}'
```

You should see, in the `agent dev` window:

```
[trace sre.triage 7f3a8b1c] agent.start    {"payload": {...}}
[trace sre.triage 7f3a8b1c] tool:kubectl   {"args": ["get","pods","-n","payments"]}
[trace sre.triage 7f3a8b1c] tool:prometheus_query
[trace sre.triage 7f3a8b1c] agent.spawn    {"child": "sre.investigator"}
[trace sre.investigator a1b2c3d4] agent.start
...
[trace sre.triage 7f3a8b1c] agent.end      {"result": {"severity": "sev2", ...}}
```

## Trace tree

```bash
agent traces --run 7f3a8b1c
```

Renders the full execution as a tree of agent + tool spans.

## Crash test (durability)

1. Fire the webhook.
2. While the agent is mid-loop, `pkill -9 node` to kill the worker.
3. Restart `agent dev`.
4. The next time the same invocation is replayed (or you fire the same payload with iii's retry replay), the wrapper finds `session:7f3a8b1c` in Redis and prints `agent.resumed { from: 'snapshot' }`.

Caveat: "resumed" here means the LLM context is restored — tool side effects are NOT replayed. See open question #9 in the plan.

## Acceptance criteria

Phase 1 ships when steps above all pass on a clean checkout on macOS and Linux.
