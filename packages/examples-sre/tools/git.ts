import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defineTool } from "@snoopy/core";

const exec = promisify(execFile);

export const gitDiff = defineTool({
  name: "git_diff",
  description: "Show a diff between two refs in the current repository.",
  input: z.object({
    from: z.string().describe("Base ref, e.g. 'HEAD~5' or a tag"),
    to: z.string().default("HEAD"),
    path: z.string().optional(),
  }),
  idempotent: true,
  handler: async ({ from, to, path }) => {
    const args = ["diff", `${from}..${to}`];
    if (path) args.push("--", path);
    try {
      const { stdout } = await exec("git", args, { maxBuffer: 1024 * 1024 });
      return { diff: stdout.slice(0, 32_000) };
    } catch (err: any) {
      return { error: String(err?.stderr ?? err) };
    }
  },
});

export const gitLog = defineTool({
  name: "git_log",
  description: "Recent commits, optionally filtered by path.",
  input: z.object({
    limit: z.number().min(1).max(50).default(10),
    path: z.string().optional(),
  }),
  idempotent: true,
  handler: async ({ limit, path }) => {
    const args = ["log", `-${limit}`, "--pretty=format:%h %ad %s", "--date=iso"];
    if (path) args.push("--", path);
    const { stdout } = await exec("git", args, { maxBuffer: 1024 * 1024 });
    return { log: stdout };
  },
});
