#!/usr/bin/env node
/**
 * End-to-end smoke tests for everything that doesn't require the iii
 * engine. Exercises: Memory (in-memory + Redis), VectorMemory, PgTraceStore,
 * traces HTTP server + dashboard, dedupe hashing, Flue shim discovery,
 * harness factory (without going as far as a real LLM call).
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const RESULTS = [];
function step(name, ok, info = "") {
  const symbol = ok ? "✓" : "✗";
  console.log(`${symbol} ${name}${info ? "  " + info : ""}`);
  RESULTS.push({ name, ok, info });
}

async function main() {
  // 1. @snoopy/core import
  const core = await import("@snoopy/core");
  step("import @snoopy/core",
       typeof core.defineAgent === "function" &&
       typeof core.defineTool === "function" &&
       typeof core.defineTrigger === "object",
       `(${Object.keys(core).length} exports)`);

  // 2. In-memory Memory
  const memMod = await import("@snoopy/core");
  const mem = new memMod.InMemoryStore();
  await mem.set("k1", { v: 1 });
  const got = await mem.get("k1");
  step("InMemoryStore KV round-trip", got?.v === 1);

  await mem.append("s1", { a: 1 });
  await mem.append("s1", { a: 2 });
  const collected = [];
  for await (const e of mem.range("s1")) collected.push(e.value);
  step("InMemoryStore stream range", collected.length === 2 && collected[0].a === 1);

  // 3. Redis Memory
  const r = new memMod.RedisStore({ url: "redis://localhost:6379", prefix: "snoopy_test:" });
  // Clean slate
  await r.delete("test:k1");
  await r.set("test:k1", { v: "hello" }, 60);
  const rGot = await r.get("test:k1");
  step("RedisStore KV round-trip", rGot?.v === "hello");

  const sid = await r.append("test:stream", { msg: "first" });
  step("RedisStore stream append returned id", typeof sid === "string" && sid.length > 0);
  await r.append("test:stream", { msg: "second" });

  const rangeOut = [];
  for await (const e of r.range("test:stream")) {
    rangeOut.push(e.value);
    if (rangeOut.length >= 2) break;
  }
  step("RedisStore stream range",
       rangeOut.length === 2 && rangeOut[0].msg === "first" && rangeOut[1].msg === "second");

  // 4. Vector store
  const vec = new memMod.InMemoryVectorStore();
  await vec.upsert({ id: "1", text: "payments service returning 503 errors" });
  await vec.upsert({ id: "2", text: "checkout latency spike" });
  await vec.upsert({ id: "3", text: "5xx spike on the payments backend" });
  const hits = await vec.search("payments service is returning errors", { k: 2 });
  step("InMemoryVectorStore semantic-ish ordering",
       hits.length === 2 && (hits[0].id === "1" || hits[0].id === "3"),
       `top=${hits[0]?.id}:${hits[0]?.score.toFixed(3)}`);

  // 5. PgTraceStore
  const pgMod = await import("@snoopy/core");
  const pg = new pgMod.PgTraceStore({
    connectionString: "postgres://snoopy:snoopy@localhost:5432/snoopy",
  });
  const runId = "test_run_" + Math.random().toString(36).slice(2, 10);
  await pg.record({
    agentId: "test.agent", runId, event: "agent.start",
    data: { hello: "world" }, ts: Date.now(),
  });
  await pg.record({
    agentId: "test.agent", runId, event: "agent.end",
    data: { result: 42 }, ts: Date.now() + 100,
  });
  const events = await pg.getByRun(runId);
  step("PgTraceStore record + getByRun",
       events.length === 2 && events[0].event === "agent.start",
       `(${events.length} events)`);

  const recent = await pg.list({ agent: "test.agent", limit: 5 });
  step("PgTraceStore list",
       recent.length >= 2,
       `(${recent.length} recent)`);

  // 6. Traces HTTP server + dashboard
  const { startTracesServer } = pgMod;
  const server = startTracesServer({ store: pg, port: 0 }); // ephemeral port
  // server.close exists but @hono/node-server may not expose the bound port
  // through the returned handle in v1.13 — fall back to a known port.
  await sleep(200);
  const SERVER_PORT = 3211;
  const server2 = startTracesServer({ store: pg, port: SERVER_PORT });
  await sleep(300);

  try {
    const health = await fetch(`http://localhost:${SERVER_PORT}/health`);
    step("traces server /health", health.ok);

    const tracesRes = await fetch(`http://localhost:${SERVER_PORT}/traces?agent=test.agent`);
    const tracesBody = await tracesRes.json();
    step("traces server /traces returns array",
         Array.isArray(tracesBody.spans) && tracesBody.spans.length >= 2);

    const byRun = await fetch(`http://localhost:${SERVER_PORT}/traces/${runId}`);
    const byRunBody = await byRun.json();
    step("traces server /traces/:runId",
         byRunBody.runId === runId && byRunBody.spans?.length === 2);

    const dash = await fetch(`http://localhost:${SERVER_PORT}/`);
    const dashHtml = await dash.text();
    step("dashboard HTML serves",
         dash.ok &&
         dashHtml.includes("SNOOPY") &&
         dashHtml.includes("/traces"));

    const dashJson = await fetch(`http://localhost:${SERVER_PORT}/traces/does_not_exist`);
    step("traces 404 for missing run", dashJson.status === 404);
  } finally {
    server.close?.();
    server2.close?.();
  }

  // 7. Dedupe key stability (spot-check the algorithm — full behavior
  // is exercised through defineAgent, which needs iii to be running).
  const { createHash } = await import("node:crypto");
  const stableStringify = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
    return "{" + Object.keys(v).sort().map(k =>
      JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  };
  const dh1 = createHash("sha1").update(stableStringify({a:1,b:{c:2}})).digest("hex");
  const dh2 = createHash("sha1").update(stableStringify({b:{c:2},a:1})).digest("hex");
  step("stable dedupe key is order-independent", dh1 === dh2);

  // 8. flue-shim discovery
  const shimMod = await import("@snoopy/flue-shim");
  step("flue-shim exports",
       typeof shimMod.createHarness === "function" &&
       typeof shimMod.RedisSessionStore === "function");

  // 9. flue-shim role discovery from a tmp directory
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "snoopy-disc-"));
  await fs.mkdir(path.join(tmp, ".agents", "skills"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".agents", "skills", "demo.md"),
    "---\nname: demo\ndescription: a demo role\n---\nYou are a demo agent.\nBe friendly."
  );
  const disc = await shimMod.discoverRolesAndSkills(tmp);
  step("discovery picks up .agents/skills/*.md",
       !!disc.roles.demo && disc.roles.demo.instructions.includes("demo agent"),
       `(found role: ${disc.roles.demo?.name})`);

  // 10. Cleanup
  await r.delete("test:k1");
  await pg.close();

  // Summary
  console.log("");
  const passed = RESULTS.filter((r) => r.ok).length;
  const failed = RESULTS.filter((r) => !r.ok).length;
  console.log(`${passed}/${RESULTS.length} passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n✗ UNHANDLED ERROR:");
  console.error(err);
  process.exit(1);
});
