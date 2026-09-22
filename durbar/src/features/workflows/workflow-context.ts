/**
 * Shared workflow context helpers.
 *
 * Every workflow is thin: prompt + context assembly + rendered Markdown
 * artifact. The weight is in the stores it reads, not the workflow. This
 * module centralizes the company-profile loader so 27 workflows don't each
 * reimplement the same JSON parse.
 *
 * Features talk to DB via db.ts, never each other's internals (AGENTS.md).
 * So this helper reads company_profile directly rather than importing from
 * features/company.
 */

import type { Db } from "../../db.ts";

/** Minimal company snapshot rendered into every workflow prompt. */
export function renderCompanyContext(db: Db): string {
  const parts: string[] = [];
  try {
    const row = db
      .query<{ data: string }, []>("SELECT data FROM company_profile WHERE id = 1")
      .get();
    if (row?.data) {
      const parsed = JSON.parse(row.data) as Record<string, unknown>;
      const name = typeof parsed["name"] === "string" ? parsed["name"] : "";
      const industry = typeof parsed["industry"] === "string" ? parsed["industry"] : "";
      const stage = typeof parsed["stage"] === "string" ? parsed["stage"] : "";
      const mission = typeof parsed["mission"] === "string" ? parsed["mission"] : "";
      if (name) {
        parts.push(`COMPANY: ${name}${industry ? ` — ${industry}` : ""}${stage ? ` (${stage})` : ""}`);
        if (mission) parts.push(`Mission: ${mission}`);
      }
      const cl = parsed["competitive_landscape"] as Record<string, unknown> | undefined;
      if (cl && Array.isArray(cl["primary_competitors"])) {
        const comps = (cl["primary_competitors"] as unknown[]).filter(
          (x): x is string => typeof x === "string",
        );
        if (comps.length > 0) parts.push(`Competitors: ${comps.join(", ")}`);
      }
    }
  } catch {
    // profile is optional — workflows still run without it
  }
  return parts.join("\n");
}

/** Renders a flat inputs object as bullet lines for the prompt. */
export function renderInputs(inputs: Record<string, unknown>): string {
  const lines: string[] = ["INPUTS:"];
  for (const [key, value] of Object.entries(inputs)) {
    if (value === undefined || value === null || value === "") continue;
    const str = typeof value === "string" ? value : JSON.stringify(value);
    // Truncate very long values to keep prompt bounded
    const truncated = str.length > 2000 ? `${str.slice(0, 2000)}…` : str;
    lines.push(`- ${key}: ${truncated}`);
  }
  if (lines.length === 1) lines.push("- (no inputs provided)");
  return lines.join("\n");
}

/** Loads department titles for context, if the table exists. */
export function renderDepartmentContext(db: Db): string {
  try {
    const rows = db
      .query<{ slug: string; title: string }, []>("SELECT slug, title FROM departments ORDER BY slug")
      .all();
    if (rows.length === 0) return "";
    return `DEPARTMENTS: ${rows.map((r) => `${r.title} (${r.slug})`).join(", ")}`;
  } catch {
    return "";
  }
}
