/**
 * The reasoning loop — pure code, no Flue, no pi-ai.
 *
 *   1. Build the messages array from system prompt + user prompt + prior history
 *   2. Call the LLM with the tool schemas
 *   3. If the response has tool_calls:
 *        - For each, invoke the corresponding iii function via iii.trigger
 *        - Append the result as a tool message
 *        - Loop back to step 2
 *   4. Otherwise, return the final assistant message
 *
 * Tools are called over iii. That means a tool registered by Worker A can be
 * called by an agent running on Worker B — distribution comes for free.
 */
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { resolveProvider, type ChatMessage, type LlmProvider, type ToolSchema } from "./llm.js";
import { iiiClient } from "./iiiClient.js";

export interface LoopTool {
  /** Tool name as the model sees it. */
  name: string;
  description: string;
  /** JSON Schema for tool input. */
  parameters: Record<string, unknown>;
  /**
   * iii function id to invoke. Defaults to the tool name itself, since
   * defineTool registers each tool as `<agentId>::tool::<name>`.
   */
  iiiFunctionId: string;
  /** Hint to the loop / span emitter. */
  idempotent?: boolean;
}

export interface LoopOpts {
  /** Model id like "openai/gpt-5-mini" or "anthropic/claude-sonnet-4-5". */
  model: string;
  /** Override the LLM provider entirely (custom adapters). */
  llm?: LlmProvider;
  systemPrompt: string;
  userPrompt: string;
  tools: LoopTool[];
  /** Optional structured-output schema. */
  resultSchema?: ZodTypeAny;
  /** Max LLM turns before bailing (each tool call = one turn). */
  maxTurns?: number;
  /** Per-tool-call instrumentation hook. */
  onToolCall?: (call: { name: string; args: unknown }) => void;
  onToolResult?: (call: { name: string; result: unknown; durationMs: number }) => void;
  onTurn?: (turn: { index: number; usage: { in: number; out: number } }) => void;
  /** Prior conversation to resume from. */
  history?: ChatMessage[];
  /** Receives the final history (for persistence by the caller). */
  onHistoryUpdate?: (history: ChatMessage[]) => void;
}

export interface LoopResult<T = unknown> {
  /** Parsed structured output when `resultSchema` is set; else the raw text. */
  result: T;
  /** Total tokens across all turns. */
  usage: { in: number; out: number };
  /** Final message history (write to memory for retry-resume). */
  history: ChatMessage[];
  /** Number of LLM turns taken. */
  turns: number;
}

export async function runLoop<T = unknown>(opts: LoopOpts): Promise<LoopResult<T>> {
  const { provider: provider0, model } = resolveProvider(opts.model);
  const provider = opts.llm ?? provider0;
  const maxTurns = opts.maxTurns ?? 12;

  const toolSchemas: ToolSchema[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const responseSchema = opts.resultSchema
    ? zodToJsonSchemaSafe(opts.resultSchema)
    : undefined;

  let history: ChatMessage[] = opts.history ? [...opts.history] : [
    { role: "system", content: opts.systemPrompt },
  ];
  if (!opts.history) {
    history.push({ role: "user", content: opts.userPrompt });
  }

  let usage = { in: 0, out: 0 };
  const iii = iiiClient();

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await provider.chat({
      model,
      messages: history,
      tools: toolSchemas.length ? toolSchemas : undefined,
      responseSchema: turn === 0 ? undefined : responseSchema, // first turn may need to call tools first
    });

    usage.in += res.usage.in;
    usage.out += res.usage.out;
    opts.onTurn?.({ index: turn, usage: res.usage });

    history.push(res.message);
    opts.onHistoryUpdate?.(history);

    const calls = res.message.tool_calls ?? [];
    if (calls.length === 0) {
      // No more tool calls — terminal turn.
      const text = res.message.content ?? "";

      if (opts.resultSchema) {
        const parsed = extractJson(text);
        const validated = opts.resultSchema.parse(parsed) as T;
        return { result: validated, usage, history, turns: turn + 1 };
      }
      return { result: text as T, usage, history, turns: turn + 1 };
    }

    // Execute each tool call over iii in parallel.
    const toolMap = new Map(opts.tools.map((t) => [t.name, t]));
    const results = await Promise.all(
      calls.map(async (tc) => {
        const tool = toolMap.get(tc.name);
        if (!tool) {
          return { id: tc.id, content: `Error: unknown tool "${tc.name}"` };
        }
        opts.onToolCall?.({ name: tc.name, args: tc.args });
        const t0 = Date.now();
        try {
          const result = await iii.trigger({
            function_id: tool.iiiFunctionId,
            payload: tc.args,
          });
          const content = typeof result === "string" ? result : JSON.stringify(result);
          opts.onToolResult?.({ name: tc.name, result, durationMs: Date.now() - t0 });
          return { id: tc.id, content };
        } catch (err: any) {
          const msg = `Error: ${String(err?.message ?? err)}`;
          opts.onToolResult?.({ name: tc.name, result: msg, durationMs: Date.now() - t0 });
          return { id: tc.id, content: msg };
        }
      }),
    );

    for (const r of results) {
      history.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
    opts.onHistoryUpdate?.(history);
  }

  throw new Error(`Reasoning loop exceeded maxTurns=${maxTurns}`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function extractJson(text: string): unknown {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) { try { return JSON.parse(fence[1]); } catch {} }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error(`Model response did not contain JSON: ${text.slice(0, 300)}`);
}

function zodToJsonSchemaSafe(schema: ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { target: "openAi" }) as Record<string, unknown>;
}
