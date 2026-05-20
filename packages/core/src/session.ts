/**
 * Session — the Flue-parity programming surface.
 *
 * Returned methods are `CallHandle<T>` (Promise + signal + abort), giving
 * users cancellation control:
 *
 *   const h = ctx.session.prompt("...", { signal: AbortSignal.timeout(10_000) });
 *   setTimeout(() => h.abort(), 5_000);
 *   const result = await h;
 */
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Memory } from "./memory.js";
import type { SessionEnv, ShellOptions, ShellResult } from "./sessionEnv.js";
import type { Skill } from "./skills.js";
import { renderSkill } from "./skills.js";
import {
  resolveProvider,
  type ChatMessage,
  type ImageContent,
  type LlmProvider,
  type ThinkingLevel,
  type ToolSchema,
} from "./llm.js";
import { iiiClient } from "./iiiClient.js";
import type { LoopTool } from "./loop.js";
import { type CallHandle, makeCallHandle } from "./callHandle.js";

export interface PromptOptions<T = unknown> {
  /** Zod schema for structured output (Flue's `result`). */
  result?: ZodTypeAny;
  /** Deprecated alias for `result` — accepted for Flue migration parity. */
  schema?: ZodTypeAny;
  /** Per-call tools added on top of harness defaults. */
  tools?: LoopTool[];
  /** Per-call role override — looked up in the harness's role map. */
  role?: string;
  /** Per-call model override. */
  model?: string;
  /** Reasoning effort override. */
  thinkingLevel?: ThinkingLevel;
  /** Max turns for this call. */
  maxTurns?: number;
  /** Stream tokens to a callback. */
  onStream?: (chunk: { delta?: string }) => void;
  /** Override LLM provider for this call. */
  llm?: LlmProvider;
  /** Don't add this call's exchanges to the persistent history. */
  ephemeral?: boolean;
  /** Cancel this call from outside via an external AbortSignal. */
  signal?: AbortSignal;
  /** Images attached to the user message (requires vision-capable model). */
  images?: ImageContent[];
  /** Unused — typing parity. */
  _result?: T;
}

export interface SkillOptions<T = unknown> extends PromptOptions<T> {
  args?: Record<string, unknown>;
}

export interface TaskOptions<T = unknown> {
  payload?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  _result?: T;
}

export interface PromptUsage {
  in: number;
  out: number;
  /** Number of LLM calls aggregated. */
  calls: number;
}

export interface SessionInit {
  agentId: string;
  runId: string;
  /** Session name (defaults to "default"). */
  name?: string;
  model: string;
  llm?: LlmProvider;
  thinkingLevel?: ThinkingLevel;
  tools: LoopTool[];
  roles: Record<string, { instructions: string; model?: string; thinkingLevel?: ThinkingLevel }>;
  defaultRole?: string;
  skills: Record<string, Skill>;
  memory: Memory;
  env: SessionEnv;
  maxTurns?: number;
  compactionThreshold?: number;
  compactionModel?: string;
  history?: ChatMessage[];
  onToolCall?: (call: { name: string; args: unknown }) => void;
  onToolResult?: (call: { name: string; result: unknown; durationMs: number }) => void;
  onHistoryUpdate?: (history: ChatMessage[]) => void;
}

export class Session {
  private _history: ChatMessage[];
  private _usage: PromptUsage = { in: 0, out: 0, calls: 0 };
  private _busy = false;
  private readonly init: SessionInit;
  readonly name: string;

  constructor(init: SessionInit) {
    this.init = init;
    this.name = init.name ?? "default";
    this._history = init.history ? [...init.history] : [];
    if (this._history.length === 0) {
      const sys = this.buildSystem(init.defaultRole);
      if (sys) this._history.push({ role: "system", content: sys });
    }
  }

  get agentId(): string { return this.init.agentId; }
  get runId(): string { return this.init.runId; }
  get fs() { return this.init.env.fs; }
  /** Aggregated token usage across all calls on this session. */
  get usage(): PromptUsage { return { ...this._usage }; }

  history(): ChatMessage[] { return [...this._history]; }
  setHistory(h: ChatMessage[]): void {
    this._history = [...h];
    this.init.onHistoryUpdate?.(this._history);
  }

  /**
   * Delete this session's persisted state from memory. After delete(),
   * further calls will start with a fresh history.
   */
  async delete(): Promise<void> {
    await this.init.memory.delete(`session:${this.init.agentId}:${this.init.runId}`).catch(() => {});
    this._history = [];
    const sys = this.buildSystem(this.init.defaultRole);
    if (sys) this._history.push({ role: "system", content: sys });
  }

  // ─── prompt ────────────────────────────────────────────────────────────

  prompt<T = string>(text: string, opts: PromptOptions<T> = {}): CallHandle<T> {
    return makeCallHandle<T>(
      (signal) => this._runPrompt<T>(text, opts, signal),
      opts.signal,
    );
  }

