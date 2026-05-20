/**
 * Direct LLM client — OpenAI + Anthropic via fetch. No pi-ai, no Flue, no
 * heavyweight SDK. We need exactly:
 *
 *   - chat completion with tool definitions
 *   - tool-call response parsing
 *   - JSON-mode / structured output
 *
 * That's small enough to write once and own forever.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** Reasoning effort forwarded to providers that support it. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ImageContent =
  | { type: "url"; url: string }
  | { type: "base64"; mediaType: string; data: string };

export interface ToolCall {
  /** Provider-issued id that pairs with the tool result message. */
  id: string;
  name: string;
  /** Already-parsed JSON args (model emits a string; we parse here). */
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  /** Present on assistant messages when the model wants to call tools. */
  tool_calls?: ToolCall[];
  /** Present on tool messages — pairs with `ToolCall.id`. */
  tool_call_id?: string;
  /** Images attached to this message. Requires a vision-capable model. */
  images?: ImageContent[];
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  /** OpenAI-style JSON Schema for structured output. */
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  /** Reasoning effort. Silently ignored by non-reasoning models. */
  thinkingLevel?: ThinkingLevel;
  /** Stream chunks instead of waiting for the full response. */
  stream?: boolean;
  /** Forwarded to fetch; cancel the request mid-flight. */
  signal?: AbortSignal;
}

export interface ChatResponse {
  message: ChatMessage;
  usage: { in: number; out: number };
  stopReason: "stop" | "tool_calls" | "length" | "other";
}

/** Streamed event from a streaming chat. */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call_partial"; index: number; name?: string; argsDelta?: string; id?: string }
  | { type: "done"; message: ChatMessage; usage: { in: number; out: number }; stopReason: ChatResponse["stopReason"] };

export interface LlmProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Optional — providers that don't support streaming will fall back. */
  chatStream?(req: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

// ─── OpenAI ─────────────────────────────────────────────────────────────────

export class OpenAIProvider implements LlmProvider {
  constructor(
    private readonly opts: {
      apiKey?: string;
      baseUrl?: string;
    } = {},
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = this.opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    const base = this.opts.baseUrl ?? "https://api.openai.com/v1";

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toOpenAIMessage),
      temperature: req.temperature,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }
    if (req.responseSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "result", schema: req.responseSchema, strict: false },
      };
    }
    if (req.thinkingLevel && req.thinkingLevel !== "off") {
      // OpenAI accepts `reasoning_effort` on `o*`/`gpt-5*` models.
      body.reasoning_effort = mapEffort(req.thinkingLevel);
    }

    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    const m = choice?.message ?? {};
    const toolCalls: ToolCall[] | undefined = m.tool_calls?.length
      ? m.tool_calls.map((tc: any) => ({
          id: tc.id,
          name: tc.function?.name,
          args: safeParse(tc.function?.arguments ?? "{}"),
        }))
      : undefined;

    // Some OpenAI-compatible providers (Nebius Kimi K2.6, DeepSeek thinking
    // variants, etc.) are reasoning models that put the actual answer in
    // `message.reasoning` and leave `message.content` null. Fall back so
    // structured-output callers don't get an empty string.
    const content =
      m.content ?? (typeof m.reasoning === "string" ? m.reasoning : null);

    return {
      message: {
        role: "assistant",
        content,
        tool_calls: toolCalls,
      },
      usage: {
        in: data.usage?.prompt_tokens ?? 0,
        out: data.usage?.completion_tokens ?? 0,
      },
      stopReason: mapStopReason(choice?.finish_reason),
    };
  }
}

