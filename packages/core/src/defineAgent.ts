import { TriggerAction } from "iii-sdk";

import { registerToolOnIii } from "./defineTool.js";
import { IIIStore, type Memory } from "./memory.js";
import { Span, emitSpan } from "./tracing.js";
import { iiiClient } from "./iiiClient.js";
import { defaultDedupeKey } from "./dedupe.js";
import { toolCallContext } from "./toolContext.js";
import { discoverSkills } from "./discovery.js";
import { discoverCallableSkills } from "./skills.js";
import { withKeyedLock } from "./keyedMutex.js";
import { Session, SessionRegistry, type SessionInit } from "./session.js";
import { LocalSessionEnv, type SessionEnv } from "./sessionEnv.js";
import { stateSet, stateGet } from "./kernelState.js";
import type { LoopTool } from "./loop.js";
import type { ChatMessage, ThinkingLevel } from "./llm.js";
import type { AgentContext, AgentDef, RegisteredAgent } from "./types.js";

const DEFAULT_DEDUPE_TTL_SEC = 300;
const DEFAULT_MODEL = "openai/gpt-5-mini";
const DEFAULT_COMPACTION_THRESHOLD = 40;

export function defineAgent<TIn = unknown, TOut = unknown>(
  def: AgentDef<TIn, TOut>,
): RegisteredAgent {
  if (def.prompt && def.handler) {
    throw new Error(`Agent "${def.id}": specify either prompt: or handler:, not both`);
  }
  if (!def.prompt && !def.handler) {
    throw new Error(`Agent "${def.id}": must specify prompt: or handler:`);
  }

  const cwd = def.cwd ?? process.cwd();
  const memory: Memory = def.memory ?? new IIIStore();
  const sandbox: SessionEnv = def.sandbox ?? new LocalSessionEnv(cwd);
  const iii = iiiClient();

  const harnessTools: LoopTool[] = def.tools.map((t) => {
    const { iiiFunctionId, parametersSchema } = registerToolOnIii(def.id, t);
    return {
      name: t.name,
      description: t.description,
      parameters: parametersSchema,
      iiiFunctionId,
      idempotent: t.idempotent,
    };
  });

  iii.registerFunction(def.id, async (payload: unknown) => {
    const runId = generateRunId();
    const typed = payload as TIn;
    const span = new Span(def.id, runId);

    // Dedupe gates — direct iii primitive calls, no Memory wrapper.
    if (def.dedupe === "semantic" && def.dedupeVectorStore) {
      const threshold = def.dedupeSimilarityThreshold ?? 0.85;
      const text = payloadText(typed);
      const hits = await def.dedupeVectorStore.search(text, { k: 1, minScore: threshold });
      if (hits.length > 0) {
        const cached = await stateGet<TOut>(iii, `dedupe:${def.id}:sem:${hits[0]!.id}`);
        if (cached !== undefined) {
          emitSpan(span, { event: "agent.dedupe.hit", data: { mode: "semantic", score: hits[0]!.score } }, memory);
          return cached;
        }
      }
    }
    const dedupeKey = computeDedupeKey<TIn>(typed, def);
    if (dedupeKey) {
      const cached = await stateGet<TOut>(iii, `dedupe:${def.id}:${dedupeKey}`);
      if (cached !== undefined) {
        emitSpan(span, { event: "agent.dedupe.hit", data: { key: dedupeKey } }, memory);
        return cached;
      }
    }

    emitSpan(span, { event: "agent.start", data: { payload: typed } }, memory);

    return toolCallContext.run({ runId, memory }, async () => {
      // Discover roles + callable skills (re-read each invocation — hot reload)
      const roleSkills = await discoverSkills(cwd);
      const skills = await discoverCallableSkills(cwd);

      // Roles map with optional model/thinkingLevel from frontmatter
      const roles: SessionInit["roles"] = {};
      for (const [n, s] of Object.entries(roleSkills)) {
        roles[n] = {
          instructions: s.instructions,
          model: s.model,
          thinkingLevel: s.thinkingLevel as ThinkingLevel | undefined,
        };
      }

      const prior = await stateGet<ChatMessage[]>(iii, `session:${def.id}:${runId}`);

      // Factory for new sessions — used by SessionRegistry too.
      const newSession = (name: string) => new Session({
        agentId: def.id,
        runId,
        name,
        model: def.model ?? DEFAULT_MODEL,
        llm: def.llm,
        thinkingLevel: def.thinkingLevel,
        tools: harnessTools,
        roles,
        defaultRole: def.role,
        skills,
        memory,
        env: sandbox,
        maxTurns: def.maxTurns ?? 12,
        compactionThreshold: def.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
        compactionModel: def.compactionModel,
        history: name === "default" ? prior : undefined,
        onToolCall: (call) =>
          emitSpan(span, { event: `tool.${call.name}`, data: { args: call.args } }, memory),
        onToolResult: (call) =>
          emitSpan(span, { event: `tool.${call.name}.done`, data: { ms: call.durationMs } }, memory),
        onHistoryUpdate: async (history) => {
          if (name === "default") {
            // Direct iii primitive — state::set — serialized per-run so
            // concurrent turns don't clobber each other.
            await withKeyedLock(`history:${def.id}:${runId}`, () =>
              stateSet(iii, `session:${def.id}:${runId}`, history, 7 * 24 * 3600).catch(() => {}),
            );
          }
        },
      });

      const defaultSession = newSession("default");
      const sessions = new SessionRegistry((name) => newSession(name));
      // Seed default in the registry so `harness.sessions.get()` returns the same one.
      (sessions as any).sessions.set("default", defaultSession);

      if (prior) emitSpan(span, { event: "agent.resumed", data: { historyLen: prior.length } }, memory);

      const ctx: AgentContext = {
        runId,
        memory,
        // The raw iii SDK — user code uses this for any iii primitive directly.
        // ctx.call / ctx.spawn are convenience wrappers over ctx.sdk.trigger.
        sdk: iii,
        session: defaultSession,
        sessions,
        history: prior,
        emit: (event, data) => emitSpan(span, { event, data }, memory),
        log: {
          info: (msg, data) => emitSpan(span, { event: "log.info", data: { msg, ...(data as object ?? {}) } }, memory),
          warn: (msg, data) => emitSpan(span, { event: "log.warn", data: { msg, ...(data as object ?? {}) } }, memory),
          error: (msg, data) => emitSpan(span, { event: "log.error", data: { msg, ...(data as object ?? {}) } }, memory),
        },
        spawn: async (childAgentId, childPayload) => {
          emitSpan(span, { event: "agent.spawn", data: { child: childAgentId } }, memory);
          return iii.trigger({
            function_id: childAgentId,
            payload: childPayload,
            action: TriggerAction.Void(),
          });
        },
        call: async <TR = unknown>(childAgentId: string, childPayload: unknown, opts?: { timeoutMs?: number }): Promise<TR> => {
          emitSpan(span, { event: "agent.call", data: { child: childAgentId } }, memory);
          const result = await iii.trigger<unknown, TR>({
            function_id: childAgentId,
            payload: childPayload,
            timeoutMs: opts?.timeoutMs,
          });
          emitSpan(span, { event: "agent.call.return", data: { child: childAgentId } }, memory);
          return result;
        },
      };

      try {
        let result: TOut;
        if (def.handler) {
          result = await def.handler(typed, ctx);
        } else {
          const userPrompt = def.prompt!(typed, ctx);
          result = (await defaultSession.prompt(userPrompt, { result: def.result })) as TOut;
        }

        emitSpan(span, {
          event: "agent.end",
          data: { result, usage: defaultSession.usage },
        }, memory);

        if (dedupeKey) {
          // Direct iii primitive — state::set
          await stateSet(iii, `dedupe:${def.id}:${dedupeKey}`, result, def.dedupeTtlSec ?? DEFAULT_DEDUPE_TTL_SEC);
        }
        if (def.dedupe === "semantic" && def.dedupeVectorStore) {
          const text = payloadText(typed);
          await def.dedupeVectorStore.upsert({ id: runId, text, metadata: { agentId: def.id, ts: Date.now() } });
          await stateSet(iii, `dedupe:${def.id}:sem:${runId}`, result, def.dedupeTtlSec ?? DEFAULT_DEDUPE_TTL_SEC);
        }

        return result;
      } catch (err) {
        emitSpan(span, { event: "agent.error", data: { error: String(err) } }, memory);
        throw err;
      }
    });
  });

  const allTriggers = [...(def.triggers ?? [])];
  if (def.schedule) {
    allTriggers.push({ type: "cron", config: { schedule: def.schedule } });
  }
  for (const trig of allTriggers) {
    iii.registerTrigger({
      type: trig.type,
      function_id: def.id,
      config: trig.config as Record<string, unknown>,
    });
  }

  return { id: def.id, memory };
}

function generateRunId(): string {
  return "run_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

function computeDedupeKey<TIn>(
  payload: TIn,
  def: { dedupe?: false | "semantic" | ((payload: TIn) => string) },
): string | undefined {
  if (def.dedupe === false || def.dedupe === "semantic") return undefined;
  if (typeof def.dedupe === "function") return def.dedupe(payload);
  return defaultDedupeKey(stripInfraKeys(payload));
}

function stripInfraKeys(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

function payloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try { return JSON.stringify(payload); } catch { return String(payload); }
}