  private async _runPrompt<T>(text: string, opts: PromptOptions<T>, signal: AbortSignal): Promise<T> {
    if (this._busy) throw new Error("Session is busy — start a separate session for parallel calls");
    this._busy = true;
    try {
      const result = opts.result ?? opts.schema;
      const messagesBefore = this._history.length;
      const userMsg: ChatMessage = { role: "user", content: text };
      if (opts.images?.length) userMsg.images = opts.images;
      this._history.push(userMsg);

      // Per-call role swap
      let systemSwapAt: number | undefined;
      if (opts.role && opts.role !== this.init.defaultRole) {
        const sys = this.buildSystem(opts.role);
        if (sys) {
          systemSwapAt = this._history.length - 1;
          this._history.splice(systemSwapAt, 0, { role: "system", content: sys });
        }
      }

      // Per-role frontmatter overrides
      const roleEntry = opts.role ? this.init.roles[opts.role] : undefined;
      const tools = this.mergeTools(opts.tools);
      const model = opts.model ?? roleEntry?.model ?? this.init.model;
      const { provider: provider0, model: modelId } = resolveProvider(model);
      const provider = opts.llm ?? this.init.llm ?? provider0;
      const thinkingLevel = opts.thinkingLevel ?? roleEntry?.thinkingLevel ?? this.init.thinkingLevel;
      const maxTurns = opts.maxTurns ?? this.init.maxTurns ?? 12;
      const responseSchema = result
        ? (zodToJsonSchema(result, { target: "openAi" }) as Record<string, unknown>)
        : undefined;

      const toolSchemas: ToolSchema[] = tools.map((t) => ({
        name: t.name, description: t.description, parameters: t.parameters,
      }));

      let final: unknown = "";
      const iii = iiiClient();

      for (let turn = 0; turn < maxTurns; turn++) {
        if (signal.aborted) throw new Error("aborted");
        await this.maybeCompact();

        const res = await provider.chat({
          model: modelId,
          messages: this._history,
          tools: toolSchemas.length ? toolSchemas : undefined,
          responseSchema,
          thinkingLevel,
          signal,
        });

        this._usage.in += res.usage.in;
        this._usage.out += res.usage.out;
        this._usage.calls += 1;

        this._history.push(res.message);
        this.init.onHistoryUpdate?.(this._history);

        if (opts.onStream && res.message.content) {
          opts.onStream({ delta: res.message.content });
        }

        const calls = res.message.tool_calls ?? [];
        if (calls.length === 0) {
          const text = res.message.content ?? "";
          if (result) {
            const parsed = extractJson(text);
            final = (result as ZodTypeAny).parse(parsed);
          } else {
            final = text;
          }
          break;
        }

        // Tool calls in parallel via iii
        const toolMap = new Map(tools.map((t) => [t.name, t]));
        const toolResults = await Promise.all(
          calls.map(async (tc) => {
            const tool = toolMap.get(tc.name);
            if (!tool) return { id: tc.id, content: `Error: unknown tool "${tc.name}"` };
            this.init.onToolCall?.({ name: tc.name, args: tc.args });
            const t0 = Date.now();
            try {
              const r = await iii.trigger({ function_id: tool.iiiFunctionId, payload: tc.args });
              const content = typeof r === "string" ? r : JSON.stringify(r);
              this.init.onToolResult?.({ name: tc.name, result: r, durationMs: Date.now() - t0 });
              return { id: tc.id, content };
            } catch (err: any) {
              const msg = `Error: ${String(err?.message ?? err)}`;
              this.init.onToolResult?.({ name: tc.name, result: msg, durationMs: Date.now() - t0 });
              return { id: tc.id, content: msg };
            }
          }),
        );
        for (const r of toolResults) {
          this._history.push({ role: "tool", tool_call_id: r.id, content: r.content });
        }
        this.init.onHistoryUpdate?.(this._history);

        if (turn === maxTurns - 1) throw new Error(`Session.prompt exceeded maxTurns=${maxTurns}`);
      }

      if (opts.ephemeral) {
        this._history = this._history.slice(0, messagesBefore);
        this.init.onHistoryUpdate?.(this._history);
      }

      return final as T;
    } finally {
      this._busy = false;
    }
  }

  // ─── skill ─────────────────────────────────────────────────────────────

  skill<T = string>(name: string, opts: SkillOptions<T> = {}): CallHandle<T> {
    const skill = this.init.skills[name];
    if (!skill) {
      const available = Object.keys(this.init.skills).join(", ") || "(none)";
      const err = new Error(`Skill "${name}" not found. Available: ${available}`);
      return makeCallHandle<T>(() => Promise.reject(err));
    }
    const rendered = renderSkill(skill.body, opts.args ?? {});
    return this.prompt<T>(rendered, opts);
  }

  // ─── task ──────────────────────────────────────────────────────────────

