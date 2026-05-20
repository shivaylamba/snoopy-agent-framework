/**
 * Optional typed sugar over iii's `state::*` primitives — NOT required.
 *
 * Prefer calling iii directly:
 *
 *   await sdk.trigger({ function_id: "state::set",
 *                       payload: { scope, key, value } });
 *
 * That's what `iii worker add iii-state` enables. This class exists only
 * for TypeScript users who prefer typed `get<T>()` / `set<T>()` autocomplete
 * over stringly-typed function ids. The iii.dev founder's position is that
 * wrapping should not be required — and it isn't.
 *
 * The wrapper is one method per call; you lose nothing by not using it.
 */
import { iiiClient } from "./iiiClient.js";

export class IIIState {
  constructor(private readonly scope: string = "snoopy") {}

  async set<T>(key: string, value: T): Promise<void> {
    const iii = iiiClient();
    await iii.trigger({
      function_id: "state::set",
      payload: { scope: this.scope, key, value: value as any },
    });
  }

  async get<T>(key: string): Promise<T | undefined> {
    const iii = iiiClient();
    try {
      const res = await iii.trigger<unknown, { value: T | null }>({
        function_id: "state::get",
        payload: { scope: this.scope, key },
      });
      return (res?.value ?? undefined) as T | undefined;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/not.*found|no.*value|does not exist/i.test(msg)) return undefined;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    const iii = iiiClient();
    await iii.trigger({
      function_id: "state::delete",
      payload: { scope: this.scope, key },
    });
  }
}
