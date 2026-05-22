/**
 * Tiny helpers the kernel uses for session/dedupe/tool-cache persistence.
 * Each one is literally a single `sdk.trigger({function_id: "state::*"})`
 * call — NO Memory wrapper involved.
 *
 * Why these exist as helpers: the kernel writes to state in 4-5 hot paths
 * (dedupe gate, history persistence, tool replay) and DRY beats inlining
 * the same 4-line trigger payload everywhere. But the helpers themselves
 * are zero-abstraction: they exist to call iii primitives, not to wrap
 * them. User code never sees these — they're internal.
 *
 * If you want this surface from user code, use `ctx.iii.trigger` directly.
 */
import type { ISdk } from "iii-sdk";

const SCOPE = "snoopy";

/** Set with optional client-side TTL envelope. */
export async function stateSet<T>(
  sdk: ISdk,
  key: string,
  value: T,
  ttlSec?: number,
): Promise<void> {
  const envelope = ttlSec
    ? { v: value, expiresAt: Date.now() + ttlSec * 1000 }
    : { v: value };
  await sdk.trigger({
    function_id: "state::set",
    payload: { scope: SCOPE, key, value: envelope as any },
  });
}

/** Get; respects the client-side TTL envelope. */
export async function stateGet<T>(sdk: ISdk, key: string): Promise<T | undefined> {
  try {
    const res = await sdk.trigger<unknown, any>({
      function_id: "state::get",
      payload: { scope: SCOPE, key },
    });
    const v = res?.value;
    if (v === null || v === undefined) return undefined;
    if (typeof v === "object" && v !== null && "v" in (v as object)) {
      const env = v as { v: T; expiresAt?: number };
      if (env.expiresAt && env.expiresAt < Date.now()) {
        await stateDelete(sdk, key).catch(() => {});
        return undefined;
      }
      return env.v;
    }
    return v as T;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/not.*found|no.*value|does not exist/i.test(msg)) return undefined;
    throw e;
  }
}

export async function stateDelete(sdk: ISdk, key: string): Promise<void> {
  await sdk.trigger({
    function_id: "state::delete",
    payload: { scope: SCOPE, key },
  }).catch(() => {});
}