// Streaming added on the OpenAIProvider class via prototype patch below to
// avoid splitting the class definition.
(OpenAIProvider.prototype as any).chatStream = async function* (req: ChatRequest) {
  // Build a request mirroring this.chat but with stream: true.
  const self = this as any;
  const apiKey = self.opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const base = self.opts.baseUrl ?? "https://api.openai.com/v1";

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map(toOpenAIMessage),
    temperature: req.temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.responseSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "result", schema: req.responseSchema, strict: false },
    };
  }
  if (req.thinkingLevel && req.thinkingLevel !== "off") {
    body.reasoning_effort = mapEffort(req.thinkingLevel);
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 500)}`);
  }

  // SSE parser. OpenAI sends `data: {...}\n\n` events terminated by `data: [DONE]`.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCallAccum = new Map<number, { id?: string; name?: string; args: string }>();
  let usage = { in: 0, out: 0 };
  let stopReason: ChatResponse["stopReason"] = "other";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const chunk of buffer.split("\n\n")) {
      if (!chunk.startsWith("data: ")) continue;
      const data = chunk.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const evt = JSON.parse(data) as any;
        const choice = evt.choices?.[0];
        if (choice?.delta?.content) {
          content += choice.delta.content;
          yield { type: "delta" as const, text: choice.delta.content };
        }
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            const acc = toolCallAccum.get(idx) ?? { args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolCallAccum.set(idx, acc);
            yield {
              type: "tool_call_partial" as const,
              index: idx,
              name: tc.function?.name,
              argsDelta: tc.function?.arguments,
              id: tc.id,
            };
          }
        }
        if (choice?.finish_reason) {
          stopReason = mapStopReason(choice.finish_reason);
        }
        if (evt.usage) {
          usage = { in: evt.usage.prompt_tokens ?? 0, out: evt.usage.completion_tokens ?? 0 };
        }
      } catch {
        // ignore malformed event
      }
    }
    // Re-buffer any partial trailing chunk
    const lastSep = buffer.lastIndexOf("\n\n");
    buffer = lastSep === -1 ? buffer : buffer.slice(lastSep + 2);
  }

  const tool_calls = [...toolCallAccum.values()]
    .filter((a) => a.name)
    .map((a) => ({ id: a.id ?? "", name: a.name!, args: safeParse(a.args || "{}") }));

  yield {
    type: "done" as const,
    message: {
      role: "assistant" as const,
      content: content || null,
      tool_calls: tool_calls.length ? tool_calls : undefined,
    },
    usage,
    stopReason,
  };
};

function mapEffort(level: ThinkingLevel): string | undefined {
  switch (level) {
    case "minimal": return "minimal";
    case "low":     return "low";
    case "medium":  return "medium";
    case "high":    return "high";
    case "xhigh":   return "high"; // OpenAI tops at "high"
    default:        return undefined;
  }
}

function toOpenAIMessage(m: ChatMessage): any {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.content ?? "" };
  }
  // Images: turn content into an array of parts (text + image_url parts).
  if (m.images?.length) {
    const parts: any[] = [];
    if (m.content) parts.push({ type: "text", text: m.content });
    for (const img of m.images) {
      const url = img.type === "url" ? img.url : `data:${img.mediaType};base64,${img.data}`;
      parts.push({ type: "image_url", image_url: { url } });
    }
    return { role: m.role, content: parts };
  }
  const out: any = { role: m.role, content: m.content };
  if (m.tool_calls?.length) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
    out.content = m.content ?? null;
  }
  return out;
}

function mapStopReason(r: string | undefined): ChatResponse["stopReason"] {
  switch (r) {
    case "stop":       return "stop";
    case "tool_calls": return "tool_calls";
    case "length":     return "length";
    default:           return "other";
  }
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}

// ─── Anthropic ──────────────────────────────────────────────────────────────

export class AnthropicProvider implements LlmProvider {
  constructor(
    private readonly opts: {
      apiKey?: string;
      baseUrl?: string;
    } = {},
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const apiKey = this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    const base = this.opts.baseUrl ?? "https://api.anthropic.com/v1";

    // Anthropic splits out the system message.
    const sys = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .filter(Boolean)
      .join("\n\n");

    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map(toAnthropicMessage);

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: 4096,
      messages,
      ...(sys ? { system: sys } : {}),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
    };

    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as any;
    const blocks: any[] = data.content ?? [];
    let text = "";
    const tool_calls: ToolCall[] = [];
    for (const b of blocks) {
      if (b.type === "text") text += b.text;
      else if (b.type === "tool_use") {
        tool_calls.push({ id: b.id, name: b.name, args: b.input ?? {} });
      }
    }
    return {
      message: {
        role: "assistant",
        content: text || null,
        tool_calls: tool_calls.length ? tool_calls : undefined,
      },
      usage: {
        in: data.usage?.input_tokens ?? 0,
        out: data.usage?.output_tokens ?? 0,
      },
      stopReason:
        data.stop_reason === "tool_use" ? "tool_calls"
        : data.stop_reason === "max_tokens" ? "length"
        : data.stop_reason === "end_turn" ? "stop"
        : "other",
    };
  }
}

function toAnthropicMessage(m: ChatMessage): any {
  if (m.role === "tool") {
    return {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content ?? "" },
      ],
    };
  }
  if (m.role === "assistant" && m.tool_calls?.length) {
    const blocks: any[] = [];
    if (m.content) blocks.push({ type: "text", text: m.content });
    for (const tc of m.tool_calls) {
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
    }
    return { role: "assistant", content: blocks };
  }
  // Images
  if (m.images?.length) {
    const blocks: any[] = [];
    for (const img of m.images) {
      if (img.type === "url") {
        blocks.push({ type: "image", source: { type: "url", url: img.url } });
      } else {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.data },
        });
      }
    }
    if (m.content) blocks.push({ type: "text", text: m.content });
    return { role: m.role, content: blocks };
  }
  return { role: m.role, content: m.content ?? "" };
}

// ─── Provider router ────────────────────────────────────────────────────────

/**
 * Pick a provider from a `provider/model-id` string. Returns the configured
 * provider plus the stripped model id. Throws on unknown providers.
 *
 * Built-in providers:
 *   - openai     ── OpenAI Chat Completions
 *   - anthropic  ── Anthropic Messages
 *   - nebius     ── Nebius AI Studio (OpenAI-compatible at api.studio.nebius.com)
 *
 * For others (Groq, OpenRouter, Mistral, Together, etc.), install
 * `@snoopy/llm-pi-ai` and pass `llm: new PiAiProvider()` to defineAgent.
 *
 * For full iii-native: `iii worker add provider-openai` / `provider-anthropic`
 * and call them as iii functions directly — no provider class needed.
 */
export function resolveProvider(modelId: string): {
  provider: LlmProvider;
  model: string;
} {
  const [providerName, ...rest] = modelId.split("/");
  const model = rest.join("/");
  if (!providerName || !model) {
    throw new Error(`Invalid model id "${modelId}". Expected "provider/model-id".`);
  }
  switch (providerName) {
    case "openai":
      return { provider: new OpenAIProvider(), model };
    case "anthropic":
      return { provider: new AnthropicProvider(), model };
    case "nebius":
      // Nebius is OpenAI-compatible — reuse the OpenAI provider with a
      // different base URL and the Nebius API key.
      return {
        provider: new OpenAIProvider({
          apiKey: process.env.NEBIUS_API_KEY,
          baseUrl: "https://api.studio.nebius.com/v1",
        }),
        model,
      };
    default:
      throw new Error(
        `Unsupported provider "${providerName}". Built in: openai, anthropic, nebius. ` +
        `For others, use @snoopy/llm-pi-ai or call the provider-* iii worker directly.`,
      );
  }
}
