/**
 * StateKV — optional typed sugar over iii's `state::*` primitives.
 *
 * The iii.dev founder's position: wrapping iii primitives is NOT required.
 * The standard way to use state is to install `iii worker add iii-state`
 * and then call it directly:
 *
 *   await sdk.trigger({
 *     function_id: "state::set",
 *     payload: { scope, key, value },
 *   });
 *
 * This class is one-line-per-call typed sugar — autocomplete and generics
 * for TS users. It adds no behavior. You lose nothing by skipping it and
 * calling `sdk.trigger(...)` directly.
 *
 * Pattern reference: rohitg00/agentmemory's `src/state/kv.ts`.
 */
import type { ISdk } from "iii-sdk";

/** Atomic mutation ops supported by iii's `state::update`. */
export type StateUpdateOp =
  | { type: "set"; path: string; value: unknown }
  | { type: "append"; path: string; value: unknown }
  | { type: "increment"; path: string; value: number }
  | { type: "delete"; path: string }
  | { type: "merge"; path: string; value: Record<string, unknown> };

export class StateKV {
  constructor(private readonly sdk: ISdk) {}

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    try {
      const res = await this.sdk.trigger<{ scope: string; key: string }, any>({
        function_id: "state::get",
        payload: { scope, key },
      });
      // Engine returns the value at `.value` in some versions, raw in others.
      const v = res?.value ?? res;
      return (v ?? null) as T | null;
    } catch (err: any) {
      if (/not.*found|no.*value|does not exist/i.test(String(err?.message ?? err))) {
        return null;
      }
      throw err;
    }
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return this.sdk.trigger<{ scope: string; key: string; value: T }, T>({
      function_id: "state::set",
      payload: { scope, key, value },
    });
  }

  /**
   * Atomic mutation. Engine applies ops in order; concurrent updaters
   * don't clobber each other. Prefer this over read-modify-write for
   * counters, lists, and nested object patches.
   */
  async update<T = unknown>(
    scope: string,
    key: string,
    ops: StateUpdateOp[],
  ): Promise<T> {
    return this.sdk.trigger<
      { scope: string; key: string; ops: StateUpdateOp[] },
      T
    >({
      function_id: "state::update",
      payload: { scope, key, ops },
    });
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.sdk.trigger<{ scope: string; key: string }, void>({
      function_id: "state::delete",
      payload: { scope, key },
    }).catch(() => {}); // delete-missing is a no-op
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    try {
      const res = await this.sdk.trigger<{ scope: string }, T[] | { items: T[] }>({
        function_id: "state::list",
        payload: { scope },
      });
      if (Array.isArray(res)) return res;
      if (res && typeof res === "object" && Array.isArray((res as any).items)) {
        return (res as any).items;
      }
      return [];
    } catch {
      return [];
    }
  }
}
