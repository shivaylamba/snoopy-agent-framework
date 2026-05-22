# snoopy

**A lean agent framework on iii.dev.** Not a runtime, not a wrapper — just the agent-specific glue you'd write on top of [iii](https://iii.dev) anyway.

## Mental model

```
your code                                 ── agents you define
─────────────────────                     ───────────────────────────
@snoopy/core              ← agent glue   defineAgent / Session / MCP / dashboard
─────────────────────                     ───────────────────────────
iii ecosystem workers     ← `iii worker add iii-state / iii-sandbox /
                              iii-observability / provider-openai /
                              auth-credentials / turn-orchestrator / …`
─────────────────────                     ───────────────────────────
iii engine                ← workers, functions, triggers, state, streams,
                              queues, cron, OTel — the actual runtime
```

The iii.dev founder's feedback (paraphrased):
> Wrapping iii primitives isn't required. State, sandbox, observability, providers, and credentials are all already ecosystem workers — install them with `iii worker add <name>`. Agent frameworks should add agent-specific value on top, not re-wrap what iii already provides.

That's the architecture this repo is now organized around. See `docs/ARCHITECTURE.md`.

## What snoopy actually contributes (the agent-specific glue)

| Concern | iii primitives / workers | snoopy adds |
|---|---|---|
| Workers + functions + triggers | ✅ built-in | — |
| State KV | ✅ `iii worker add iii-state` | — (use directly) |
| Sandbox | ✅ `iii worker add iii-sandbox` | — (use directly) |
| Observability | ✅ `iii worker add iii-observability` | Embedded dashboard UI on top |
| Cron | ✅ `iii worker add iii-cron` | `defineAgent({schedule: "…"})` shorthand |
| Queues / streams / pubsub | ✅ built-in workers | — |
| LLM provider | ✅ `iii worker add provider-openai` / `provider-anthropic` | Direct-fetch fallback for users who haven't installed the worker |
| Credentials | ✅ `iii worker add auth-credentials` | — |
| Turn orchestration | ✅ `iii worker add turn-orchestrator` | snoopy's own reasoning loop (alternative) |
| **Reasoning loop, structured Zod-validated output, skill markdown, MCP server export, dashboard, dedupe, Session abstraction** | ❌ | ✅ this is snoopy's actual job |

## Quick start

```bash
pnpm install && pnpm build
cd packages/examples-sre
export OPENAI_API_KEY=sk-...
npx agent dev
```

That's it. `agent dev` downloads the iii engine binary on first run (cached to `~/.snoopy/iii`), starts it, registers your agents, and tails the trace stream — single command, single terminal.

Fire an agent from another terminal:

```bash
iii trigger sre.triage --json '{"service":"payments","msg":"5xx spike"}'
# or via HTTP webhook
curl -X POST http://localhost:3111/triggers/webhook/alerts/pagerduty \
     -d '{"service":"payments","msg":"5xx spike"}'
```

Open the dashboard:

```bash
open http://localhost:3210
```

### Deploying (production)

```bash
# Bundle iii + worker into a single Docker image
agent deploy --target docker

# Or scaffold a Fly.io deploy
agent deploy --target fly
fly launch --no-deploy && fly secrets set OPENAI_API_KEY=… && fly deploy
```

Each `--target` generates a `Dockerfile` that **bundles the iii engine** alongside your worker so there's no separate infra to provision. See `docs/DEPLOY.md`.

### Power-user knobs

The auto-managed iii engine and ecosystem workers Just Work for the common case. If you need a real `iii-config.yaml` (e.g. Postgres-backed state), drop it next to `snoopy.config.ts` and `agent dev` will pick it up. To run against an already-running engine, `agent dev --no-iii`. To diagnose anything that's off:

```bash
agent doctor
```

## Writing an agent

```ts
import { defineAgent, defineTool, defineTrigger } from "@snoopy/core";
import { z } from "zod";
import { kubectl, prometheus } from "../tools";

const Result = z.object({ severity: z.enum(["sev1", "sev2", "sev3"]) });

export const triage = defineAgent({
  id: "sre.triage",
  tools: [kubectl, prometheus],
  triggers: [defineTrigger.webhook({ path: "/alerts" })],
  result: Result,
  handler: async (alert, ctx) => {
    return ctx.session.prompt(`triage: ${alert.msg}`, { result: Result });
  },
});
```

Need to talk to iii directly? `ctx.iii` **is** the `iii-sdk` client — same
instance you'd get from `registerWorker(III_WS_URL)`. No wrapper, no sugar
layer; call the iii primitive you want:

```ts
// state — direct iii primitive
await ctx.iii.trigger({
  function_id: "state::set",
  payload: { scope: "incidents", key: "inc_42", value: { status: "open" } },
});

// sandboxed exec — direct iii primitive
await ctx.iii.trigger({
  function_id: "sandbox::exec",
  payload: { command: ["kubectl", "get", "pods"] },
});

// fan out to another agent — same primitive, different function_id
await ctx.iii.trigger({ function_id: "sre.investigator", payload: { … } });
```

That's the whole surface for distributed coordination. snoopy does not
provide `ctx.call`, `ctx.spawn`, or `session.task` — those would just wrap
`iii.trigger` and add nothing.

## Packages

| Package | What |
|---|---|
| `@snoopy/core` | `defineAgent`, `defineTool`, `defineTrigger`, `Session`, MCP server export, dashboard, dedupe, role/skill discovery. ~2,500 LOC. |
| `@snoopy/cli` | `agent` binary: `init`, `dev`, `deploy`, `traces`, `invoke`, `logs`, `doctor`. |
| `@snoopy/llm-pi-ai` | **Optional**: `PiAiProvider` adapter — 30+ LLM providers via pi-ai. |
| `@snoopy/memory-weaviate` | **Optional**: `WeaviateVectorStore` for semantic memory. |
| `@snoopy/examples-sre` | SRE/DevOps demo — triage, investigator, fixer. |
| `@snoopy/examples-content-team` | Port of [Arindam200/awesome-ai-apps content_team_agent](https://github.com/Arindam200/awesome-ai-apps/tree/main/advance_ai_agents/content_team_agent). |
| `python/snoopy` | **Optional**: Python SDK — same iii engine, cross-language interop. |

## Tests

```bash
pnpm --filter @snoopy/core test          # 19/19 unit tests
node packages/examples-sre/e2e-full.mjs  # 30/30 end-to-end (real LLM)
```

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — three-layer model + the founder's feedback applied
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — `agent deploy --target <docker|fly|node>` bundled artifacts
- [`docs/DEMO.md`](docs/DEMO.md) — live demo runbook
- [`docs/RUN_E2E.md`](docs/RUN_E2E.md) — end-to-end test instructions
- [`docs/SRE_DEMO.md`](docs/SRE_DEMO.md) — SRE example walkthrough
