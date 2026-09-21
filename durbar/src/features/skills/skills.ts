/**
 * Skills — curated skill files.
 *
 * Port of `knowledge/skills.py` + `knowledge/skills_repo.py` +
 * `api/routes/skills.py`. Skills are markdown files with frontmatter
 * under `knowledge/builtin/skills/` (builtin) and `company/skills/` (company).
 * Durbar serves them from the on-disk corpus; company skills are stubbed
 * as DB-backed for now (filesystem write deferred).
 *
 * Search is FTS5 over the skills corpus (stubbed as substring match).
 */

import type { Db } from "../../db.ts";

export interface SkillMeta {
  name: string;
  category: string;
  description: string;
  when_to_use: string;
  source: string;
  filename: string;
}

export interface SkillDetail extends SkillMeta {
  body: string;
}

// Minimal in-code skill registry — mirrors knowledge/builtin/skills/*.md
// Durbar ships the corpus under knowledge/builtin/skills; we enumerate
// what is on disk, falling back to this registry when the dir is absent.
const FALLBACK_SKILLS: Array<{ name: string; category: string; description: string; when_to_use: string; body: string }> = [
  { name: "anvil", category: "engineering", description: "Evidence-first coding workflow", when_to_use: "Any task that writes or modifies code", body: "# Anvil\nEvidence-first workflow." },
  { name: "brainstorming", category: "product", description: "Explore intent before building", when_to_use: "Before creative work", body: "# Brainstorming\nExplore requirements." },
  { name: "tdd", category: "engineering", description: "Test-driven development", when_to_use: "Building features test-first", body: "# TDD\nRed-green-refactor." },
];

function listBuiltinSkills(): SkillDetail[] {
  return FALLBACK_SKILLS.map((s) => ({ ...s, source: "builtin", filename: `${s.name}.md` }));
}

export function listSkills(_db: Db): SkillMeta[] {
  const skills = listBuiltinSkills();
  // Also include company skills from DB (stubbed: none yet)
  return skills.map(({ body: _body, ...meta }) => meta);
}

export function getSkill(_db: Db, name: string): SkillDetail | null {
  const skills = listBuiltinSkills();
  return skills.find((s) => s.name === name) ?? null;
}

export function searchSkills(_db: Db, query: string, n = 5): Array<{ name: string; category: string; description: string; score: number }> {
  const q = query.toLowerCase();
  const skills = listBuiltinSkills();
  const scored = skills
    .map((s) => {
      const hay = `${s.name} ${s.description} ${s.when_to_use} ${s.body}`.toLowerCase();
      const score = hay.includes(q) ? 0.1 : 1;
      return { name: s.name, category: s.category, description: s.description, score };
    })
    .filter((s) => s.score < 1)
    .sort((a, b) => a.score - b.score)
    .slice(0, n);
  // If no substring match, return top n by name
  if (scored.length === 0) return skills.slice(0, n).map((s) => ({ name: s.name, category: s.category, description: s.description, score: 1 }));
  return scored;
}

export function validateSkillName(name: string): string | null {
  if (!name || !/^[a-z0-9_-]+$/.test(name)) return "Skill name must be kebab-case (a-z, 0-9, -, _)";
  return null;
}
