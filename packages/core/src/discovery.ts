import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Walk role/skill markdown files under a project root. Returns a flat map
 * of name → instructions (the markdown body, frontmatter stripped). Used
 * to build the system prompt when an agent declares `role: "name"`.
 *
 * Conventions accepted (in priority order):
 *   - <cwd>/roles/<name>.md
 *   - <cwd>/.flue/roles/<name>.md
 *   - <cwd>/.agents/skills/<name>.md         (legacy; SRE demo uses this)
 */
const DIRS = ["roles", ".flue/roles", ".agents/skills"];

export interface SkillMarkdown {
  name: string;
  description: string;
  instructions: string;
  frontmatter: Record<string, string>;
  /** Optional per-role overrides parsed from frontmatter. */
  model?: string;
  thinkingLevel?: string;
}

export async function discoverSkills(cwd: string): Promise<Record<string, SkillMarkdown>> {
  const out: Record<string, SkillMarkdown> = {};
  for (const rel of DIRS) {
    for (const file of await listMarkdown(join(cwd, rel))) {
      try {
        const content = await readFile(file, "utf-8");
        const parsed = parseFrontmatter(content, baseName(file));
        if (!out[parsed.name]) out[parsed.name] = parsed;
      } catch {
        // Skip unreadable files rather than throwing
      }
    }
  }
  return out;
}

function parseFrontmatter(content: string, defaultName: string): SkillMarkdown {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) {
    return { name: defaultName, description: "", instructions: content.trim(), frontmatter: {} };
  }
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv) fm[kv[1]!.trim()] = kv[2]!.trim();
  }
  return {
    name: fm.name ?? defaultName,
    description: fm.description ?? "",
    instructions: m[2]!.trim(),
    frontmatter: fm,
    model: fm.model,
    thinkingLevel: fm.thinkingLevel,
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
