/**
 * MCP server — exposes every registered snoopy agent as an MCP tool.
 *
 * Pattern from rohitg00/agentmemory's `src/mcp/server.ts`. Mounts an
 * HTTP endpoint on the iii worker that speaks the MCP streamable-HTTP
 * protocol; clients (Claude Desktop, Cursor, Continue, any MCP host)
 * connect to it and can list + call your agents as tools.
 *
 *   import { startMcpServer } from "@snoopy/core";
 *   startMcpServer({ port: 4280, agentIds: ["sre.triage", "lead.extract"] });
 *
 * Now `http://localhost:4280/mcp` is an MCP server. From Claude Desktop's
 * config:
 *   { "mcpServers": { "snoopy": { "url": "http://localhost:4280/mcp" } } }
 *
 * Bidirectional MCP: we already CONSUME external MCP servers via
 * connectMcpServer(); this lets us BE one.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { iiiClient } from "./iiiClient.js";
import { timingSafeCompare } from "./auth.js";

export interface McpServerOpts {
  /** Port to listen on. Defaults to 4280. */
  port?: number;
  /**
   * Agent ids to expose. Defaults to "discover": pulls the full list of
   * iii functions and exposes everything that's not a built-in or a tool
   * (filters out `engine::*`, `state::*`, `stream::*`, and `<agent>::tool::*`).
   */
  agentIds?: string[] | "discover";
  /** Optional bearer secret. If set, clients must send Authorization: Bearer <secret>. */
  secret?: string;
  /**
   * Server name + version reported in the MCP handshake. Defaults pick
   * up from process.env.SNOOPY_PROJECT_NAME.
   */
  serverName?: string;
  serverVersion?: string;
}

export interface McpServerHandle {
  close(): Promise<void>;
  port: number;
}

export function startMcpServer(opts: McpServerOpts = {}): McpServerHandle {
  const port = opts.port ?? 4280;
  const serverName = opts.serverName ?? process.env.SNOOPY_PROJECT_NAME ?? "snoopy";
  const serverVersion = opts.serverVersion ?? process.env.SNOOPY_VERSION ?? "0.2.0";

  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, server: serverName, version: serverVersion }));

  app.post("/mcp", async (c) => {
    if (opts.secret) {
      const auth = c.req.header("authorization") ?? "";
      if (!timingSafeCompare(auth, `Bearer ${opts.secret}`)) {
        return c.json({ jsonrpc: "2.0", error: { code: -32600, message: "unauthorized" } }, 401);
      }
    }
    const msg = (await c.req.json()) as JsonRpcRequest;
    const result = await handleMcpMessage(msg, opts);
    if (msg.id === undefined) return c.body(null, 204); // notification
    return c.json(result);
  });

  const server = serve({ fetch: app.fetch, port });
  return {
    port,
    close: async () => { (server as any)?.close?.(); },
  };
}

// ─── JSON-RPC + MCP protocol ─────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function handleMcpMessage(
  msg: JsonRpcRequest,
  opts: McpServerOpts,
): Promise<JsonRpcResponse> {
  const reply = (result: unknown): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: msg.id ?? 0,
    result,
  });
  const err = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: msg.id ?? 0,
    error: { code, message },
  });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: {
          name: opts.serverName ?? "snoopy",
          version: opts.serverVersion ?? "0.2.0",
        },
      });

    case "notifications/initialized":
      return reply({});

    case "tools/list":
      return reply({ tools: await listAgentsAsTools(opts) });

    case "tools/call": {
      const { name, arguments: args } = msg.params ?? {};
      try {
        const iii = iiiClient();
        const result = await iii.trigger({ function_id: name, payload: args ?? {} });
        return reply({
          content: [
            { type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) },
          ],
        });
      } catch (e: any) {
        return reply({
          isError: true,
          content: [{ type: "text", text: String(e?.message ?? e) }],
        });
      }
    }

    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });

    default:
      return err(-32601, `Method not found: ${msg.method}`);
  }
}

async function listAgentsAsTools(opts: McpServerOpts): Promise<any[]> {
  const iii = iiiClient();
  let agentIds: string[];

  if (opts.agentIds && opts.agentIds !== "discover") {
    agentIds = opts.agentIds;
  } else {
    const list = await iii.trigger<unknown, { functions: Array<{ function_id: string; description?: string; request_format?: any }> }>({
      function_id: "engine::functions::list",
      payload: {},
    });
    agentIds = (list?.functions ?? [])
      .filter((f) => !isBuiltin(f.function_id))
      .filter((f) => !f.function_id.includes("::tool::"))
      .map((f) => f.function_id);
  }

  // Get descriptions/schemas for each.
  const tools: any[] = [];
  for (const id of agentIds) {
    let request_format: any = undefined;
    let description: string | undefined;
    try {
      const meta = await iii.trigger<unknown, { functions: Array<{ function_id: string; description?: string; request_format?: any }> }>({
        function_id: "engine::functions::list",
        payload: {},
      });
      const f = meta?.functions?.find((x) => x.function_id === id);
      request_format = f?.request_format ?? undefined;
      description = f?.description ?? undefined;
    } catch {
      // Best effort — still expose the tool without a schema.
    }
    tools.push({
      name: id,
      description: description ?? `Snoopy agent: ${id}`,
      inputSchema: request_format ?? { type: "object", properties: {}, additionalProperties: true },
    });
  }
  return tools;
}

function isBuiltin(fnId: string): boolean {
  return (
    fnId.startsWith("engine::") ||
    fnId.startsWith("state::") ||
    fnId.startsWith("stream::") ||
    fnId.startsWith("iii::") ||
    fnId === "publish"
  );
}
