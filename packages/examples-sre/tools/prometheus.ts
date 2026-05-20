import { z } from "zod";
import { defineTool } from "@snoopy/core";

const PROM = process.env.PROMETHEUS_URL ?? "http://localhost:9090";

export const prometheus = defineTool({
  name: "prometheus_query",
  description: "Run an instant PromQL query against the configured Prometheus.",
  input: z.object({
    query: z.string().describe("PromQL query, e.g. 'rate(http_5xx_total[5m])'"),
  }),
  idempotent: true,
  handler: async ({ query }) => {
    const url = `${PROM}/api/v1/query?query=${encodeURIComponent(query)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: unknown; status?: string };
      return { result: body.data, status: body.status };
    } catch (err) {
      return { error: String(err) };
    }
  },
});
