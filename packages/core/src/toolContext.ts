import { AsyncLocalStorage } from "node:async_hooks";
import type { Memory } from "./memory.js";

/**
 * Per-invocation context threaded through tool handlers via AsyncLocalStorage.
 * Tools read this to decide whether a prior successful call (same args, same
 * runId) should short-circuit on resume — see `defineTool.toHarnessTool`.
 */
export interface ToolCallContext {
  runId: string;
  memory: Memory;
}

export const toolCallContext = new AsyncLocalStorage<ToolCallContext>();
