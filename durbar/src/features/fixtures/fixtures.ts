/**
 * Fixtures — curated + generated company fixtures.
 *
 * Port of `fixtures/store.py` + `cli/fixture_loader.py` + `api/routes/fixtures.py`.
 * Curated fixtures live under `fixtures/companies/` in the reference repo;
 * generated fixtures live in `generated_fixtures`. Durbar lists both, and
 * load/unload are stubbed to swap company_profile/people/departments in SQLite
 * (filesystem copy deferred). Generate is stubbed with validation.
 */

import type { Db } from "../../db.ts";

export interface FixtureSummary {
  name: string;
  display_name: string;
  source: string;
  industry?: string;
  stage?: string;
  doc_count?: number;
  scenario_count?: number;
  departments?: unknown[];
  people?: unknown[];
}

function curatedFixtures(): FixtureSummary[] {
  const out: FixtureSummary[] = [];
  const candidates = [
    new URL("../../../../fixtures/companies", import.meta.url).pathname,
    new URL("../../../fixtures/companies", import.meta.url).pathname,
  ];
  for (const dir of candidates) {
    try {
      const { readdirSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
      const { join } = require("node:path") as typeof import("node:path");
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          if (!statSync(full).isDirectory()) continue;
          let displayName = entry;
          try {
            const profilePath = join(full, "profile.yaml");
            const text = readFileSync(profilePath, "utf8");
            const nameMatch = text.match(/^\s*name:\s*(.+)$/m);
            if (nameMatch) displayName = nameMatch[1]!.trim().replace(/^["']|["']$/g, "");
          } catch { /* no profile */ }
          out.push({ name: entry, display_name: displayName, source: "curated" });
        } catch { /* ignore */ }
      }
      if (out.length > 0) break;
    } catch { /* dir missing */ }
  }
  return out;
}

export function listAllFixtures(db: Db): FixtureSummary[] {
  const curated = curatedFixtures();
  let generated: FixtureSummary[] = [];
  try {
    const rows = db.query<Record<string, unknown>, []>(
      "SELECT name, display_name, industry, stage, doc_count, scenario_count FROM generated_fixtures WHERE archived = 0 ORDER BY updated_at DESC",
    ).all();
    generated = rows.map((r) => ({
      name: r["name"] as string,
      display_name: r["display_name"] as string,
      source: "generated",
      industry: (r["industry"] as string) ?? "",
      stage: (r["stage"] as string) ?? "",
      doc_count: (r["doc_count"] as number) ?? 0,
      scenario_count: (r["scenario_count"] as number) ?? 0,
    }));
  } catch { /* table missing */ }
  return [...curated, ...generated];
}

export function getFixtureStatus(_db: Db): Record<string, unknown> {
  // No active fixture tracking in Durbar yet — always report none active.
  return { active_fixture: null, has_backup: false };
}

export function fixtureExists(db: Db, name: string): boolean {
  // Check curated
  if (curatedFixtures().some((f) => f.name === name)) return true;
  try {
    const row = db.query<Record<string, unknown>, [string]>("SELECT 1 as x FROM generated_fixtures WHERE name = ? AND archived = 0").get(name);
    return !!row;
  } catch { return false; }
}

export function loadFixture(db: Db, name: string): Record<string, unknown> {
  if (!fixtureExists(db, name)) throw new Error(`Fixture ${name} not found`);
  // Stub: in a full port this would copy profile.yaml/people.yaml/departments.yaml into SQLite.
  // For now just record that it was requested.
  return { loaded: name, status: "stubbed — full filesystem restore not yet wired" };
}

export function unloadFixture(_db: Db): Record<string, unknown> {
  return { unloaded: true, status: "stubbed" };
}

export function snapshotUserState(_db: Db): Record<string, unknown> {
  return { snapshot: true, status: "stubbed" };
}

export function resetAllState(db: Db): Record<string, unknown> {
  // Wipe company state tables (keep generated_fixtures)
  const tables = ["people", "departments", "department_goals", "company_profile", "company_documents", "alerts", "decision_instances", "workflow_runs", "audit_log", "sessions", "chat_messages", "watchlist", "external_signals", "engagements", "candidates", "offers", "onboarding_plans", "onboarding_tasks", "onboarding_templates", "clients", "onboarding_sessions", "voice_personas", "agent_overrides", "agent_override_history", "review_items", "review_annotations", "eval_runs", "eval_scenarios"];
  for (const t of tables) {
    try { db.run(`DELETE FROM ${t}`); } catch { /* table missing */ }
  }
  return { reset: true };
}

export function createGeneratedFixture(db: Db, data: { name: string; display_name: string; scenario_description?: string; profile_yaml?: string; people_yaml?: string; departments_yaml?: string }): FixtureSummary {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO generated_fixtures (name, display_name, scenario_description, profile_yaml, people_yaml, departments_yaml, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [data.name, data.display_name, data.scenario_description ?? "", data.profile_yaml ?? "", data.people_yaml ?? "", data.departments_yaml ?? "", now, now],
  );
  return { name: data.name, display_name: data.display_name, source: "generated" };
}

export function deleteGeneratedFixture(db: Db, name: string): boolean {
  try {
    const result = db.run("UPDATE generated_fixtures SET archived = 1, updated_at = ? WHERE name = ? AND archived = 0", [new Date().toISOString(), name]);
    return result.changes > 0;
  } catch { return false; }
}

export function deriveSlug(displayName: string, exists: (name: string) => boolean): string {
  let slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) slug = "fixture";
  if (!exists(slug)) return slug;
  let n = 2;
  while (exists(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}
