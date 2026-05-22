// ── core API ────────────────────────────────────────────────────────────────
export { defineAgent } from "./defineAgent.js";
export { defineTool } from "./defineTool.js";
export { defineTrigger } from "./defineTrigger.js";

// ── session (Flue-style API) ────────────────────────────────────────────────
export { Session, SessionRegistry } from "./session.js";
export type {
  PromptOptions, SkillOptions, SessionInit, SessionOptions,
  Harness, PromptUsage,
} from "./session.js";

// ── call handle ─────────────────────────────────────────────────────────────
export { makeCallHandle, AbortError } from "./callHandle.js";
export type { CallHandle } from "./callHandle.js";

// ── memory ──────────────────────────────────────────────────────────────────
export { InMemoryStore, IIIStore, RedisStore } from "./memory.js";
export type { Memory, StreamEntry } from "./memory.js";
export { IIIState } from "./iiiState.js";
export { iiiClient, setIiiClient } from "./iiiClient.js";
export { StateKV } from "./stateKv.js";
export type { StateUpdateOp } from "./stateKv.js";
export { withKeyedLock } from "./keyedMutex.js";
export { bootLog, flushBootLog } from "./bootLog.js";
export { installLifecycleHandlers, onWorkerShutdown } from "./lifecycle.js";

// ── vector memory ───────────────────────────────────────────────────────────
export { InMemoryVectorStore } from "./vectorMemory.js";
export type {
  Embedder, VectorMemory, VectorRecord, VectorSearchHit, VectorSearchOpts,
} from "./vectorMemory.js";

// ── tracing + dashboard ─────────────────────────────────────────────────────
export { Span, emitSpan, addTraceSink, TRACE_STREAM } from "./tracing.js";
export type { SpanEvent, TraceSink } from "./tracing.js";
export { PgTraceStore } from "./pgTraceStore.js";
export { startTracesServer } from "./tracesServer.js";

// ── execution surfaces ──────────────────────────────────────────────────────
export { sandboxedExec } from "./sandbox.js";
export type { SandboxBackend, SandboxExecRequest, SandboxExecResult } from "./sandbox.js";
export { LocalSessionEnv, IIISandboxSessionEnv } from "./sessionEnv.js";
export type { SessionEnv, SessionFs, ShellOptions, ShellResult, FileStat } from "./sessionEnv.js";

// ── skills / discovery ──────────────────────────────────────────────────────
export { discoverSkills } from "./discovery.js";
export type { SkillMarkdown } from "./discovery.js";
export { discoverCallableSkills, renderSkill } from "./skills.js";
export type { Skill } from "./skills.js";

// ── LLM ─────────────────────────────────────────────────────────────────────
export { OpenAIProvider, AnthropicProvider, resolveProvider } from "./llm.js";
export type {
  LlmProvider, ChatMessage, ChatRequest, ChatResponse, ChatStreamEvent,
  ToolSchema, ToolCall, ThinkingLevel, ImageContent,
} from "./llm.js";

// ── MCP (consume + expose) ──────────────────────────────────────────────────
export { connectMcpServer, getAttachedJsonSchema } from "./mcp.js";
export type { McpConnectOpts, McpConnection } from "./mcp.js";
export { startMcpServer } from "./mcpServer.js";
export type { McpServerOpts, McpServerHandle } from "./mcpServer.js";

// ── auth ────────────────────────────────────────────────────────────────────
export { timingSafeCompare } from "./auth.js";

// ── types ───────────────────────────────────────────────────────────────────
export type {
  AgentContext, AgentDef, RegisteredAgent, ToolDef, TriggerDef, TriggerType, FlueLogger,
} from "./types.js";