  /**
   * Optional sugar over `iii.trigger({function_id, payload, timeoutMs})`.
   * Wraps the result in a CallHandle (signal + abort). Identical to:
   *
   *   const result = await ctx.sdk.trigger({
   *     function_id: agentId, payload, timeoutMs,
   *   });
   *
   * Use `ctx.sdk.trigger(...)` directly for the unwrapped iii primitive.
   */
  task<T = unknown>(agentId: string, opts: TaskOptions<T> = {}): CallHandle<T> {
    return makeCallHandle<T>(
      async (_signal) => {
        const iii = iiiClient();
        return iii.trigger<unknown, T>({
          function_id: agentId,
          payload: opts.payload ?? {},
          timeoutMs: opts.timeoutMs,
        });
      },
      opts.signal,
    );
  }

  // ─── shell ─────────────────────────────────────────────────────────────

  shell(command: string, opts: ShellOptions = {}): CallHandle<ShellResult> {
    return makeCallHandle<ShellResult>(
      (_signal) => this.init.env.shell(command, opts),
      (opts as any).signal,
    );
  }

  // ─── compact ───────────────────────────────────────────────────────────

  async compact(): Promise<void> {
    if (this._busy) throw new Error("compact() while another operation is in flight");
    if (this._history.length < 6) return;
    const head = this._history.filter((m) => m.role === "system");
    const tail = this._history.slice(-4);
    const middle = this._history.slice(head.length, -4);
    if (middle.length === 0) return;

    const summary = await this.summarize(middle);
    this._history = [
      ...head,
      { role: "system", content: `[COMPACTION SUMMARY]\n${summary}` },
      ...tail,
    ];
    this.init.onHistoryUpdate?.(this._history);
  }

  private async maybeCompact(): Promise<void> {
    const threshold = this.init.compactionThreshold ?? 40;
    if (threshold > 0 && this._history.length > threshold) await this.compact();
  }

  private async summarize(messages: ChatMessage[]): Promise<string> {
    const text = messages
      .map((m) => `[${m.role}] ${m.content ?? "(tool call)"}`)
      .join("\n");
    const model = this.init.compactionModel ?? this.init.model;
    const { provider: p, model: m } = resolveProvider(model);
    const res = await (this.init.llm ?? p).chat({
      model: m,
      messages: [
        { role: "system", content: "Summarize in <300 words. Preserve concrete facts, tool results, decisions." },
        { role: "user", content: text },
      ],
    });
    this._usage.in += res.usage.in;
    this._usage.out += res.usage.out;
    return res.message.content ?? "";
  }

  // ─── helpers ───────────────────────────────────────────────────────────

  private buildSystem(roleName?: string): string | undefined {
    if (!roleName) return undefined;
    return this.init.roles[roleName]?.instructions;
  }

  private mergeTools(extra?: LoopTool[]): LoopTool[] {
    if (!extra?.length) return this.init.tools;
    const seen = new Set(this.init.tools.map((t) => t.name));
    const merged = [...this.init.tools];
    for (const t of extra) {
      if (!seen.has(t.name)) { merged.push(t); seen.add(t.name); }
    }
    return merged;
  }
}

// ─── Harness + Sessions registry ────────────────────────────────────────────

export interface SessionOptions {
  /** Session-wide default role. */
  role?: string;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  constructor(
    private readonly newSession: (name: string, opts?: SessionOptions) => Session,
  ) {}

  async get(name: string = "default", opts?: SessionOptions): Promise<Session> {
    const existing = this.sessions.get(name);
    if (existing) return existing;
    const fresh = this.newSession(name, opts);
    this.sessions.set(name, fresh);
    return fresh;
  }

  async create(name: string = "default", opts?: SessionOptions): Promise<Session> {
    if (this.sessions.has(name)) throw new Error(`Session "${name}" already exists`);
    const fresh = this.newSession(name, opts);
    this.sessions.set(name, fresh);
    return fresh;
  }

  async delete(name: string = "default"): Promise<void> {
    const s = this.sessions.get(name);
    if (s) await s.delete();
    this.sessions.delete(name);
  }

  list(): string[] {
    return [...this.sessions.keys()];
  }
}

export interface Harness {
  readonly name: string;
  /** Default session — created on first access. */
  session(name?: string, opts?: SessionOptions): Promise<Session>;
  /** Explicit registry for multi-session use. */
  readonly sessions: SessionRegistry;
  /** Shell exec in the harness sandbox without recording in a conversation. */
  shell(command: string, opts?: ShellOptions): CallHandle<ShellResult>;
  /** File ops in the harness sandbox without recording in a conversation. */
  readonly fs: SessionEnv["fs"];
}

function extractJson(text: string): unknown {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) { try { return JSON.parse(fence[1]); } catch {} }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error(`Model response did not contain JSON: ${text.slice(0, 300)}`);
}
