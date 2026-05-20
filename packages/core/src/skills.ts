/**
 * Markdown-defined skills — reusable prompt workflows with structured I/O.
 *
 * Skills are markdown files under `skills/`, `.flue/skills/`, or
 * `.agents/skills/`. Frontmatter declares schema; body is the prompt
 * template with `{{args.x}}` interpolation. Invoked via
 * `session.skill("name", { args, result })`.
 *
 * Example file `skills/summarize.md`:
 *
 *   ---
 *   name: summarize
 *   description: Summarize a piece of text in 3 bullets.
 *   args:
 *     text: string
 *   ---
 *   You are summarizing this text in 3 bullets:
 *
 *   {{args.text}}
 *
 * Then in agent code:
 *
 *   const summary = await ctx.session.skill("summarize", {
 *     args: { text: "..." },
 *     result: z.object({ bullets: z.array(z.string()) }),
 *   });
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const DIRS = ["skills", ".flue/skills", ".agents/skills"];

export interface Skill {
  name: string;
  description: string;
  body: string;
  frontmatter: Record<string, string>;
}

export async function discoverCallableSkills(cwd: string): Promise<Record<string, Skill>> {
  const out: Record<string, Skill> = {};
  for (const rel of DIRS) {
    for (const file of await listMarkdown(join(cwd, rel))) {
      try {
        const content = await readFile(file, "utf-8");
        const parsed = parseFrontmatter(content, baseName(file));
        if (!out[parsed.name]) out[parsed.name] = parsed;
      } catch {
        // best-effort
      }
    }
  }
  return out;
}

/**
 * Render a skill body with `{{args.x}}` interpolation. Missing keys render
 * as empty strings (with a warning suffix so the model sees something).
 */
export function renderSkill(body: string, args: Record<string, unknown>): string {
  return body.replace(/\{\{\s*args\.([\w$]+)\s*\}\}/g, (_, key) => {
    const v = args[key];
    if (v === undefined || v === null) return `<missing arg "${key}">`;
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  });
}

function parseFrontmatter(content: string, defaultName: string): Skill {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) {
    return { name: defaultName, description: "", body: content.trim(), frontmatter: {} };
  }
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv) fm[kv[1]!.trim()] = kv[2]!.trim();
  }
  return {
    name: fm.name ?? defaultName,
    description: fm.description ?? "",
    body: m[2]!.trim(),
    frontmatter: fm,
  };
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return [];
  } catch { return []; }
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".md")) out.push(join(dir, e.name));
  }
  return out;
}

function baseName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}
