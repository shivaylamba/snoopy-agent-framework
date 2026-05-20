import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Socket } from "node:net";
import kleur from "kleur";

const exec = promisify(cpExec);

interface DoctorOpts {
  config?: string;
  iii?: string;
}

type CheckResult = "ok" | "warn" | "fail";
interface Check {
  name: string;
  result: CheckResult;
  message?: string;
  fix?: string;
}

/**
 * `agent doctor` — diagnose common setup issues before they bite you.
 * Pattern from agentmemory's CLI doctor: enumerate every assumption a
 * fresh-clone user hits in their first 10 minutes and verify each.
 */
export async function doctorCommand(opts: DoctorOpts) {
  const checks: Check[] = [];

  // 1. Node version
  const nodeVer = process.versions.node;
  const major = parseInt(nodeVer.split(".")[0]!, 10);
  checks.push({
    name: `node version (${nodeVer})`,
    result: major >= 20 ? "ok" : "fail",
    message: major >= 20 ? undefined : "Need node >= 20",
    fix: major >= 20 ? undefined : "Install Node 20+ (https://nodejs.org)",
  });

  // 2. iii binary
  const iiiCmd = opts.iii ?? process.env.III_BIN ?? "iii";
  const iiiResult = await tryExec(`${iiiCmd} --version`);
  checks.push({
    name: `iii binary (${iiiCmd})`,
    result: iiiResult.ok ? "ok" : "fail",
    message: iiiResult.ok ? iiiResult.stdout.trim() : "not found in PATH",
    fix: iiiResult.ok ? undefined : "curl -fsSL https://iii.dev/install.sh | sh   (or set --iii <path>)",
  });

  // 3. iii engine reachable (TCP-level check on the WS port — iii doesn't
  //    expose /health by default, but if 49134 is listening, it's up).
  const wsUrl = process.env.III_WS_URL ?? "ws://localhost:49134";
  const wsPort = parseInt(new URL(wsUrl.replace("ws://", "http://").replace("wss://", "https://")).port || "49134", 10);
  const wsHost = new URL(wsUrl.replace("ws://", "http://").replace("wss://", "https://")).hostname;
  const tcpUp = await new Promise<boolean>((res) => {
    const s = new Socket();
    s.setTimeout(1500);
    s.once("connect", () => { s.destroy(); res(true); });
    s.once("error", () => res(false));
    s.once("timeout", () => { s.destroy(); res(false); });
    s.connect(wsPort, wsHost);
  });
  checks.push({
    name: `iii engine reachable (${wsHost}:${wsPort})`,
    result: tcpUp ? "ok" : "warn",
    message: tcpUp ? undefined : "WS port not listening",
    fix: tcpUp ? undefined : "Start with: iii --use-default-config   (or iii --config iii-config.yaml)",
  });

  // 4. Docker (for redis/postgres)
  const dockerResult = await tryExec("docker ps --format '{{.Names}}'");
  if (dockerResult.ok) {
    const names = dockerResult.stdout.trim().split("\n");
    const hasRedis = names.some((n) => n.includes("redis"));
    const hasPg = names.some((n) => n.includes("postgres"));
    checks.push({
      name: "redis container",
      result: hasRedis ? "ok" : "warn",
      fix: hasRedis ? undefined : "docker compose up -d   (or use IIIStore — iii state backs all memory by default)",
    });
    checks.push({
      name: "postgres container",
      result: hasPg ? "ok" : "warn",
      fix: hasPg ? undefined : "docker compose up -d   (only needed for PgTraceStore)",
    });
  } else {
    checks.push({
      name: "docker",
      result: "warn",
      message: "docker not available; you'll need to run redis/postgres manually if you use them",
    });
  }

  // 5. LLM API key
  const keys = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  const anyKey = Object.values(keys).some(Boolean);
  checks.push({
    name: "LLM API key",
    result: anyKey ? "ok" : "fail",
    message: anyKey
      ? `${Object.entries(keys).filter(([_, v]) => v).map(([k]) => k).join(", ")} set`
      : "no key set",
    fix: anyKey ? undefined : "export OPENAI_API_KEY=sk-... (or ANTHROPIC_API_KEY)",
  });

  // 6. Project config
  const configPath = resolve(opts.config ?? "./snoopy.config.ts");
  checks.push({
    name: `snoopy.config.ts at ${configPath}`,
    result: existsSync(configPath) ? "ok" : "warn",
    fix: existsSync(configPath) ? undefined : "Run `agent init` to scaffold a project",
  });

  // 7. iii-config.yaml
  const iiiConfigPath = resolve("./iii-config.yaml");
  if (existsSync(iiiConfigPath)) {
    checks.push({ name: "iii-config.yaml (file-based state)", result: "ok" });
  } else {
    checks.push({
      name: "iii-config.yaml",
      result: "warn",
      message: "using default in-memory state",
      fix: "For production: drop an iii-config.yaml with `store_method: file_based`",
    });
  }

  // 8. iii ecosystem workers — founder's "wrapping not required" principle.
  //    Production setups install these via `iii worker add`. snoopy doesn't
  //    require them, but you get more leverage when they exist.
  const workerListRes = await tryExec(`${iiiCmd} worker list`);
  if (workerListRes.ok) {
    const installed = new Set(
      workerListRes.stdout
        .split("\n")
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((n) => n && !n.startsWith("NAME") && !n.startsWith("----")),
    );
    const recommended: Array<{ name: string; why: string }> = [
      { name: "iii-state", why: "KV memory + reactive triggers" },
      { name: "iii-observability", why: "OTel traces / metrics / logs" },
      { name: "iii-sandbox", why: "isolated tool execution" },
      { name: "iii-cron", why: "scheduled agents" },
      { name: "provider-openai", why: "OpenAI as iii functions" },
      { name: "auth-credentials", why: "credential vault" },
    ];
    for (const w of recommended) {
      if (installed.has(w.name)) {
        checks.push({ name: `iii worker: ${w.name}`, result: "ok" });
      } else {
        checks.push({
          name: `iii worker: ${w.name}`,
          result: "warn",
          message: w.why,
          fix: `iii worker add ${w.name}`,
        });
      }
    }
  } else {
    checks.push({
      name: "iii worker registry",
      result: "warn",
      message: "could not list workers (engine may be on --use-default-config)",
      fix: "Restart engine with `iii --config iii-config.yaml` so workers can persist",
    });
  }

  // Render
  console.log();
  for (const c of checks) {
    const symbol =
      c.result === "ok" ? kleur.green("✓") :
      c.result === "warn" ? kleur.yellow("!") :
      kleur.red("✗");
    console.log(` ${symbol} ${c.name}${c.message ? "  " + kleur.dim(`(${c.message})`) : ""}`);
    if (c.fix) console.log(`   ${kleur.dim("→ " + c.fix)}`);
  }
  const pass = checks.filter((c) => c.result === "ok").length;
  const warn = checks.filter((c) => c.result === "warn").length;
  const fail = checks.filter((c) => c.result === "fail").length;
  console.log();
  console.log(`  ${pass} pass · ${warn} warn · ${fail} fail`);
  if (fail > 0) process.exit(1);
}

async function tryExec(cmd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, { timeout: 5_000 });
    return { ok: true, stdout, stderr };
  } catch (err: any) {
    return { ok: false, stdout: err?.stdout ?? "", stderr: err?.stderr ?? String(err) };
  }
}
