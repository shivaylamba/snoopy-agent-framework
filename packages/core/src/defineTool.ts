import type { ZodTypeAny, z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { iiiClient } from "./iiiClient.js";
import { toolCallContext } from "./toolContext.js";
import { defaultDedupeKey } from "./dedupe.js";
import { getAttachedJsonSchema } from "./mcp.js";
import { stateSet, stateGet } from "./kernelState.js";
import type { ToolDef } from "./types.js";

/**
 * Define a tool. Returns the ToolDef so users compose them in the
 * agent's `tools: [...]` array.
 *
 * Tool registration on iii happens lazily — when an agent that uses this
 * tool gets defined, its tools register as iii functions under the
 * id `<agentId>::tool::<toolName>`. That gives every tool a stable iii
 * function id, callable across workers.
 */
export function defineTool<TInput extends ZodTypeAny, TOutput>(
  def: ToolDef<TInput, TOutput>,
): ToolDef<TInput, TOutput> {
  return def;
}

/**
 * Register a snoopy ToolDef as an iii Function. The agent's reasoning
 * loop invokes the tool via `iii.trigger({function_id: ...})`, so the tool
 * could be running anywhere on the iii network — same worker, sibling
 * worker, sandboxed worker, remote worker.
 *
 * Idempotent-tool replay: when a tool with `idempotent !== false` was
 * already invoked successfully under the current runId, we return the
 * cached result instead of re-executing. AsyncLocalStorage threads the
 * runId in from defineAgent's handler.
 */
export function registerToolOnIii(
  agentId: string,
  tool: ToolDef<any, any>,
): { iiiFunctionId: string; parametersSchema: Record<string, unknown> } {
  const iiiFunctionId = `${agentId}::tool::${tool.name}`;
  // Prefer an attached JSON Schema (e.g. from MCP) over Zod conversion —
  // upstream owns the real schema and we shouldn't lossily round-trip it.
  const attached = getAttachedJsonSchema(tool.input);
  const parametersSchema: Record<string, unknown> =
    attached ?? (zodToJsonSchema(tool.input as ZodTypeAny, { target: "openAi" }) as Record<string, unknown>);

  const iii = iiiClient();
  iii.registerFunction(iiiFunctionId, async (args: unknown) => {
    const parsed = (tool.input as ZodTypeAny).parse(args) as z.infer<typeof tool.input>;
    const ctx = toolCallContext.getStore();
    const cacheable = ctx && tool.idempotent !== false;

    if (cacheable) {
      // Idempotent tool replay — direct iii primitive (state::get/set).
      // No Memory wrapping; goes straight to the iii engine.
      const argsHash = defaultDedupeKey(parsed);
      const cacheKey = `tool:${ctx.runId}:${tool.name}:${argsHash}`;
      const cached = await stateGet<unknown>(iii, cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const result = await tool.handler(parsed);
      await stateSet(iii, cacheKey, result, 3600);
      return result;
    }
    return tool.handler(parsed);
  });

  return { iiiFunctionId, parametersSchema };
}
