import { mkdir, writeFile, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import kleur from "kleur";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function initCommand(
  template = "blank",
  opts: { dir?: string } = {},
) {
  const target = resolve(opts.dir ?? ".");
  const src = resolve(__dirname, "..", "..", "templates", template);

  try {
    await stat(src);
  } catch {
    console.error(kleur.red(`Unknown template: ${template}`));
    console.error(`Available: ${(await listTemplates()).join(", ")}`);
    process.exit(1);
  }

  await mkdir(target, { recursive: true });
  await copyTree(src, target);

  console.log(kleur.green("✓"), `Scaffolded ${template} template into ${target}`);
  console.log();
  console.log("Next:");
  console.log("  pnpm install");
  console.log("  agent dev");
}

async function listTemplates(): Promise<string[]> {
  const dir = resolve(__dirname, "..", "..", "templates");
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true });
  for (const e of entries) {
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory()) {
      await mkdir(dst, { recursive: true });
      await copyTree(src, dst);
    } else {
      const buf = await readFile(src);
      await writeFile(dst, buf);
    }
  }
}
