import { z } from "zod";
import { defineAgent, defineTrigger } from "@snoopy/core";
import { gitDiff } from "../tools/git.js";

/**
 * Fired by an event trigger when triage emits `{ spawnFixer: true }`.
 * Proposes a minimal patch via gitDiff and a confidence score; never
 * applies the patch automatically.
 */
export const fixer = defineAgent({
  id: "sre.fixer",
  role: "post-mortem",
  model: "openai/gpt-5-mini",
  tools: [gitDiff],
  triggers: [
    defineTrigger.event({
      event: "triage.completed",
      filter: "$.spawnFixer == true",
    }),
  ],
  result: z.object({
    proposedDiff: z.string(),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  }),
  prompt: (
    input: { suspectedRootCause: string; service: string },
    ctx,
  ) => {
    return [
      `Triage flagged: ${input.suspectedRootCause}`,
      `Service: ${input.service}`,
      "",
      "1. Inspect the recent diff for this service.",
      "2. Propose a minimal patch that addresses the root cause.",
      "3. Include a confidence score and rationale.",
      `Run id: ${ctx.runId}`,
    ].join("\n");
  },
});
