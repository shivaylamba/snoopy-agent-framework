import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defineTool, sandboxedExec } from "@snoopy/core";

const exec = promisify(execFile);

/**
 * Read-only kubectl. By default runs locally; set USE_SANDBOXED_TOOLS=1
 * to route through iii-sandbox (`sandbox::exec` Docker worker) for
 * isolation in production.
 */
export const kubectl = defineTool({
  name: "kubectl",
  description:
    "Read-only kubectl. Args are passed straight through. Always idempotent (read-only).",
  input: z.object({
    args: z
      .array(z.string())
      .describe(
        "kubectl args, e.g. ['get', 'pods', '-n', 'payments']. No mutating verbs.",
      ),
    namespace: z.string().optional(),
  }),
  idempotent: true,
  handler: async ({ args, namespace }) => {
    const banned = ["delete", "apply", "patch", "edit", "scale", "rollout"];
    if (args.some((a) => banned.includes(a))) {
      throw new Error(`kubectl tool is read-only; refusing mutating verb in: ${args.join(" ")}`);
    }
    const full = namespace ? ["-n", namespace, ...args] : args;

    if (process.env.USE_SANDBOXED_TOOLS === "1") {
      const r = await sandboxedExec({
        command: ["kubectl", ...full],
        backend: "docker",
        image: "bitnami/kubectl:latest",
        timeoutMs: 15_000,
      });
      if (r.exitCode !== 0) return { error: r.stderr || `exit ${r.exitCode}` };
      return { stdout: r.stdout.slice(0, 32_000) };
    }

    try {
      const { stdout } = await exec("kubectl", full, { maxBuffer: 1024 * 1024 });
      return { stdout: stdout.slice(0, 32_000) };
    } catch (err: any) {
      return { error: String(err?.stderr ?? err) };
    }
  },
});
