#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { devCommand } from "./commands/dev.js";
import { deployCommand } from "./commands/deploy.js";
import { tracesCommand } from "./commands/traces.js";
import { invokeCommand } from "./commands/invoke.js";
import { logsCommand } from "./commands/logs.js";
import { doctorCommand } from "./commands/doctor.js";

const program = new Command();

program
  .name("agent")
  .description("snoopy-diffie — distributed agent framework CLI")
  .version("0.1.0");

program
  .command("init [template]")
  .description("Scaffold a new agent project (templates: sre, blank)")
  .option("-d, --dir <dir>", "Target directory", ".")
  .action(initCommand);

program
  .command("dev")
  .description("Boot iii engine + register agents + watch for changes")
  .option("-c, --config <path>", "Path to snoopy.config.ts", "./snoopy.config.ts")
  .option("--no-docker", "Skip `docker compose up` (no-op if no docker-compose.yml)")
  .option("--no-iii", "Don't manage an iii engine — assume one is already running")
  .option("--iii-config <path>", "Path to iii-config.yaml (auto-detected if omitted)")
  .action(devCommand);

program
  .command("deploy")
  .description("Scaffold a bundled deploy (Docker/Fly/Node), build/push, and/or register on a remote iii engine")
  .option("-t, --target <target>", "Bundled-deploy target: docker | fly | node")
  .option("--app-name <name>", "App name used in fly.toml / image tag (default: project dir)")
  .option("-e, --engine <url>", "Remote iii engine WS URL (registers metadata)")
  .option("-c, --config <path>", "Path to snoopy.config.ts", "./snoopy.config.ts")
  .option("--build", "Build a Docker image for this agent project")
  .option("--image <name>", "Image name (default: project dir slug)")
  .option("--registry <url>", "Registry to push to (e.g. ghcr.io/me)")
  .option("--tag <tag>", "Image tag (default: GITHUB_SHA[:12] or ISO timestamp)")
  .option("--no-push", "Build but do not push (useful in CI before tagging)")
  .action(deployCommand);

program
  .command("traces")
  .description("Tail the trace stream as a live tree")
  .option("-a, --agent <id>", "Filter to a specific agent id")
  .option("-r, --run <id>", "Filter to a specific run id")
  .option("--flat", "Flat chronological list instead of tree view")
  .option("--replay", "Replay from the start of the stream rather than tailing latest only")
  .action(tracesCommand);

program
  .command("invoke <agentId>")
  .description("Synchronously invoke an agent and print its return value")
  .option("-p, --payload <json>", "Inline JSON payload")
  .option("-f, --payload-file <path>", "Path to a JSON file containing the payload")
  .option("-t, --timeout-ms <ms>", "Invocation timeout override")
  .action(invokeCommand);

program
  .command("logs")
  .description("Tail logs filtered to an agent or run")
  .option("-a, --agent <id>", "Filter to a specific agent id")
  .option("-r, --run <id>", "Filter to a specific run id")
  .option("--replay", "Replay from the start of the stream")
  .action(logsCommand);

program
  .command("doctor")
  .description("Diagnose common setup issues (node, iii, docker, API keys, config)")
  .option("-c, --config <path>", "Path to snoopy.config.ts", "./snoopy.config.ts")
  .option("--iii <path>", "Path to the iii binary (defaults to PATH lookup)")
  .action(doctorCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
