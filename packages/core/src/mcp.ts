/**
 * MCP (Model Context Protocol) server integration.
 *
 * `connectMcpServer({url, headers})` connects to a remote MCP server,
 * lists its tools, and returns a `ToolDef[]` you can spread into your
 * agent's `tools:` array. Each MCP tool then registers as an iii function
 * under `<agentId>::tool::<name>` like any other tool, callable from any
 * worker on the iii network.
 *
 * Supports the streamable-HTTP transport (the modern MCP spec).
 * Stdio transport is Phase 2 — needs a child process supervisor.
 */
import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { ToolDef } from "./types.js";

export type McpConnectOpts =
  | {
      /** HTTP transport — `url` points to the server's MCP route. */
      transport?: "http";
      url: string;
      headers?: Record<string, string>;
      prefix?: string;
    }
  | {
      /** Stdio transport — spawn a child process and speak JSON-RPC over its pipes. */
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      prefix?: string;
    };

export interface McpConnection {
  /** Tools discovered on the server, ready to drop into defineAgent({ tools }). */
  tools: ToolDef<any, any>[];
  /** Server name as reported by the MCP handshake. */
  serverName: string;
  /** Server version. */
  serverVersion: string;
  /** Close the underlying transport. */
  close(): Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Connect to an MCP server (HTTP or stdio), list its tools, and return
 * them as snoopy ToolDefs ready to drop into `defineAgent({ tools })`.
 */
export async function connectMcpServer(opts: McpConnectOpts): Promise<McpConnection> {
  const client: McpTransport =
    (opts as any).transport === "stdio"
      ? new StdioMcpClient(opts as any)
      : new HttpMcpClient((opts as any).url, (opts as any).headers ?? {});

  // 1. initialize
  const init = await client.call<any>("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    clientInfo: { name: "snoopy", version: "0.2.0" },
  });
  const serverName: string = init?.serverInfo?.name ?? "mcp-server";
  const serverVersion: string = init?.serverInfo?.version ?? "?";
  // 2. announce ready
  await client.notify("notifications/initialized", {});

  // 3. list tools
  const list = await client.call<{ tools: McpToolDescriptor[] }>("tools/list", {});
  const descriptors = list?.tools ?? [];

  const tools: ToolDef<any, any>[] = descriptors.map((d) => {
    const toolName = (opts.prefix ?? "") + d.name;
    // We accept arbitrary args because the MCP server owns the schema.
    // Zod just validates it's a plain object; the actual schema check
    // happens server-side.
    const inputSchema = d.inputSchema as Record<string, unknown> | undefined;
    return defineTool({
      name: toolName,
      description: d.description ?? `MCP tool: ${d.name}`,
      // We hand the model the real JSON Schema by overriding toJsonSchema
      // when registering as an iii function — but defineTool expects a Zod
      // schema. Use z.record(z.unknown()) here and attach the JSON Schema
      // out-of-band via a symbol so the registrar can pick it up.
      input: attachJsonSchema(z.record(z.unknown()), inputSchema ?? { type: "object" }),
      handler: async (args: unknown) => {
        const r = await client.call<any>("tools/call", {
          name: d.name,
          arguments: args ?? {},
        });
        // MCP returns { content: [{type:"text", text:"..."}], isError? }
        if (r?.isError) {
          throw new Error(
            "MCP tool error: " +
            (r.content?.map((c: any) => c.text).join("\n") ?? "unknown"),
          );
        }
        const text = r?.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n") ?? "";
        // Try to parse JSON; fall back to text.
        try { return JSON.parse(text); } catch { return text; }
      },
    });
  });

  return {
    tools,
    serverName,
    serverVersion,
    close: () => client.close(),
  };
}

// ─── HTTP MCP client ────────────────────────────────────────────────────────

const JSON_SCHEMA_SYMBOL = Symbol.for("snoopy.mcp.jsonSchema");

function attachJsonSchema<T>(zodSchema: T, jsonSchema: Record<string, unknown>): T {
  (zodSchema as any)[JSON_SCHEMA_SYMBOL] = jsonSchema;
  return zodSchema;
}

/** Used by defineTool's iii registrar to prefer an attached JSON Schema. */
export function getAttachedJsonSchema(zodSchema: unknown): Record<string, unknown> | undefined {
  return (zodSchema as any)?.[JSON_SCHEMA_SYMBOL];
}

interface McpTransport {
  call<T>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): Promise<void>;
  close(): Promise<void>;
}

class HttpMcpClient implements McpTransport {
  private nextId = 1;
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  async call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...this.headers,
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(`MCP ${method} ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as JsonRpcResponse<T>;
    if (body.error) {
      throw new Error(`MCP ${method} error: ${body.error.message}`);
    }
    return body.result as T;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    }).catch(() => {}); // notifications are fire-and-forget
  }

  async close(): Promise<void> {
    // HTTP transport has nothing to close; method exists for API parity.
  }
}

// ─── Stdio MCP client ───────────────────────────────────────────────────────

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

class StdioMcpClient implements McpTransport {
  private nextId = 1;
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: any) => void }>();

  constructor(opts: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }) {
    this.child = spawn(opts.command, opts.args ?? [], {
      env: { ...process.env, ...(opts.env ?? {}) },
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onChunk(chunk.toString()));
    this.child.stderr.on("data", (chunk: Buffer) => {
      // MCP servers commonly log diagnostics to stderr; surface them.
      // eslint-disable-next-line no-console
      console.error(`[mcp:${opts.command}]`, chunk.toString().trim());
    });
    this.child.on("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("MCP stdio process exited"));
      this.pending.clear();
    });
  }

  private onChunk(s: string): void {
    this.buffer += s;
    // MCP stdio uses newline-delimited JSON-RPC.
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`MCP error: ${msg.error.message}`));
          else resolve(msg.result);
        }
      } catch {
        // ignore non-JSON noise
      }
    }
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async close(): Promise<void> {
    this.child.kill();
  }
}
