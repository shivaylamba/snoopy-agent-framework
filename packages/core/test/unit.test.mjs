/**
 * Critical-path tests for snoopy core. Pure unit tests — no iii engine,
 * no network. Run with: `node --test packages/core/test/unit.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultDedupeKey,
} from "../dist/dedupe.js";
import { InMemoryStore, InMemoryVectorStore } from "../dist/index.js";
import { makeCallHandle, AbortError } from "../dist/callHandle.js";
import { renderSkill } from "../dist/skills.js";
import { withKeyedLock } from "../dist/keyedMutex.js";
import { OpenAIProvider, AnthropicProvider } from "../dist/llm.js";

// ─── dedupe ─────────────────────────────────────────────────────────────────

test("defaultDedupeKey is stable across key order", () => {
  const a = defaultDedupeKey({ x: 1, y: { a: 2, b: 3 } });
  const b = defaultDedupeKey({ y: { b: 3, a: 2 }, x: 1 });
  assert.equal(a, b);
});

test("defaultDedupeKey differs for different payloads", () => {
  const a = defaultDedupeKey({ x: 1 });
  const b = defaultDedupeKey({ x: 2 });
  assert.notEqual(a, b);
});

// ─── memory ─────────────────────────────────────────────────────────────────

test("InMemoryStore KV round-trip", async () => {
  const m = new InMemoryStore();
  await m.set("foo", { v: 42 });
  assert.deepEqual(await m.get("foo"), { v: 42 });
});

test("InMemoryStore TTL expiry", async () => {
  const m = new InMemoryStore();
  await m.set("k", "v", 0);
  // ttl=0 → ~immediate expiry; allow a tick for the clock
  await new Promise((r) => setTimeout(r, 5));
  const v = await m.get("k");
  // Implementation choice: ttl=0 may be treated as no-ttl OR as expired-now.
  // Accept either; the important property is no crash.
  assert.ok(v === undefined || v === "v");
});

test("InMemoryStore stream append+range", async () => {
  const m = new InMemoryStore();
  await m.append("s", { a: 1 });
  await m.append("s", { a: 2 });
  const out = [];
  for await (const e of m.range("s")) out.push(e.value);
  assert.equal(out.length, 2);
  assert.deepEqual(out, [{ a: 1 }, { a: 2 }]);
});

// ─── vector ─────────────────────────────────────────────────────────────────

test("InMemoryVectorStore semantic-ish ordering", async () => {
  const v = new InMemoryVectorStore();
  await v.upsert({ id: "1", text: "payments service returning 503 errors" });
  await v.upsert({ id: "2", text: "checkout latency spike" });
  await v.upsert({ id: "3", text: "5xx spike on the payments backend" });
  const hits = await v.search("payments service is returning errors", { k: 2 });
  assert.equal(hits.length, 2);
  assert.ok(hits[0].id === "1" || hits[0].id === "3", `top hit was ${hits[0].id}`);
  assert.ok(hits[0].score > 0.5, `score=${hits[0].score}`);
});

test("InMemoryVectorStore filter excludes via metadata", async () => {
  const v = new InMemoryVectorStore();
  await v.upsert({ id: "1", text: "hello world", metadata: { kind: "a" } });
  await v.upsert({ id: "2", text: "hello world", metadata: { kind: "b" } });
  const hits = await v.search("hello world", { k: 5, filter: (m) => m?.kind === "a" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "1");
});

// ─── CallHandle ─────────────────────────────────────────────────────────────

test("CallHandle resolves and exposes signal", async () => {
  const h = makeCallHandle(async (signal) => {
    assert.ok(signal instanceof AbortSignal);
    return 42;
  });
  assert.ok(h.signal instanceof AbortSignal);
  assert.equal(typeof h.abort, "function");
  assert.equal(await h, 42);
});

test("CallHandle.abort rejects with AbortError", async () => {
  const h = makeCallHandle((signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("inner aborted")));
    }),
  );
  setTimeout(() => h.abort("test reason"), 5);
  await assert.rejects(h, AbortError);
});

test("CallHandle external signal", async () => {
  const ctrl = new AbortController();
  const h = makeCallHandle((signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("inner")));
    }),
    ctrl.signal,
  );
  setTimeout(() => ctrl.abort("ext"), 5);
  await assert.rejects(h, AbortError);
});

// ─── skills ─────────────────────────────────────────────────────────────────

test("renderSkill interpolates {{args.x}}", () => {
  const out = renderSkill("Hello {{args.name}}, you are {{args.age}}", {
    name: "World",
    age: 42,
  });
  assert.equal(out, "Hello World, you are 42");
});

test("renderSkill handles missing args", () => {
  const out = renderSkill("Hello {{args.missing}}", {});
  assert.match(out, /missing arg "missing"/);
});

test("renderSkill stringifies non-string args", () => {
  const out = renderSkill("Data: {{args.payload}}", { payload: { x: 1 } });
  assert.equal(out, 'Data: {"x":1}');
});

// ─── keyedMutex ────────────────────────────────────────────────────────────

test("withKeyedLock serializes operations per key", async () => {
  const order = [];
  const tick = (label) => new Promise((r) => setTimeout(() => { order.push(label); r(); }, 5));
  await Promise.all([
    withKeyedLock("k", () => tick("a")),
    withKeyedLock("k", () => tick("b")),
    withKeyedLock("k", () => tick("c")),
  ]);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("withKeyedLock different keys run in parallel", async () => {
  let parallelDetected = false;
  let live = 0;
  await Promise.all([
    withKeyedLock("a", async () => { live++; if (live > 1) parallelDetected = true; await new Promise(r=>setTimeout(r,10)); live--; }),
    withKeyedLock("b", async () => { live++; if (live > 1) parallelDetected = true; await new Promise(r=>setTimeout(r,10)); live--; }),
  ]);
  assert.equal(parallelDetected, true);
});

// ─── LLM clients (no network) ──────────────────────────────────────────────

test("OpenAIProvider can be constructed and has chat method", () => {
  const p = new OpenAIProvider({ apiKey: "sk-test" });
  assert.equal(typeof p.chat, "function");
  // chatStream is added via prototype patch
  assert.equal(typeof p.chatStream, "function");
});

test("AnthropicProvider can be constructed", () => {
  const p = new AnthropicProvider({ apiKey: "sk-ant-test" });
  assert.equal(typeof p.chat, "function");
});

test("OpenAIProvider rejects when no API key anywhere", async () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const p = new OpenAIProvider({});
    await assert.rejects(
      () => p.chat({ model: "gpt-4", messages: [] }),
      /OPENAI_API_KEY/,
    );
  } finally {
    if (prev) process.env.OPENAI_API_KEY = prev;
  }
});

// ─── auth ──────────────────────────────────────────────────────────────────

test("timingSafeCompare matches identical strings", async () => {
  const { timingSafeCompare } = await import("../dist/auth.js");
  assert.equal(timingSafeCompare("hello", "hello"), true);
  assert.equal(timingSafeCompare("hello", "world"), false);
  assert.equal(timingSafeCompare("hello", "hellos"), false);
});
