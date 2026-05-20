import { Logger } from "iii-sdk";
import type { Memory } from "./memory.js";

export interface SpanEvent {
  agentId: string;
  runId: string;
  parentRunId?: string;
  event: string;
  data?: unknown;
  ts: number;
}

export const TRACE_STREAM = "snoopy.trace";

/**
 * Pluggable trace sink. Implementations: stdout (always on), iii OTel
 * (always on, falls back silently), Memory stream (when memory passed),
 * and any user-provided sinks (PgTraceStore, custom adapters).
 */
export interface TraceSink {
  record(span: SpanEvent): void | Promise<void>;
}

const externalSinks: TraceSink[] = [];

/**
 * Register an extra trace sink (e.g. `addTraceSink(new PgTraceStore())` for
 * durable spans). Sinks are best-effort: failures are swallowed.
 */
export function addTraceSink(sink: TraceSink): void {
  externalSinks.push(sink);
}

let _logger: Logger | undefined;
function logger(): Logger {
  return (_logger ??= new Logger(undefined, "snoopy"));
}

export class Span {
  constructor(
    public readonly agentId: string,
    public readonly runId: string,
    public readonly parentRunId?: string,
  ) {}
}

/**
 * Emit a span. Goes to four sinks in best-effort order:
 *   1. stdout (so `agent dev` shows spans inline)
 *   2. iii OTel logger (distributed tracing dashboards pick it up)
 *   3. memory append (if `memory` provided — Redis stream for `agent traces`)
 *   4. external sinks registered via addTraceSink (Postgres, custom)
 *
 * Tracing must never break the agent loop. Each sink is guarded.
 */
export function emitSpan(
  span: Span,
  payload: { event: string; data?: unknown },
  memory?: Memory,
): void {
  const ev: SpanEvent = {
    agentId: span.agentId,
    runId: span.runId,
    parentRunId: span.parentRunId,
    event: payload.event,
    data: payload.data,
    ts: Date.now(),
  };

  if (process.env.SNOOPY_TRACE_STDOUT !== "false") {
    const tag = `[trace ${ev.agentId} ${ev.runId.slice(0, 8)}]`;
    // eslint-disable-next-line no-console
    console.log(tag, ev.event, ev.data ?? "");
  }

  try {
    logger().info(`snoopy.span ${ev.event}`, ev as unknown as Record<string, unknown>);
  } catch {}

  if (memory) {
    void memory.append(TRACE_STREAM, ev).catch(() => {});
  }

  for (const sink of externalSinks) {
    Promise.resolve(sink.record(ev)).catch(() => {});
  }
}
