/**
 * PiAiProvider — adapt @earendil-works/pi-ai to snoopy's LlmProvider.
 *
 * Opt-in. Drop into any defineAgent({...}) call:
 *
 *   import { PiAiProvider } from "@snoopy/llm-pi-ai";
 *   defineAgent({
 *     id: "research.summarize",
 *     model: "google/gemini-2.5-pro",       // ← any of pi-ai's 30+ providers
 *     llm: new PiAiProvider(),
 *     ...
 *   });
 *
 * What you get over the built-in direct-fetch:
 *   - 30+ providers (anthropic, openai, google, vertex, bedrock, deepseek,
 *     xai, groq, cerebras, openrouter, mistral, fireworks, together,
 *     github-copilot, cloudflare-ai, azure-openai, and more)
 *   - Curated model catalog (context windows, tool support, reasoning maps)
 *   - Prompt caching for Anthropic + OpenAI cache-aware models
 *   - Per-provider quirk handling (stop reasons, thinking levels, images)
 *
 * What stays in @snoopy/core:
 *   - The reasoning loop (tool-calling via iii.trigger)
 *   - Memory, dedupe, tracing, dashboard, MCP server
 *   - Session, skills, compaction, structured output
 */
import { getModel, completeSimple, streamSimple } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent as PiImageContent,
  Message as PiMessage,
  TextContent as PiTextContent,
  ThinkingLevel as PiThinkingLevel,
  Tool as PiTool,
  ToolCall as PiToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ImageContent as SnoopyImageContent,
  LlmProvider,
  ThinkingLevel as SnoopyThinkingLevel,
  ToolCall,
} from "@snoopy/core";

export interface PiAiProviderOpts {
  /** Default `cacheRetention` for cache-aware providers. */
  cacheRetention?: "none" | "short" | "long";
  /** Default `sessionId` for session-scoped caching. */
  sessionId?: string;
  /** Apply to every call's `metadata` (Anthropic user_id etc.). */
  metadata?: Record<string, unknown>;
}

export class PiAiProvider implements LlmProvider {
  constructor(private readonly opts: PiAiProviderOpts = {}) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { provider, modelId } = parseModelId(req.model);
    const model = getModel(provider as any, modelId as any);
    const context = toPiContext(req);
    const reply = await completeSimple(model, context, {
      temperature: req.temperature,
      reasoning: toPiThinkingLevel(req.thinkingLevel),
      signal: req.signal,
      cacheRetention: this.opts.cacheRetention,
      sessionId: this.opts.sessionId,
      metadata: this.opts.metadata,
    });

    return assistantMessageToChatResponse(reply);
  }

  async *chatStream(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const { provider, modelId } = parseModelId(req.model);
    const model = getModel(provider as any, modelId as any);
    const context = toPiContext(req);
    const events = streamSimple(model, context, {
      temperature: req.temperature,
      reasoning: toPiThinkingLevel(req.thinkingLevel),
      signal: req.signal,
      cacheRetention: this.opts.cacheRetention,
      sessionId: this.opts.sessionId,
      metadata: this.opts.metadata,
    });

    // pi-ai emits an event stream of deltas + a final AssistantMessage.
    // We map text deltas to "delta" events and finalize with "done".
    let finalMessage: AssistantMessage | undefined;
    for await (const evt of events as AsyncIterable<any>) {
      // pi-ai event shape varies by phase. The common ones:
      if (evt?.type === "textDelta" && typeof evt.text === "string") {
        yield { type: "delta", text: evt.text };
      } else if (evt?.type === "toolCallDelta") {
        yield {
          type: "tool_call_partial",
          index: evt.index ?? 0,
          name: evt.name,
          argsDelta: evt.argumentsDelta ?? "",
          id: evt.id,
        };
      } else if (evt?.type === "assistantMessage" && evt.message) {
        finalMessage = evt.message as AssistantMessage;
      }
    }
    if (finalMessage) {
      const resp = assistantMessageToChatResponse(finalMessage);
      yield { type: "done", message: resp.message, usage: resp.usage, stopReason: resp.stopReason };
    }
  }
}

