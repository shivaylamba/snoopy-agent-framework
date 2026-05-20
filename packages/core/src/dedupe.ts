import { createHash } from "node:crypto";

/**
 * Stable-stringified SHA-1 of a payload. Order-independent on objects so
 * `{a:1, b:2}` and `{b:2, a:1}` produce the same key — important for
 * webhooks that may reorder JSON fields between deliveries.
 */
export function defaultDedupeKey(payload: unknown): string {
  return createHash("sha1").update(stableStringify(payload)).digest("hex");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as object).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((v as any)[k]))
      .join(",") +
    "}"
  );
}
