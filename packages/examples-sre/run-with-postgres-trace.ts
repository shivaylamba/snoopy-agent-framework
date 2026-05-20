// Entry point with the full production-grade worker bootstrap:
//   - Postgres trace sink wired
//   - Lifecycle handlers (unhandledRejection survival, graceful shutdown)
//   - Boot logging buffered until ready
//
// This is the pattern lifted from rohitg00/agentmemory: every iii worker
// that runs longer than a few minutes needs all three.
import {
  addTraceSink,
  PgTraceStore,
  bootLog,
  flushBootLog,
  installLifecycleHandlers,
  iiiClient,
  onWorkerShutdown,
} from "@snoopy/core";

bootLog("starting SRE worker");

const pg = new PgTraceStore();
addTraceSink(pg);
bootLog("PgTraceStore sink registered");

const sdk = iiiClient();
installLifecycleHandlers({ sdk });
onWorkerShutdown(async () => {
  await pg.close().catch(() => {});
});

// Importing the agent config fires defineAgent() side effects which
// register functions + triggers on iii.
await import("./snoopy.config.js" as string).catch(() =>
  import("./snoopy.config.ts" as string),
);

bootLog("agents registered");
bootLog("worker ready");
flushBootLog();

await new Promise(() => {});