// ─── conversions ────────────────────────────────────────────────────────────

function parseModelId(s: string): { provider: string; modelId: string } {
  const [provider, ...rest] = s.split("/");
  if (!provider || rest.length === 0) {
    throw new Error(`Invalid model id "${s}". Expected "provider/model-id".`);
  }
  return { provider, modelId: rest.join("/") };
}

function toPiThinkingLevel(t: SnoopyThinkingLevel | undefined): PiThinkingLevel | undefined {
  if (!t || t === "off") return undefined;
  // Pi-ai's levels are minimal | low | medium | high | xhigh — same as ours.
  return t as PiThinkingLevel;
}

function toPiContext(req: ChatRequest): Context {
  let systemPrompt: string | undefined;
  const messages: PiMessage[] = [];

  for (const m of req.messages) {
    if (m.role === "system") {
      // Pi-ai pulls system into Context.systemPrompt (one or concatenated).
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${m.content ?? ""}` : (m.content ?? "");
      continue;
    }
    messages.push(toPiMessage(m));
  }

  const tools: PiTool[] | undefined = req.tools?.length
    ? req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        // pi-ai expects TypeBox TSchema; JSON Schema is structurally compatible.
        parameters: t.parameters as any,
      }))
    : undefined;

  return { systemPrompt, messages, tools };
}

function toPiMessage(m: ChatMessage): PiMessage {
  const ts = Date.now();
  if (m.role === "user") {
    const um: UserMessage = {
      role: "user",
      timestamp: ts,
      content: m.images?.length
        ? messageContentWithImages(m.content, m.images)
        : (m.content ?? ""),
    };
    return um;
  }
  if (m.role === "assistant") {
    const parts: any[] = [];
    if (m.content) parts.push({ type: "text", text: m.content } as PiTextContent);
    for (const tc of m.tool_calls ?? []) {
      const ptc: PiToolCall = {
        type: "toolCall",
        id: tc.id,
        name: tc.name,
        arguments: tc.args ?? {},
      };
      parts.push(ptc);
    }
    return {
      role: "assistant",
      timestamp: ts,
      content: parts,
      // The required-but-unused fields on AssistantMessage. We fill placeholders
      // for the round-trip; pi-ai only reads them when re-emitting.
      api: "openai-completions" as Api,
      provider: "openai",
      model: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
               cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
    };
  }
  // role === "tool"
  const tr: ToolResultMessage = {
    role: "toolResult",
    toolCallId: m.tool_call_id ?? "",
    toolName: "", // we don't track tool name on the snoopy side; pi-ai accepts ""
    content: [{ type: "text", text: m.content ?? "" }],
    isError: false,
    timestamp: ts,
  };
  return tr;
}

function messageContentWithImages(
  text: string | null,
  images: SnoopyImageContent[],
): (PiTextContent | PiImageContent)[] {
  const out: (PiTextContent | PiImageContent)[] = [];
  if (text) out.push({ type: "text", text });
  for (const img of images) {
    if (img.type === "base64") {
      out.push({ type: "image", data: img.data, mimeType: img.mediaType });
    } else {
      // pi-ai's ImageContent is base64-only. For URL images, the caller has to
      // fetch+encode first. Keep this lossy fallback: pass URL as text.
      out.push({ type: "text", text: `[image: ${img.url}]` });
    }
  }
  return out;
}

function assistantMessageToChatResponse(am: AssistantMessage): ChatResponse {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const part of am.content) {
    if (part.type === "text") text += part.text;
    else if (part.type === "toolCall") {
      toolCalls.push({ id: part.id, name: part.name, args: part.arguments ?? {} });
    }
    // thinking parts are dropped — they're for the next turn's continuity
    // and pi-ai handles that internally when we hand the message back.
  }
  return {
    message: {
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    },
    usage: { in: am.usage.input, out: am.usage.output },
    stopReason:
      am.stopReason === "toolUse" ? "tool_calls"
      : am.stopReason === "length" ? "length"
      : am.stopReason === "stop" ? "stop"
      : "other",
  };
}
