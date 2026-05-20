/**
 * SessionEnv — pluggable sandbox/execution surface for `session.shell()`
 * and `session.fs`. Two built-in implementations:
 *
 *   - LocalSessionEnv: exec via node:child_process and node:fs in the
 *     worker process. Fast, zero-isolation. Default.
 *   - IIISandboxSessionEnv: route shell + fs ops through iii-sandbox's
 *     `sandbox::exec` / file ops functions. Isolated.
 *
 * Custom backends (Daytona, E2B, Modal, etc.) implement the same
 * interface and pass via `defineAgent({ sandbox: customEnv })`.
 */
import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, stat, mkdir, rm, readdir } from "node:fs/promises";
import { dirname } from "node:path";

const execAsync = promisify(cpExec);

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ShellOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: number;
}

export interface SessionFs {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  list(path: string): Promise<string[]>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
}

export interface SessionEnv {
  cwd: string;
  shell(command: string, options?: ShellOptions): Promise<ShellResult>;
  fs: SessionFs;
}

// ─── LocalSessionEnv ────────────────────────────────────────────────────────

export class LocalSessionEnv implements SessionEnv {
  constructor(public readonly cwd: string = process.cwd()) {}

  async shell(command: string, options: ShellOptions = {}): Promise<ShellResult> {
    const t0 = Date.now();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: options.cwd ?? this.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0, durationMs: Date.now() - t0 };
    } catch (err: any) {
      return {
        stdout: err?.stdout ?? "",
        stderr: err?.stderr ?? String(err?.message ?? err),
        exitCode: err?.code ?? 1,
        durationMs: Date.now() - t0,
      };
    }
  }

  readonly fs: SessionFs = {
    read: (p) => readFile(p, "utf-8"),
    write: async (p, content) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content);
    },
    exists: async (p) => { try { await stat(p); return true; } catch { return false; } },
    stat: async (p) => {
      const s = await stat(p);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        size: s.size,
        mtime: s.mtimeMs,
      };
    },
    list: async (p) => {
      const entries = await readdir(p);
      return entries;
    },
    rm: (p, opts) => rm(p, { recursive: opts?.recursive ?? false, force: true }),
  };
}

// ─── IIISandboxSessionEnv ───────────────────────────────────────────────────

import { sandboxedExec, type SandboxBackend } from "./sandbox.js";

export class IIISandboxSessionEnv implements SessionEnv {
  constructor(
    public readonly cwd: string = "/workspace",
    private readonly backend: SandboxBackend = "docker",
    private readonly image: string = "debian:stable-slim",
  ) {}

  async shell(command: string, options: ShellOptions = {}): Promise<ShellResult> {
    const r = await sandboxedExec({
      command: ["sh", "-c", command],
      backend: this.backend,
      image: this.image,
      cwd: options.cwd ?? this.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 30_000,
    });
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs: r.durationMs ?? 0,
    };
  }

  // FS via sandbox shell helpers — coarse but functional. For high-volume
  // fs ops, mount a volume and read directly on the host instead.
  readonly fs: SessionFs = {
    read: async (p) => {
      const r = await this.shell(`cat ${shellEscape(p)}`);
      if (r.exitCode !== 0) throw new Error(`fs.read: ${r.stderr}`);
      return r.stdout;
    },
    write: async (p, content) => {
      const heredoc = `cat > ${shellEscape(p)} <<'__SNOOPY_EOF__'\n${content}\n__SNOOPY_EOF__`;
      const r = await this.shell(heredoc);
      if (r.exitCode !== 0) throw new Error(`fs.write: ${r.stderr}`);
    },
    exists: async (p) => {
      const r = await this.shell(`test -e ${shellEscape(p)}`);
      return r.exitCode === 0;
    },
    stat: async (p) => {
      const r = await this.shell(`stat -c "%F|%s|%Y" ${shellEscape(p)}`);
      if (r.exitCode !== 0) throw new Error(`fs.stat: ${r.stderr}`);
      const [kind, size, mtime] = r.stdout.trim().split("|");
      return {
        isFile: kind === "regular file" || kind === "regular empty file",
        isDirectory: kind === "directory",
        size: Number(size) || 0,
        mtime: Number(mtime) * 1000 || 0,
      };
    },
    list: async (p) => {
      const r = await this.shell(`ls -1 ${shellEscape(p)}`);
      if (r.exitCode !== 0) return [];
      return r.stdout.split("\n").filter(Boolean);
    },
    rm: async (p, opts) => {
      const flag = opts?.recursive ? "-rf" : "-f";
      const r = await this.shell(`rm ${flag} ${shellEscape(p)}`);
      if (r.exitCode !== 0) throw new Error(`fs.rm: ${r.stderr}`);
    },
  };
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
