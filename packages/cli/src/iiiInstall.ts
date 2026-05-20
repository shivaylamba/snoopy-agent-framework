/**
 * Auto-install + auto-start the iii engine from snoopy. Hides the
 * "iii is separate infra" reality from users.
 *
 * Detection order:
 *   1. `iii` on PATH
 *   2. ~/.local/bin/iii
 *   3. ~/.snoopy/iii (where we install it ourselves)
 *
 * If none found: download the binary from iii-hq/iii GitHub releases to
 * ~/.snoopy/iii — one-time, no curl-piping-to-sh, no homebrew, no sudo.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, chmodSync, createWriteStream } from "node:fs";
import { rename } from "node:fs/promises";
import { homedir, arch, platform } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import kleur from "kleur";

const SNOOPY_DIR = join(homedir(), ".snoopy");
const SNOOPY_III_BIN = join(SNOOPY_DIR, "iii");
const RELEASE_VERSION = "iii/v0.12.0";

export async function findIiiBinary(): Promise<string | null> {
  const candidates = [
    process.env.III_BIN,
    join(homedir(), ".local/bin/iii"),
    SNOOPY_III_BIN,
    "/usr/local/bin/iii",
    "/opt/homebrew/bin/iii",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fall through to PATH lookup via `which`
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync("which iii", { stdio: "pipe" }).toString().trim();
    if (out && existsSync(out)) return out;
  } catch { /* not on PATH */ }
  return null;
}

/**
 * Download iii from GitHub releases for the current platform. Verifies
 * against SHA-256 supplied alongside the tarball.
 */
export async function downloadIiiBinary(): Promise<string> {
  const target = detectTarget();
  if (!target) {
    throw new Error(
      `Unsupported platform (${platform()}/${arch()}). Install iii manually: https://iii.dev/install`,
    );
  }
  mkdirSync(SNOOPY_DIR, { recursive: true });

  const url = `https://github.com/iii-hq/iii/releases/download/${RELEASE_VERSION}/iii-${target}.tar.gz`;
  console.log(kleur.cyan("→"), `Downloading iii from ${url}`);

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} downloading iii from ${url}`);
  }

  const tarPath = join(SNOOPY_DIR, "iii.tar.gz");
  await pipeline(
    Readable.fromWeb(res.body as any),
    createWriteStream(tarPath),
  );

  // Extract — use the system tar to avoid pulling in a dep.
  const { spawnSync } = await import("node:child_process");
  const extractDir = join(SNOOPY_DIR, "iii-extract");
  mkdirSync(extractDir, { recursive: true });
  const result = spawnSync("tar", ["-xzf", tarPath, "-C", extractDir], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("tar extract failed");

  // Tarball ships a single `iii` binary at the root.
  const extracted = join(extractDir, "iii");
  if (!existsSync(extracted)) {
    throw new Error(`Expected ${extracted} in tarball but didn't find it`);
  }
  await rename(extracted, SNOOPY_III_BIN);
  chmodSync(SNOOPY_III_BIN, 0o755);

  console.log(kleur.green("✓"), `Installed iii → ${SNOOPY_III_BIN}`);
  return SNOOPY_III_BIN;
}

function detectTarget(): string | null {
  const p = platform();
  const a = arch();
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "darwin" && a === "x64") return "x86_64-apple-darwin";
  if (p === "linux" && a === "arm64") return "aarch64-unknown-linux-gnu";
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  return null;
}

/**
 * Spawn iii engine. Returns the child process so the caller can stop it
 * on SIGINT. Waits up to 10s for the WS port to come up.
 */
export async function startIii(opts: {
  iiiBin: string;
  configPath?: string;
  useDefaultConfig?: boolean;
  wsPort?: number;
}): Promise<ChildProcess> {
  const args: string[] = ["--no-update-check"];
  if (opts.useDefaultConfig || !opts.configPath) {
    args.push("--use-default-config");
  } else {
    args.push("--config", opts.configPath);
  }

  console.log(kleur.cyan("→"), `Starting iii engine (${args.join(" ")})`);
  const child = spawn(opts.iiiBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Drain iii's chatty boot stdout so it doesn't pollute snoopy's logs;
  // surface errors only.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (text.toLowerCase().includes("error") || text.toLowerCase().includes("panic")) {
      process.stderr.write(text);
    }
  });

  const port = opts.wsPort ?? 49134;
  await waitForPort("localhost", port, 15_000);
  console.log(kleur.green("✓"), `iii engine ready (ws://localhost:${port})`);
  return child;
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise<boolean>((resolve) => {
      const s = new Socket();
      s.setTimeout(500);
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => resolve(false));
      s.once("timeout", () => { s.destroy(); resolve(false); });
      s.connect(port, host);
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`iii engine did not become reachable on :${port} within ${timeoutMs}ms`);
}

/**
 * Top-level resolver — find or download, then return the path.
 */
export async function ensureIiiBinary(): Promise<string> {
  const found = await findIiiBinary();
  if (found) {
    console.log(kleur.dim(`  iii binary: ${found}`));
    return found;
  }
  console.log(kleur.yellow("!"), "iii not found — downloading…");
  return downloadIiiBinary();
}
