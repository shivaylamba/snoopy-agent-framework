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
   * The raw iii SDK — use this for any iii primitive directly:
   *
   *   await ctx.sdk.trigger({ function_id: "sre.investigator", payload: {...} });
   *   await ctx.sdk.trigger({ function_id: "state::set", payload: {...} });
   *   await ctx.sdk.trigger({ function_id: "sandbox::exec", payload: {...} });
   *   ctx.sdk.registerFunction("dynamic.fn", handler);
   *   ctx.sdk.registerTrigger({ type: "cron", function_id, config });
   *
   * snoopy does NOT wrap iii — `ctx.sdk` is the same instance returned by
   * `registerWorker(III_WS_URL)`. Every distributed coordination operation
   * (calling other agents, reading state, scheduling) is a `ctx.sdk.trigger`
   * call against an iii function id.
   */
  sdk: ISdk;

  /** Default session — Flue-shaped reasoning loop with tool calling. */
  session: Session;
  /** Multi-session registry — for parallel branches. */
  sessions: SessionRegistry;
  /** Structured log emitter — mirrors Flue's `ctx.log`. */
  log: FlueLogger;
  /** Low-level span emitter. Prefer `log` for prose. */
  emit: (event: string, data?: unknown) => void;

  /**
   * Optional sugar over `ctx.sdk.trigger({function_id, payload, action: Void()})`.
   * Adds a trace span. Identical to:
   *
   *   await ctx.sdk.trigger({
   *     function_id: childAgentId, payload, action: TriggerAction.Void(),
   *   });
   *
   * Use `ctx.sdk.trigger(...)` directly if you don't want the span.
   */
  spawn: (childAgentId: string, payload: unknown) => Promise<unknown>;

  /**
   * Optional sugar over `ctx.sdk.trigger({function_id, payload, timeoutMs})`.
   * Adds entry/exit trace spans + a typed return generic. Identical to:
   *
   *   const result = await ctx.sdk.trigger<TIn, TOut>({
   *     function_id: childAgentId, payload, timeoutMs,
   *   });
   *
   * Use `ctx.sdk.trigger(...)` directly for the unwrapped iii primitive.
   */
  call: <TOut = unknown>(
    childAgentId: string,
    payload: unknown,
    opts?: { timeoutMs?: number },
  ) => Promise<TOut>;

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
