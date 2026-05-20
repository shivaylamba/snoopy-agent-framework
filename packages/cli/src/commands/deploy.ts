import { spawn } from "node:child_process";
import { resolve, dirname, basename } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import kleur from "kleur";
import {
  bundledDockerfile,
  startScript,
  flyToml,
  targetReadme,
  TARGETS,
  type DeployTarget,
} from "../deployTargets.js";

interface DeployOpts {
  engine?: string;
  config?: string;
  build?: boolean;
  image?: string;
  registry?: string;
  tag?: string;
  noPush?: boolean;
  target?: string;
  appName?: string;
}

/**
 * Four modes:
 *
 *   1. `agent deploy --target <docker|fly|node>`
 *      Generates a self-contained artifact bundling iii + worker. No
 *      separate iii infra required. This is the "full framework" path.
 *
 *   2. `agent deploy --engine ws://...`
 *      Metadata-only: register agents on a remote iii engine. The user
 *      runs the worker themselves somewhere reachable.
 *
 *   3. `agent deploy --build --registry <url> [--image <name>]`
 *      Build the Docker image and push to a registry. Used after #1
 *      when you want to ship the image somewhere.
 *
 *   4. Combine: `agent deploy --target fly --build` generates artifacts
 *      AND builds the image. You then run `fly deploy` to ship it.
 */
export async function deployCommand(opts: DeployOpts) {
  const configPath = resolve(opts.config ?? "./snoopy.config.ts");
  if (!existsSync(configPath)) {
    console.error(kleur.red(`Config not found: ${configPath}`));
    process.exit(1);
  }

  let didSomething = false;

  if (opts.target) {
    const target = parseTarget(opts.target);
    await scaffoldTarget(target, configPath, opts);
    didSomething = true;
  }

  if (opts.build) {
    await dockerBuildPush(opts, configPath);
    didSomething = true;
  }

  if (opts.engine) {
    await metadataRegister(opts.engine, configPath);
    didSomething = true;
  }

  if (!didSomething) {
    console.error(
      kleur.yellow(
        "nothing to do — pass --target <docker|fly|node> to scaffold a bundled deploy,\n" +
        "                 --build to ship an image, or --engine to register metadata.",
      ),
    );
    process.exit(1);
  }
}

function parseTarget(raw: string): DeployTarget {
  if ((TARGETS as string[]).includes(raw)) return raw as DeployTarget;
  console.error(kleur.red(`Unknown --target "${raw}". Choose from: ${TARGETS.join(", ")}`));
  process.exit(1);
}

/**
 * Scaffold a self-contained deploy artifact: Dockerfile (bundles iii),
 * start.sh, and target-specific config (fly.toml, etc).
 *
 * Idempotent — existing files are left alone so user edits survive a
 * re-run. Pass --force to overwrite. (Not yet implemented — for now we
 * just print which files we'd have written.)
 */
async function scaffoldTarget(
  target: DeployTarget,
  configPath: string,
  opts: DeployOpts,
): Promise<void> {
  const projectDir = dirname(configPath);
  const appName = opts.appName ?? basename(projectDir).replace(/[^a-z0-9-]/gi, "-").toLowerCase();

  console.log(kleur.cyan("→"), `Scaffolding ${target} deploy for "${appName}"`);

  const writes: Array<{ path: string; content: string; mode?: number }> = [
    { path: resolve(projectDir, "Dockerfile"), content: bundledDockerfile() },
    { path: resolve(projectDir, "scripts/start.sh"), content: startScript(), mode: 0o755 },
    { path: resolve(projectDir, `DEPLOY.${target}.md`), content: targetReadme(target, appName) },
  ];

  if (target === "fly") {
    writes.push({ path: resolve(projectDir, "fly.toml"), content: flyToml(appName) });
  }

  for (const w of writes) {
    if (existsSync(w.path)) {
      console.log(kleur.dim("  skip"), w.path, kleur.dim("(exists)"));
      continue;
    }
    mkdirSync(dirname(w.path), { recursive: true });
    writeFileSync(w.path, w.content, { mode: w.mode });
    console.log(kleur.green("  +"), w.path);
  }

  console.log();
  console.log(kleur.green("✓"), `Ready. Next:`);
  if (target === "fly") {
    console.log(`  ${kleur.bold("fly launch --no-deploy")}     # one-time, create the app`);
    console.log(`  ${kleur.bold("fly secrets set OPENAI_API_KEY=… SERPAPI_API_KEY=…")}`);
    console.log(`  ${kleur.bold("fly deploy")}`);
  } else {
    console.log(`  ${kleur.bold(`docker build -t ${appName} ${projectDir}`)}`);
    console.log(`  ${kleur.bold(`docker run --rm -p 3111:3111 -p 49134:49134 ${appName}`)}`);
  }
  console.log();
  console.log(kleur.dim("  (or: agent deploy --target " + target + " --build --registry <url> to build + push)"));
}

async function metadataRegister(engineUrl: string, configPath: string): Promise<void> {
  process.env.III_WS_URL = engineUrl;
  console.log(kleur.cyan("→"), "Deploying metadata to", engineUrl);

  const url = "file://" + configPath;
  const mod: any = await import(url);
  const config = mod.default ?? mod;
  if (!config || !Array.isArray(config.agents)) {
    throw new Error("snoopy.config.ts must default-export { agents: [...] }");
  }
  console.log(kleur.green("✓"), `Registered ${config.agents.length} agents`);
}

async function dockerBuildPush(opts: DeployOpts, configPath: string): Promise<void> {
  const projectDir = dirname(configPath);
  const dockerfile = resolve(projectDir, "Dockerfile");
  if (!existsSync(dockerfile)) {
    // No target was scaffolded and no hand-written Dockerfile — fall back
    // to the iii-bundled one. Users who want the old "worker-only,
    // external iii" image can pass --target node and then edit.
    console.log(kleur.dim("→"), `No Dockerfile — generating bundled one at ${dockerfile}`);
    writeFileSync(dockerfile, bundledDockerfile());
    mkdirSync(resolve(projectDir, "scripts"), { recursive: true });
    writeFileSync(resolve(projectDir, "scripts/start.sh"), startScript(), { mode: 0o755 });
  }

  const image = opts.image ?? basename(projectDir).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const tag = opts.tag ?? deriveTag();
  const fullName = opts.registry ? `${opts.registry}/${image}:${tag}` : `${image}:${tag}`;

  console.log(kleur.cyan("→"), "docker build", fullName);
  await run("docker", ["build", "-t", fullName, projectDir]);

  if (opts.noPush) {
    console.log(kleur.yellow("✓"), `Built ${fullName} (push skipped — --no-push)`);
    return;
  }
  if (!opts.registry) {
    console.log(kleur.yellow("✓"), `Built ${fullName} (no --registry given; not pushing)`);
    return;
  }

  console.log(kleur.cyan("→"), "docker push", fullName);
  await run("docker", ["push", fullName]);
  console.log(kleur.green("✓"), `Pushed ${fullName}`);
}

function deriveTag(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return process.env.GITHUB_SHA?.slice(0, 12) ?? ts;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
    child.on("error", rej);
  });
}
