import kleur from "kleur";
import { TRACE_STREAM, type SpanEvent } from "@snoopy/core";
import { RedisStore } from "@snoopy/core";

interface LogsOpts {
  agent?: string;
  run?: string;
  /** Replay from start instead of tailing latest only. */
  replay?: boolean;
}

/**
 * Log tail filtered to a specific agent. Reads from the same trace
 * stream as `agent traces`, but renders prose-style rather than
 * tree-grouped, focused on text content.
 */
export async function logsCommand(opts: LogsOpts) {
  const store = new RedisStore({ prefix: "snoopy:" });
  const from = opts.replay ? "0" : undefined;
  console.log(
    kleur.dim(
      `Tailing logs${opts.agent ? ` for ${opts.agent}` : ""}${
        opts.replay ? " (from start)" : ""
      }…`,
    ),
  );

  for await (const entry of store.tail(TRACE_STREAM, from)) {
    const ev = entry.value as SpanEvent;
    if (opts.agent && ev.agentId !== opts.agent) continue;
    if (opts.run && ev.runId !== opts.run) continue;
    print(ev);
  }
}

function print(ev: SpanEvent) {
  const ts = new Date(ev.ts).toISOString();
  const tag = `[${ts}] ${ev.agentId} ${ev.runId.slice(0, 8)}`;
  const data = ev.data == null ? "" : formatData(ev.data);

  switch (ev.event) {
    case "agent.error":
      console.error(kleur.red(tag), kleur.red(ev.event), data);
      break;
    case "agent.end":
      console.log(kleur.green(tag), kleur.green(ev.event), data);
      break;
    case "agent.start":
      console.log(kleur.cyan(tag), kleur.cyan(ev.event), data);
      break;
    default:
      console.log(kleur.dim(tag), ev.event, data);
  }
}

function formatData(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}
