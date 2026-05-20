import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { PgTraceStore } from "./pgTraceStore.js";
import { DASHBOARD_HTML } from "./dashboardHtml.js";

export interface TracesServerOpts {
  store: PgTraceStore;
  port?: number;
}

/**
 * Minimal HTTP read-side for the Postgres trace store. Useful as the
 * backing API for a future dashboard, or for ad-hoc curl exploration:
 *
 *   GET /traces?agent=sre.triage&limit=20     → recent spans (filterable)
 *   GET /traces/:runId                        → full event timeline for a run
 *   GET /health                               → liveness
 *
 * Run as a sidecar to the worker process — does not interfere with
 * normal agent execution.
 */
export function startTracesServer(opts: TracesServerOpts): { close: () => void } {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  // Embedded single-file dashboard at /.
  app.get("/", (c) => c.html(DASHBOARD_HTML));

  app.get("/traces", async (c) => {
    const agent = c.req.query("agent") ?? undefined;
    const since = c.req.query("since");
    const limit = Number(c.req.query("limit") ?? "100");
    const rows = await opts.store.list({
      agent,
      since: since ? new Date(since) : undefined,
      limit: Math.min(Math.max(limit, 1), 1000),
    });
    return c.json({ spans: rows });
  });

  app.get("/traces/:runId", async (c) => {
    const rows = await opts.store.getByRun(c.req.param("runId"));
    if (rows.length === 0) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ runId: c.req.param("runId"), spans: rows });
  });

  const server = serve({ fetch: app.fetch, port: opts.port ?? 3210 });

  return {
    close: () => {
      (server as any)?.close?.();
    },
  };
}
