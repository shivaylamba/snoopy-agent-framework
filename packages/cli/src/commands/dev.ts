import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import chokidar from "chokidar";
import kleur from "kleur";
import { tracesCommand } from "./traces.js";
import { ensureIiiBinary, startIii } from "../iiiInstall.js";

interface DevOpts {
  config?: string;
  docker?: boolean;
  // If `false`, skip the auto-managed iii engine and assume one is already
  // running (legacy behavior). Default: true — `agent dev` is one command.
  iii?: boolean;
  iiiConfig?: string;
}

const III_HTTP = process.env.III_HTTP_URL ?? "http://localhost:3111";

export async function devCommand(opts: DevOpts) {
  const configPath = resolve(opts.config ?? "./snoopy.config.ts");
  if (!existsSync(configPath)) {
    console.error(kleur.red(`Config not found: ${configPath}`));
    process.exit(1);
  }

  // Optional infra: docker compose (redis/postgres if present). Non-fatal.
  if (opts.docker !== false && existsSync(resolve("./docker-compose.yml"))) {
    await bootDocker().catch((e) => {
      console.log(kleur.yellow("!"), "docker compose unavailable:", String(e?.message ?? e));
    });
  }

  // iii engine: auto-start unless user opted out OR an engine already responds.
  let iiiProc: ChildProcess | undefined;
  if (opts.iii !== false) {
    const alreadyUp = await engineReachable();
    if (alreadyUp) {
      console.log(kleur.dim("  iii engine already running on " + III_HTTP));
    } else {
      const iiiBin = await ensureIiiBinary();
      const iiiConfigPath = opts.iiiConfig
        ? resolve(opts.iiiConfig)
        : (existsSync(resolve("./iii-config.yaml")) ? resolve("./iii-config.yaml") : undefined);
      iiiProc = await startIii({
        iiiBin,
        configPath: iiiConfigPath,
        useDefaultConfig: !iiiConfigPath,
      });
    }
  }

  await waitForEngine();

  console.log(kleur.cyan("→"), "Loading", configPath);
  await loadConfig(configPath);
  console.log(kleur.green("✓"), "Agents registered");

  tracesCommand({}).catch((e) => console.error("trace tail error:", e));

  const watcher = chokidar.watch(
    ["./agents/**/*.ts", "./tools/**/*.ts", "./snoopy.config.ts"],
    { ignoreInitial: true, cwd: process.cwd() },
  );

  watcher.on("change", async (path) => {
    console.log(kleur.yellow("↻"), "Change:", path, "— re-loading");
    try {
      await loadConfig(configPath, true);
      console.log(kleur.green("✓"), "Re-registered");
    } catch (e) {
      console.error(kleur.red("✗"), "Re-load failed:", e);
    }
  });

  const shutdown = () => {
    console.log("\n" + kleur.dim("Shutting down…"));
    watcher.close().catch(() => {});
    if (iiiProc && !iiiProc.killed) {
      iiiProc.kill("SIGTERM");
      // Give iii a beat to flush its OTel buffers before we exit.
      setTimeout(() => process.exit(0), 750);
    } else {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

async function bootDocker(): Promise<void> {
  console.log(kleur.cyan("→"), "Starting docker services");
  await run("docker", ["compose", "up", "-d"]);
}

async function engineReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${III_HTTP}/health`).catch(() => null);
    return res?.ok ?? false;
  } catch {
    return false;
  }
}

async function waitForEngine(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await engineReachable()) {
      console.log(kleur.green("✓"), "iii engine HTTP ready");
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`iii engine did not become ready within ${timeoutMs}ms`);
}

async function loadConfig(path: string, reload = false): Promise<void> {
  const url = (path.startsWith("file:") ? path : "file://" + path) + (reload ? `?t=${Date.now()}` : "");
  const mod: any = await import(url);
  const config = mod.default ?? mod;
  if (!config || !Array.isArray(config.agents)) {
    throw new Error("snoopy.config.ts must default-export { agents: [...] }");
  }
  // Importing the user's agent files triggers defineAgent() which
  // registers on iii as a side effect. Nothing else to do.
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
    child.on("error", rej);
  });
}
