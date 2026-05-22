import type { ZodTypeAny, z } from "zod";
import type { ISdk } from "iii-sdk";
import type { Memory } from "./memory.js";
import type { VectorMemory } from "./vectorMemory.js";
import type { LlmProvider, ChatMessage, ThinkingLevel } from "./llm.js";
import type { Session, SessionRegistry } from "./session.js";
import type { SessionEnv } from "./sessionEnv.js";

export interface FlueLogger {
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}

export type TriggerType =
  | "http" | "cron" | "webhook" | "queue" | "event"
  | "stream" | "state" | "subscribe" | "log" | "direct";

export interface TriggerDef {
  type: TriggerType;
  config: Record<string, unknown>;
}

export interface ToolDef<TInput extends ZodTypeAny = ZodTypeAny, TOutput = unknown> {
  name: string;
  description: string;
  input: TInput;
  handler: (args: z.infer<TInput>) => Promise<TOutput> | TOutput;
  idempotent?: boolean;
}

export interface AgentContext {
  runId: string;
  memory: Memory;

  /**
   * The iii SDK — same instance returned by `registerWorker(III_WS_URL)`.
   * Every distributed coordination operation is a direct iii primitive call:
   *
   *   await ctx.iii.trigger({ function_id: "sre.investigator", payload: {...} });
   *   await ctx.iii.trigger({ function_id: "state::set", payload: {...} });
   *   await ctx.iii.trigger({ function_id: "sandbox::exec", payload: {...} });
   *   ctx.iii.registerFunction("dynamic.fn", handler);
   *   ctx.iii.registerTrigger({ type: "cron", function_id, config });
   *
   * There is no snoopy wrapper layer between this and the iii engine.
   */
  iii: ISdk;

  /** Default session — Flue-shaped reasoning loop with tool calling. */
  session: Session;
  /** Multi-session registry — for parallel branches. */
  sessions: SessionRegistry;
  /** Structured log emitter — mirrors Flue's `ctx.log`. */
  log: FlueLogger;
  /** Low-level span emitter. Prefer `log` for prose. */
  emit: (event: string, data?: unknown) => void;

  history?: ChatMessage[];
}

export interface AgentDef<TIn = unknown, TOut = unknown> {
  id: string;
  /** Model id in `provider/model-id` format. */
  model?: string;
  /** Custom LLM provider. Overrides whatever `model`'s prefix resolves to. */
  llm?: LlmProvider;
  /** Default reasoning effort. */
  thinkingLevel?: ThinkingLevel;
  /** Role markdown name to use as default system prompt. */
  role?: string;
  tools: ToolDef<any, any>[];
  triggers?: TriggerDef[];
  /**
   * Convenience: a cron expression that fires this agent on schedule.
   * Equivalent to adding `defineTrigger.cron({ schedule })` to triggers.
   * Use when the only trigger is a schedule.
   */
  schedule?: string;
  cwd?: string;
  memory?: Memory;
  /** Sandbox env for shell + fs. Defaults to LocalSessionEnv(cwd). */
  sandbox?: SessionEnv;
  result?: ZodTypeAny;
  /**
   * Build a single prompt — convenient for simple agents. We run the
   * reasoning loop for you and return the validated result.
   *
   * Mutually exclusive with `handler:` (use one or the other).
   */
  prompt?: (payload: TIn, ctx: AgentContext) => string;
  /**
   * Full control — orchestrate session calls yourself. Use this when the
   * agent needs multi-step composition (call skill A, then prompt with
   * result, then task B, then return).
   *
   * Mutually exclusive with `prompt:`.
   */
  handler?: (payload: TIn, ctx: AgentContext) => Promise<TOut>;
  maxTurns?: number;
  /** Suffix appended after role markdown in the system prompt. */
  systemSuffix?: string;
  /** Auto-compact history when message count exceeds this. Default 40. */
  compactionThreshold?: number;
  /** Different model for compaction. Defaults to the main model. */
  compactionModel?: string;
  dedupe?: false | "semantic" | ((payload: TIn) => string);
  dedupeTtlSec?: number;
  dedupeVectorStore?: VectorMemory;
  dedupeSimilarityThreshold?: number;
}

export interface RegisteredAgent {
  id: string;
  memory: Memory;
}
