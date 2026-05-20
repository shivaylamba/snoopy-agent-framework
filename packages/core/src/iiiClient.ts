import { registerWorker, type ISdk } from "iii-sdk";

let _iii: ISdk | undefined;

/** Override the singleton (mostly for tests). */
export function setIiiClient(sdk: ISdk): void {
  _iii = sdk;
}

/**
 * Singleton iii SDK instance with production-grade defaults.
 *
 * Pattern lifted from rohitg00/agentmemory: a long-running iii worker
 * needs explicit `invocationTimeoutMs` (180s default per agentmemory's
 * production tuning), worker-name pinning so OTel/metrics group runs
 * correctly, and telemetry metadata so dashboards group by project not
 * by hostname or cwd basename.
 */
export function iiiClient(): ISdk {
  if (!_iii) {
    const url = process.env.III_WS_URL ?? "ws://localhost:49134";
    const workerName =
      process.env.SNOOPY_WORKER_NAME ?? `snoopy-${process.pid}`;
    const projectName = process.env.SNOOPY_PROJECT_NAME ?? "snoopy";

    _iii = registerWorker(url, {
      workerName,
      invocationTimeoutMs: 180_000,
      otel: {
        serviceName: projectName,
        serviceVersion: process.env.SNOOPY_VERSION ?? "0.2.0",
        metricsExportIntervalMs: 60_000,
      },
      telemetry: {
        project_name: projectName,
        language: "node",
        framework: "snoopy",
      },
    });
  }
  return _iii;
}
