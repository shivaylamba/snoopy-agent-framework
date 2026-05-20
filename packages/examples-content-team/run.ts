// Entry point — register the team on iii, hook traces to Postgres, keep alive.
import {
  addTraceSink,
  PgTraceStore,
  bootLog,
  flushBootLog,
  installLifecycleHandlers,
  iiiClient,
  onWorkerShutdown,
} from "@snoopy/core";

bootLog("starting content-team worker");

const pg = new PgTraceStore();
addTraceSink(pg);
bootLog("PgTraceStore sink registered");

const sdk = iiiClient();
installLifecycleHandlers({ sdk });
onWorkerShutdown(async () => {
  await pg.close().catch(() => {});
});

await import("./snoopy.config.js" as string).catch(() =>
  import("./snoopy.config.ts" as string),
);

bootLog("6 agents registered: topic-extract, serp-analyze, brief, audit, section-edits, workflow");
bootLog("trigger via:  iii trigger content.workflow --json '{...}'");
bootLog("HTTP:        POST http://localhost:3111/api/triggers/http/content-seo");
flushBootLog();

await new Promise(() => {});
