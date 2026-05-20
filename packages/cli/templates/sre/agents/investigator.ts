import { z } from "zod";
import { defineAgent } from "@snoopy/core";
import { kubectl } from "../tools/kubectl.js";
import { gitLog } from "../tools/git.js";

/**
 * Deep-dive investigator. Called synchronously from triage via `ctx.call`
 * when triage decides it needs more context before deciding severity.
 *
 * Returns structured findings so the parent (triage) can use them in its
 * final result.
 */
export const investigator = defineAgent({
  id: "sre.investigator",
  role: "post-mortem",
  model: "openai/gpt-5-mini",
  tools: [kubectl, gitLog],
  result: z.object({
    findings: z.array(z.string()),
    suspectCommits: z.array(z.string()),
  }),
  prompt: (
    input: { service: string; window: string; parentRunId?: string },
    ctx,
  ) => {
    return [
      `Deep-dive investigation for service=${input.service} window=${input.window}.`,
      "",
      "1. Pull recent pod logs and event history for the service.",
      "2. Check git log for changes in the last 24h that touch this service.",
      "3. Append findings to memory key:",
      `   incident:${input.parentRunId ?? ctx.runId}:timeline`,
    ].join("\n");
  },
});
