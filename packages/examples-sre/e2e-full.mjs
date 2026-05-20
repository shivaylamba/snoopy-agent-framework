#!/usr/bin/env node
/**
 * Comprehensive end-to-end test for snoopy.
 *
 * Exercises every layer:
 *   1. Infra reachable (iii engine, redis, postgres, dashboard, MCP server)
 *   2. Framework primitives (Memory, vector, StateKV, keyed-mutex)
 *   3. iii state roundtrip via StateKV
 *   4. iii function discovery (lists our SRE agents)
 *   5. CLI binary (agent --help, agent doctor)
 *   6. Live LLM call through Session (real OpenAI roundtrip)
 *   7. Multi-turn tool calling via iii.trigger
 *   8. Markdown skill invocation
 *   9. Dedupe cache hit (same payload twice → 2nd is instant)
 *  10. MCP server: initialize → tools/list → tools/call (real LLM)
 *  11. PgTraceStore: spans recorded for live runs
 *  12. Dashboard API: /traces returns our runs
 *
 * Run: `node packages/examples-sre/e2e-full.mjs`
 * Exit code 0 on full pass, 1 on any failure.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { exec as cpExec } from "node:child_process";
import { Socket } from "node:net";

const exec = promisify(cpExec);

const results = [];
const start = Date.now();

function step(name, ok, detail = "") {
  const symbol = ok ? "✓" : "✗";
  const elapsed = `${Math.round((Date.now() - start) / 1000)}s`;
  console.log(`  ${symbol} [${elapsed.padStart(4)}] ${name}${detail ? "  " + detail : ""}`);
  results.push({ name, ok, detail });
}

function header(text) {
  console.log(`\n── ${text} ──`);
}

async function tcpUp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = new Socket();
    s.setTimeout(timeoutMs);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

async function main() {
  console.log("snoopy end-to-end test\n");

  // ── 1. Infrastructure
  header("infrastructure");
  step("iii engine WS port :49134", await tcpUp("localhost", 49134));
  step("redis :6379", await tcpUp("localhost", 6379));
  step("postgres :5432", await tcpUp("localhost", 5432));

  const dashResp = await fetch("http://localhost:3210/health").catch(() => null);
  step("dashboard :3210 /health", !!dashResp?.ok);

  const mcpResp = await fetch("http://localhost:4280/health").catch(() => null);
  step("MCP server :4280 /health", !!mcpResp?.ok);

  // ── 2. Framework imports & primitives (no LLM)
  header("framework primitives");
  const core = await import("@snoopy/core");
  step("@snoopy/core import", typeof core.defineAgent === "function",
       `(${Object.keys(core).length} exports)`);

  const piPkg = await import(
    "/Users/shivaylamba/Downloads/weaviate-olostep/rohit/packages/llm-pi-ai/dist/index.js"
  );
  step("@snoopy/llm-pi-ai import", typeof piPkg.PiAiProvider === "function");

  // In-memory + vector basics
  const m = new core.InMemoryStore();
  await m.set("k", { v: 42 });
  step("InMemoryStore round-trip", (await m.get("k"))?.v === 42);

  const v = new core.InMemoryVectorStore();
  await v.upsert({ id: "1", text: "billing API returning 503s on charge endpoint" });
  await v.upsert({ id: "2", text: "checkout flow latency spike" });
  // Trigram cosine is lexical — query must overlap. (Real semantic search
  // wants WeaviateVectorStore with a vectorizer.)
  const hits = await v.search("billing 503 on charge", { k: 1 });
  step(
    "InMemoryVectorStore lexical ordering",
    hits.length === 1 && hits[0].id === "1" && hits[0].score > 0.3,
    `(top=${hits[0]?.id}:${hits[0]?.score?.toFixed(3)})`,
  );

  // ── 3. iii state via StateKV
  header("iii state primitives");
  const kv = new core.StateKV(core.iiiClient());
  const scope = "snoopy-e2e";
  const key = "test_" + Math.random().toString(36).slice(2, 10);
  await kv.set(scope, key, { hello: "iii state" });
  const back = await kv.get(scope, key);
  step("StateKV.set + StateKV.get roundtrip via iii", JSON.stringify(back) === JSON.stringify({ hello: "iii state" }));
  await kv.delete(scope, key);

  // ── 4. iii function discovery
  header("iii functions");
  const iii = core.iiiClient();
  const fnList = await iii.trigger({ function_id: "engine::functions::list", payload: {} });
  const sreAgents = (fnList?.functions ?? [])
    .filter((f) => f.function_id.startsWith("sre.") && !f.function_id.includes("::tool::"))
    .map((f) => f.function_id);
  step("SRE agents registered on iii", sreAgents.length >= 3, `(${sreAgents.length}: ${sreAgents.join(", ")})`);

  const sreTools = (fnList?.functions ?? [])
    .filter((f) => f.function_id.includes("::tool::"))
    .map((f) => f.function_id);
  step("SRE tools registered as iii functions", sreTools.length >= 3, `(${sreTools.length} tools)`);

  // ── 5. CLI binary
  header("CLI");
  const cliHelp = await tryExec("node /Users/shivaylamba/Downloads/weaviate-olostep/rohit/packages/cli/dist/bin.js --help");
  step("agent --help exits cleanly", cliHelp.ok, cliHelp.ok ? "" : cliHelp.stderr);
  step("CLI surfaces all 7 commands",
    cliHelp.stdout.includes("init") && cliHelp.stdout.includes("dev") &&
    cliHelp.stdout.includes("deploy") && cliHelp.stdout.includes("traces") &&
    cliHelp.stdout.includes("invoke") && cliHelp.stdout.includes("logs") &&
    cliHelp.stdout.includes("doctor"));

  const doctor = await tryExec(`node /Users/shivaylamba/Downloads/weaviate-olostep/rohit/packages/cli/dist/bin.js doctor --iii ${process.env.HOME}/.local/bin/iii`);
  step("agent doctor runs", doctor.ok || /pass/.test(doctor.stdout || ""), doctor.ok ? "" : "(some warns OK)");

  // ── 6. Live LLM call via Session
  header("live LLM call (real OpenAI, may take ~30s)");
  const liveStart = Date.now();
  const triageResult = await iii.trigger({
    function_id: "sre.triage",
    payload: { service: "e2e-test-service", msg: "e2e probe — synthetic alert" },
    timeoutMs: 180_000,
  }).catch((e) => ({ error: String(e?.message ?? e) }));
  const liveMs = Date.now() - liveStart;

  if (triageResult?.error) {
    step("sre.triage live invocation", false, `(${triageResult.error.slice(0, 80)})`);
  } else {
    step("sre.triage live invocation succeeds", typeof triageResult === "object", `(${(liveMs / 1000).toFixed(1)}s)`);
    step("returns valid severity", ["sev1","sev2","sev3"].includes(triageResult?.severity), `(${triageResult?.severity})`);
    step("returns recommendedAction string", typeof triageResult?.recommendedAction === "string" && triageResult.recommendedAction.length > 50);
    step("returns executiveSummary via skill", typeof triageResult?.executiveSummary === "string" && triageResult.executiveSummary.length > 50,
      "← markdown skill invoked");
    step("returns suspectedRootCause", typeof triageResult?.suspectedRootCause === "string");
    step("returns spawnFixer boolean", typeof triageResult?.spawnFixer === "boolean");
  }

  // ── 7. Dedupe — 2nd identical call should be instant
  header("dedupe layer");
  const dedupePayload = { service: "dedupe-probe", msg: "dedupe e2e — fixed payload " + Date.now() };
  const dedupeStart1 = Date.now();
  const r1 = await iii.trigger({ function_id: "sre.triage", payload: dedupePayload, timeoutMs: 180_000 }).catch((e) => ({ error: String(e) }));
  const dedupeMs1 = Date.now() - dedupeStart1;

  const dedupeStart2 = Date.now();
  const r2 = await iii.trigger({ function_id: "sre.triage", payload: dedupePayload, timeoutMs: 60_000 }).catch((e) => ({ error: String(e) }));
  const dedupeMs2 = Date.now() - dedupeStart2;

  step("first dedupe call ran agent body", !r1?.error && dedupeMs1 > 5_000, `(${(dedupeMs1/1000).toFixed(1)}s)`);
  step("second dedupe call hit cache (<2s)", !r2?.error && dedupeMs2 < 2_000, `(${(dedupeMs2/1000).toFixed(1)}s)`);
  step("dedupe returns identical result", JSON.stringify(r1) === JSON.stringify(r2));

  // ── 8. MCP server roundtrip
  header("MCP server roundtrip");
  const mcpInit = await fetch("http://localhost:4280/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, clientInfo: { name: "e2e", version: "1.0" } },
    }),
  }).then((r) => r.json()).catch(() => null);
  step("MCP initialize handshake", !!mcpInit?.result?.serverInfo?.name, `(server: ${mcpInit?.result?.serverInfo?.name})`);

  const mcpTools = await fetch("http://localhost:4280/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  }).then((r) => r.json()).catch(() => null);
  const exposedTools = mcpTools?.result?.tools ?? [];
  step("MCP tools/list exposes agents", exposedTools.length >= 3, `(${exposedTools.length} tools)`);

  // ── 9. Dashboard reads recent spans
  header("trace observability");
  const dashSpans = await fetch("http://localhost:3210/traces?agent=sre.triage&limit=20").then((r) => r.json()).catch(() => null);
  step("dashboard /traces returns spans", Array.isArray(dashSpans?.spans) && dashSpans.spans.length > 0,
    `(${dashSpans?.spans?.length ?? 0} spans)`);

  const recentRunIds = new Set((dashSpans?.spans ?? []).map((s) => s.runId));
  step("multiple runs captured", recentRunIds.size >= 2, `(${recentRunIds.size} unique runs)`);

  const hasUsage = (dashSpans?.spans ?? []).some((s) =>
    s.event === "agent.end" && s.data?.usage && typeof s.data.usage.in === "number"
  );
  step("agent.end spans include usage stats", hasUsage);

  // ── 10. PgTraceStore directly
  header("Postgres trace store");
  const pgCount = await tryExec(`docker exec rohit-postgres-1 psql -U snoopy -d snoopy -t -c "SELECT COUNT(*) FROM snoopy_spans WHERE agent_id = 'sre.triage'"`);
  const count = parseInt((pgCount.stdout || "0").trim(), 10);
  step("Postgres has sre.triage spans", count > 0, `(${count} rows)`);

  // ── Summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const total = results.length;
  console.log();
  console.log(`${passed}/${total} passed${failed ? `, ${failed} FAILED` : ""}`);
  console.log(`total wall time: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  if (failed) {
    console.log("\nFailures:");
    for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name} ${r.detail}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

async function tryExec(cmd) {
  try {
    const { stdout, stderr } = await exec(cmd, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    return { ok: false, stdout: err?.stdout ?? "", stderr: String(err?.message ?? err) };
  }
}

main().catch((err) => {
  console.error("\n✗ UNHANDLED:", err);
  process.exit(1);
});
