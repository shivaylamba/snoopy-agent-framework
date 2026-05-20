import { createRequire } from "node:module";
import type { SpanEvent } from "./tracing.js";

const nodeRequire = createRequire(import.meta.url);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snoopy_spans (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  parent_run  TEXT,
  event       TEXT NOT NULL,
  data        JSONB,
  ts          TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS snoopy_spans_run_idx    ON snoopy_spans (run_id);
CREATE INDEX IF NOT EXISTS snoopy_spans_agent_idx  ON snoopy_spans (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS snoopy_spans_ts_idx     ON snoopy_spans (ts DESC);
`;

export interface ListOpts {
  agent?: string;
  since?: Date;
  limit?: number;
}

/**
 * Durable trace storage. Use alongside the Redis stream — Redis is for
 * live tailing, Postgres is for query / replay / dashboards. The HTTP
 * endpoint in `tracesServer.ts` reads from this.
 *
 * Schema is created on first connect (idempotent). pg is dynamic-imported
 * so users without a Postgres dependency don't pay for it.
 */
export class PgTraceStore {
  private pool: any;
  private readyPromise: Promise<void>;

  constructor(opts: { connectionString?: string } = {}) {
    const { Pool } = nodeRequire("pg");
    this.pool = new Pool({
      connectionString:
        opts.connectionString ??
        process.env.DATABASE_URL ??
        "postgres://snoopy:snoopy@localhost:5432/snoopy",
    });
    this.readyPromise = this.pool.query(SCHEMA).then(() => undefined);
  }

  async record(span: SpanEvent): Promise<void> {
    await this.readyPromise;
    await this.pool.query(
      `INSERT INTO snoopy_spans (agent_id, run_id, parent_run, event, data, ts)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))`,
      [
        span.agentId,
        span.runId,
        span.parentRunId ?? null,
        span.event,
        span.data == null ? null : JSON.stringify(span.data),
        span.ts,
      ],
    );
  }

  async getByRun(runId: string): Promise<SpanEvent[]> {
    await this.readyPromise;
    const { rows } = await this.pool.query(
      `SELECT agent_id, run_id, parent_run, event, data, EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms
       FROM snoopy_spans WHERE run_id = $1 ORDER BY id ASC`,
      [runId],
    );
    return rows.map(rowToSpan);
  }

  async list(opts: ListOpts = {}): Promise<SpanEvent[]> {
    await this.readyPromise;
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.agent) {
      params.push(opts.agent);
      conds.push(`agent_id = $${params.length}`);
    }
    if (opts.since) {
      params.push(opts.since);
      conds.push(`ts >= $${params.length}`);
    }
    params.push(opts.limit ?? 100);
    const limitParam = `$${params.length}`;
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT agent_id, run_id, parent_run, event, data, EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms
       FROM snoopy_spans ${where} ORDER BY id DESC LIMIT ${limitParam}`,
      params,
    );
    return rows.map(rowToSpan);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rowToSpan(row: any): SpanEvent {
  return {
    agentId: row.agent_id,
    runId: row.run_id,
    parentRunId: row.parent_run ?? undefined,
    event: row.event,
    data: row.data,
    ts: Number(row.ts_ms),
  };
}
