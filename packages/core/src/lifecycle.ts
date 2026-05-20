/**
 * Worker lifecycle helpers — production patterns from agentmemory.
 *
 * Use at the top of your worker entry script:
 *
 *   import { installLifecycleHandlers, flushBootLog } from "@snoopy/core";
 *   installLifecycleHandlers();
 *
 *   // ... defineAgent calls ...
 *
 *   flushBootLog();              // prints the buffered startup banner
 *
 * Without these, a long-running iii worker eventually crashes from
 * unhandled rejections caused by transient `state::set` timeouts under
 * load (agentmemory issue #204).
 */
import type { ISdk } from "iii-sdk";
import { flushBootLog } from "./bootLog.js";

let unhandledThrottle = 0;
const UNHANDLED_LOG_INTERVAL_MS = 60_000;

export interface LifecycleHandlersOpts {
  /** Receive notice when SIGINT/SIGTERM fires; do your saves, then return. */
  onShutdown?: () => Promise<void> | void;
  /** iii SDK instance to call `.shutdown()` on. Provide if you have one. */
  sdk?: ISdk;
}

/**
 * Install:
 *   - Throttled `unhandledRejection` handler (long-running workers survive
 *     transient state::set timeouts without dying).
 *   - SIGINT / SIGTERM graceful shutdown that calls your `onShutdown`,
 *     awaits any registered cleanups, and `sdk.shutdown()`s before exit.
 *
 * Idempotent — calling twice does the right thing.
 */
let installed = false;
const cleanups: Array<() => Promise<void> | void> = [];

export function onWorkerShutdown(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

export function installLifecycleHandlers(opts: LifecycleHandlersOpts = {}): void {
  if (installed) return;
  installed = true;

  if (opts.onShutdown) cleanups.push(opts.onShutdown);

  process.on("unhandledRejection", (reason) => {
    const now = Date.now();
    if (now - unhandledThrottle < UNHANDLED_LOG_INTERVAL_MS) return;
    unhandledThrottle = now;
    const r = reason as { code?: string; function_id?: string; message?: string };
    console.warn(
      "[snoopy] unhandledRejection (suppressed):",
      r?.code ? `${r.code} ${r.function_id ?? ""} ${r.message ?? ""}`.trim() : reason,
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[snoopy] ${signal} — shutting down…`);
    for (const c of cleanups) {
      try { await c(); } catch (e) { console.warn("[snoopy] cleanup failed:", e); }
    }
    if (opts.sdk && typeof (opts.sdk as any).shutdown === "function") {
      try { await (opts.sdk as any).shutdown(); } catch {}
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

export { flushBootLog };
