import kleur from "kleur";
import { TRACE_STREAM, type SpanEvent } from "@snoopy/core";
import { RedisStore } from "@snoopy/core";

interface TracesOpts {
  agent?: string;
  run?: string;
  /** Tree (parent-grouped) view vs. flat live tail. Defaults to tree. */
  flat?: boolean;
  /** Replay from beginning rather than tail latest only. */
  replay?: boolean;
}

const COLORS: Record<string, (s: string) => string> = {
  "agent.start": kleur.cyan,
  "agent.end": kleur.green,
  "agent.error": kleur.red,
  "agent.spawn": kleur.magenta,
  "agent.call": kleur.magenta,
  "agent.call.return": kleur.magenta,
  "agent.resumed": kleur.yellow,
  "agent.dedupe.hit": kleur.gray,
};

export async function tracesCommand(opts: TracesOpts) {
  const store = new RedisStore({ prefix: "snoopy:" });
  console.log(
    kleur.dim(
      `Tailing ${TRACE_STREAM} ${opts.replay ? "(from start)" : "(new entries)"}…`,
    ),
  );

  if (opts.flat) {
    return flatTail(store, opts);
  }
  return treeTail(store, opts);
}

/** Flat chronological view — every event on its own line. */
async function flatTail(store: RedisStore, opts: TracesOpts) {
  const from = opts.replay ? "0" : undefined;
  for await (const entry of store.tail(TRACE_STREAM, from)) {
    const span = entry.value as SpanEvent;
    if (opts.agent && span.agentId !== opts.agent) continue;
    if (opts.run && span.runId !== opts.run) continue;
    printFlat(span);
  }
}

/** Tree view — buckets events by runId and re-renders the tree on each new event. */
async function treeTail(store: RedisStore, opts: TracesOpts) {
  const runs = new Map<string, SpanEvent[]>();
  const order: string[] = [];
  const childrenOf = new Map<string, Set<string>>();

  const from = opts.replay ? "0" : undefined;
  for await (const entry of store.tail(TRACE_STREAM, from)) {
    const span = entry.value as SpanEvent;
    if (opts.agent && span.agentId !== opts.agent) continue;
    if (opts.run && span.runId !== opts.run) continue;

    if (!runs.has(span.runId)) {
      runs.set(span.runId, []);
      order.push(span.runId);
    }
    runs.get(span.runId)!.push(span);

    if (span.parentRunId) {
      const set = childrenOf.get(span.parentRunId) ?? new Set();
      set.add(span.runId);
      childrenOf.set(span.parentRunId, set);
    }

    // Track spawn/call events as parent → child edges (parentRunId isn't
    // populated on the child's own events yet; spawn span carries the link).
    if (span.event === "agent.spawn" || span.event === "agent.call") {
      const child = (span.data as any)?.child;
      if (typeof child === "string") {
        // We don't have child runId here (iii assigns it). We'll let the
        // child's events arrive and self-register via parentRunId.
      }
    }

    printTree(span, runs, childrenOf, order);
  }
}

function printFlat(ev: SpanEvent) {
  const color = COLORS[ev.event] ?? kleur.white;
  const runShort = ev.runId.slice(0, 8);
  const ts = new Date(ev.ts).toISOString().split("T")[1]?.slice(0, 12) ?? "";
  console.log(
    kleur.dim(ts),
    color(ev.event.padEnd(18)),
    kleur.bold(ev.agentId),
    kleur.dim(runShort),
    formatData(ev.data),
  );
}

function printTree(
  newest: SpanEvent,
  runs: Map<string, SpanEvent[]>,
  children: Map<string, Set<string>>,
  order: string[],
) {
  // Only re-render when an `agent.end` or `agent.error` arrives — otherwise
  // we'd spam the console for every tool call. For mid-run events, fall
  // back to the flat printer.
  if (newest.event !== "agent.end" && newest.event !== "agent.error") {
    printFlat(newest);
    return;
  }

  const events = runs.get(newest.runId);
  if (!events) return;

  const start = events.find((e) => e.event === "agent.start");
  const durationMs = start ? newest.ts - start.ts : undefined;
  const status = newest.event === "agent.end" ? kleur.green("✓") : kleur.red("✗");
  const ts = new Date(newest.ts).toISOString().split("T")[1]?.slice(0, 12) ?? "";

  console.log();
  console.log(
    kleur.dim(ts),
    status,
    kleur.bold(newest.agentId),
    kleur.dim(newest.runId.slice(0, 12)),
    durationMs ? kleur.dim(`${durationMs}ms`) : "",
  );

  const mid = events.filter(
    (e) => e.event !== "agent.start" && e.event !== "agent.end" && e.event !== "agent.error",
  );
  for (const e of mid) {
    const color = COLORS[e.event] ?? kleur.gray;
    console.log("  ├─", color(e.event), kleur.dim(formatData(e.data)));
  }

  // Recurse into known child runs.
  const childIds = children.get(newest.runId);
  if (childIds) {
    for (const cid of childIds) {
      const childEvents = runs.get(cid) ?? [];
      const childEnd = childEvents.find(
        (e) => e.event === "agent.end" || e.event === "agent.error",
      );
      if (childEnd) {
        console.log(
          "  └─ child:",
          kleur.bold(childEvents[0]?.agentId ?? "?"),
          kleur.dim(cid.slice(0, 12)),
        );
      }
    }
  }

  if (newest.event === "agent.end") {
    console.log("  └─", kleur.green("result:"), formatData(newest.data));
  } else {
    console.log("  └─", kleur.red("error:"), formatData(newest.data));
  }
  // Keep insertion order tidy; nothing else needed since `order` is informational.
  void order;
}

function formatData(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data;
  try {
    const s = JSON.stringify(data);
    return s.length > 120 ? s.slice(0, 117) + "..." : s;
  } catch {
    return String(data);
  }
}
