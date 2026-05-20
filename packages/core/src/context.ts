// AgentContext is constructed inside defineAgent at invocation time and
// passed to the user's prompt() builder. It exposes the four things a user
// agent ever needs at runtime:
//
//   - runId    : stable across retries; use as a memory-key prefix
//   - memory   : durable KV + append-only streams
//   - emit     : drop a custom span into the trace
//   - spawn    : fire-and-forget a sub-agent (returns child invocation id)
//   - session  : the live Flue session (escape hatch for advanced users)
//
// The type is in types.ts to avoid an import cycle with defineAgent.ts.
export type { AgentContext } from "./types.js";
