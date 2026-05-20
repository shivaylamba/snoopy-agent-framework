import { iiiClient } from "./iiiClient.js";

/**
 * Sandboxed shell execution via the iii-sandbox worker. Use inside tool
 * handlers when you want isolation between the agent's worker process and
 * the command being run.
 *
 *   import { defineTool, sandboxedExec } from "@snoopy/core";
 *
 *   export const kubectl = defineTool({
 *     name: "kubectl",
 *     input: z.object({ args: z.array(z.string()) }),
 *     handler: async ({ args }) => {
 *       const { stdout, exitCode } = await sandboxedExec({
 *         command: ["kubectl", ...args],
 *         backend: "docker",
 *         image: "bitnami/kubectl:latest",
 *         timeoutMs: 10_000,
 *       });
 *       if (exitCode !== 0) throw new Error(`kubectl failed (${exitCode})`);
 *       return stdout;
 *     },
 *   });
 *
 * Requires the iii-sandbox worker (https://github.com/iii-hq/sandbox) to be
 * running and connected to the same iii engine. It registers under the
 * function id `sandbox::exec` (Docker) and `sandbox::exec_firecracker`.
 */
export type SandboxBackend = "docker" | "firecracker";

export interface SandboxExecRequest {
  /** Argv-style command. First element is the executable. */
  command: string[];
  /** Backend. Defaults to docker (lower cold-start). */
  backend?: SandboxBackend;
  /** Container/microVM image. Falls back to a debian-slim default. */
  image?: string;
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Environment variables passed to the command. */
  env?: Record<string, string>;
  /** Hard wall-clock limit. Defaults to 30s. */
  timeoutMs?: number;
  /** Stdin string. */
  stdin?: string;
  /** File contents to write into the sandbox before exec. Map of path → text. */
  mounts?: Record<string, string>;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Wall-clock duration the sandbox reports. */
  durationMs?: number;
}

const DEFAULT_FUNCTIONS: Record<SandboxBackend, string> = {
  docker: "sandbox::exec",
  firecracker: "sandbox::exec_firecracker",
};

export async function sandboxedExec(
  req: SandboxExecRequest,
): Promise<SandboxExecResult> {
  const iii = iiiClient();
  const fn =
    DEFAULT_FUNCTIONS[req.backend ?? "docker"] ?? DEFAULT_FUNCTIONS.docker;

  const result = await iii.trigger<SandboxExecRequest, SandboxExecResult>({
    function_id: fn,
    payload: {
      ...req,
      timeoutMs: req.timeoutMs ?? 30_000,
      image: req.image ?? "debian:stable-slim",
    },
    timeoutMs: (req.timeoutMs ?? 30_000) + 5_000,
  });

  return result;
}
