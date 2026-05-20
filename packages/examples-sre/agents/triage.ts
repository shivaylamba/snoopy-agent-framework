import { z } from "zod";
import { defineAgent, defineTrigger } from "@snoopy/core";
import { kubectl } from "../tools/kubectl.js";
import { prometheus } from "../tools/prometheus.js";

const TriageResult = z.object({
  severity: z.enum(["sev1", "sev2", "sev3"]),
  suspectedRootCause: z.string(),
  recommendedAction: z.string(),
  spawnFixer: z.boolean(),
  /** One-paragraph stakeholder summary, generated via a skill. */
  executiveSummary: z.string().optional(),
});

export const triage = defineAgent({
  id: "sre.triage",
  role: "sre-triage",
  model: "openai/gpt-5-mini",
  thinkingLevel: "medium",
  tools: [kubectl, prometheus],
  triggers: [
    defineTrigger.webhook({ path: "/alerts/pagerduty" }),
    defineTrigger.http({ path: "/debug/triage", method: "POST" }),
  ],
  dedupeTtlSec: 300,
  result: TriageResult,
  // Handler form — full control. Demonstrates session.prompt + session.skill.
  handler: async (alert: { service?: string; msg?: string }, ctx) => {
    void ctx.memory.append(`incident:${ctx.runId}:timeline`, {
      step: "alert_received",
      alert,
    });

    // 1. Triage classification with tools.
    const classification = await ctx.session.prompt<{
      severity: "sev1" | "sev2" | "sev3";
      suspectedRootCause: string;
      recommendedAction: string;
      spawnFixer: boolean;
    }>(
      [
        "An alert just fired. Triage it:",
        JSON.stringify(alert, null, 2),
        "",
        "1. Inspect pods (kubectl) and metrics (prometheus).",
        "2. Decide severity, root cause, action, and whether to spawn the fixer.",
        `Run id: ${ctx.runId}`,
      ].join("\n"),
      {
        result: z.object({
          severity: z.enum(["sev1", "sev2", "sev3"]),
          suspectedRootCause: z.string(),
          recommendedAction: z.string(),
          spawnFixer: z.boolean(),
        }),
      },
    );

    // 2. Stakeholder summary via skill (markdown-driven workflow).
    const summary = await ctx.session.skill<{ summary: string }>(
      "post-mortem-summary",
      {
        args: {
          service: alert.service ?? "unknown",
          severity: classification.severity,
          rootCause: classification.suspectedRootCause,
        },
        result: z.object({ summary: z.string() }),
        ephemeral: true, // don't pollute main convo with summary side-call
      },
    );

    return {
      ...classification,
      executiveSummary: summary.summary,
    };
  },
});
