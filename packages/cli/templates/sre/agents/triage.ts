import { z } from "zod";
import { defineAgent, defineTrigger } from "@snoopy/core";
import { kubectl } from "../tools/kubectl.js";
import { prometheus } from "../tools/prometheus.js";

export const triage = defineAgent({
  id: "sre.triage",
  role: "sre-triage", // → roles/sre-triage.md or .agents/skills/sre-triage.md
  model: "openai/gpt-5-mini",
  tools: [kubectl, prometheus],
  triggers: [
    defineTrigger.webhook({ path: "/alerts/pagerduty" }),
    defineTrigger.http({ path: "/debug/triage", method: "POST" }),
  ],
  // Dedupe duplicate webhook deliveries within 5 minutes. PagerDuty
  // sometimes redelivers on its own retry policy.
  dedupeTtlSec: 300,
  result: z.object({
    severity: z.enum(["sev1", "sev2", "sev3"]),
    suspectedRootCause: z.string(),
    recommendedAction: z.string(),
    spawnFixer: z.boolean(),
  }),
  prompt: (alert: { service?: string; msg?: string }, ctx) => {
    void ctx.memory.append(`incident:${ctx.runId}:timeline`, {
      step: "alert_received",
      alert,
    });
    return [
      "An alert just fired. Triage it:",
      "",
      JSON.stringify(alert, null, 2),
      "",
      "1. Inspect the affected service's pods (kubectl).",
      "2. Check 5xx and latency rates (prometheus).",
      "3. Decide severity and whether to spawn the fixer agent.",
      `Run id for memory keys: ${ctx.runId}.`,
    ].join("\n");
  },
});
