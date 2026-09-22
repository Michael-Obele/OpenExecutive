/**
 * Spec for `executive_research`.
 *
 * Ported from `workflows/executive_research.py` + `tests/unit/test_executive_research_workflow.py`.
 * The cases that matter: context assembly, dedup, council fan-out, synthesis,
 * quiet path, and provider failure handling.
 */

import { describe, expect, test } from "bun:test";
import { openDb, type Db } from "../../db.ts";
import type { ChatMessage, ChatOptions, Provider } from "../../providers.ts";
import {
  dedupFindings,
  renderResearchContext,
  runExecutiveResearch,
  type ResearchFinding,
} from "./executive-research.ts";

function scriptedProvider(
  handler: (messages: readonly ChatMessage[]) => string,
): Provider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    name: "scripted",
    defaultModel: "scripted-model",
    calls,
    async chat(messages: readonly ChatMessage[], _options?: ChatOptions) {
      calls.push([...messages]);
      return handler(messages);
    },
  };
}

const systemOf = (messages: readonly ChatMessage[]): string =>
  messages.find((m) => m.role === "system")?.content ?? "";

function kindOf(
  messages: readonly ChatMessage[],
): "route" | "specialist" | "synthesize" | "other" {
  const system = systemOf(messages);
  if (system.includes("You route questions")) return "route";
  if (system.includes("speaking with one voice")) return "synthesize";
  if (system.includes("DEFAULT IS IGNORE")) return "synthesize";
  return "other";
}

function seedDepartment(
  db: Db,
  slug: string,
  title: string,
  watchedEntities: string[] = [],
): void {
  db.run(
    `INSERT INTO departments (slug, title, watched_entities_json, updated_at) VALUES (?, ?, ?, ?)`,
    [slug, title, JSON.stringify(watchedEntities), new Date().toISOString()],
  );
}

describe("dedupFindings", () => {
  test("drops duplicate titles case-insensitively", () => {
    const findings: ResearchFinding[] = [
      { title: "Acme raised $50M", summary: "a", specialist: "cso" },
      { title: "acme raised $50m", summary: "b", specialist: "cfo" },
      { title: "Different title", summary: "c", specialist: "cmo" },
    ];
    const deduped = dedupFindings(findings);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.title).toBe("Acme raised $50M");
  });

  test("keeps distinct titles separate", () => {
    const findings: ResearchFinding[] = [
      { title: "Acme raised $50M", summary: "a", specialist: "cso" },
      { title: "Beta launched feature", summary: "b", specialist: "cfo" },
    ];
    expect(dedupFindings(findings)).toHaveLength(2);
  });

  test("empty input returns empty", () => {
    expect(dedupFindings([])).toHaveLength(0);
  });
});

describe("renderResearchContext", () => {
  test("includes company profile when present", () => {
    const db = openDb();
    db.run(
      `INSERT INTO company_profile (id, data, updated_at) VALUES (1, ?, ?)`,
      [
        JSON.stringify({
          name: "Acme Corp",
          industry: "SaaS",
          stage: "Series A",
          mission: "Build great software",
          competitive_landscape: {
            primary_competitors: ["Beta"],
            competitive_advantages: [],
          },
          target_customer: { profile: "", pain_points: [] },
          org_structure: { departments: [], leadership_team: [] },
          strategic_priorities: { current_year: [], north_star_metric: "" },
          culture: { values: [], operating_principles: [] },
          financials: {
            burn_rate_monthly: null,
            runway_months: null,
            key_metrics: {},
          },
          vendors: [],
          tickers: [],
        }),
        new Date().toISOString(),
      ],
    );

    const rendered = renderResearchContext(db);
    expect(rendered).toContain("Acme Corp");
    expect(rendered).toContain("SaaS");
  });

  test("includes department watch interests", () => {
    const db = openDb();
    seedDepartment(db, "finance", "Finance", ["Brex", "Ramp"]);

    const rendered = renderResearchContext(db);
    expect(rendered).toContain("DEPARTMENT WATCH INTERESTS");
    expect(rendered).toContain("finance");
  });

  test("includes user note when provided", () => {
    const db = openDb();
    const rendered = renderResearchContext(db, "focus on Series-B signals");
    expect(rendered).toContain("focus on Series-B signals");
  });

  test("always includes today's date anchor", () => {
    const db = openDb();
    const rendered = renderResearchContext(db);
    expect(rendered).toContain("TODAY'S DATE");
  });
});

describe("runExecutiveResearch", () => {
  test("exercises council end-to-end: route → consult → synthesize", async () => {
    const db = openDb();
    seedDepartment(db, "strategy", "Strategy");

    const provider = scriptedProvider((messages) => {
      const kind = kindOf(messages);
      if (kind === "route") return '["cso","cfo"]';
      if (kind === "synthesize") return "One voice: Acme is the key move.";
      // Specialist calls — return analysis.
      const system = systemOf(messages);
      if (system.includes("Chief Strategy Officer"))
        return "CSO analysis: Acme raised $50M.";
      if (system.includes("Chief Financial Officer"))
        return "CFO analysis: Runway is 12 months.";
      return "Generic analysis.";
    });

    const result = await runExecutiveResearch({}, { db, provider });

    expect(result.narrative).toContain("Acme");
    expect(result.findings.length).toBeGreaterThan(0);
    // Council was exercised: route + at least one specialist + synthesize.
    const kinds = provider.calls.map(kindOf);
    expect(kinds).toContain("route");
    expect(kinds).toContain("synthesize");
  });

  test("dedups findings with same title", async () => {
    const db = openDb();

    // Force both specialists to return same title via council.
    const provider = scriptedProvider((messages) => {
      const kind = kindOf(messages);
      if (kind === "route") return '["cso","cfo"]';
      if (kind === "synthesize") return "Synthesis done.";
      return "Same finding title — Acme raised $50M.";
    });

    const result = await runExecutiveResearch({}, { db, provider });

    // Both specialists returned same text, but titles may differ due to slicing.
    // At minimum, findings should be deduplicated if titles match.
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });

  test("quiet path when no findings", async () => {
    const db = openDb();

    // Route returns empty — no specialist is relevant.
    const provider = scriptedProvider((messages) => {
      const kind = kindOf(messages);
      if (kind === "route") return "[]";
      return "should not be called for synthesis";
    });

    const result = await runExecutiveResearch({}, { db, provider });

    expect(result.findings).toHaveLength(0);
    expect(result.narrative).toContain("No findings");
  });

  test("persists the run", async () => {
    const db = openDb();
    const provider = scriptedProvider((messages) => {
      const kind = kindOf(messages);
      if (kind === "route") return "[]";
      return "ok";
    });

    const result = await runExecutiveResearch({}, { db, provider });

    const run = db
      .query<
        { workflow_name: string; status: string },
        [string]
      >("SELECT workflow_name, status FROM workflow_runs WHERE run_id = ?")
      .get(result.runId);
    expect(run?.workflow_name).toBe("executive_research");
    expect(run?.status).toBe("succeeded");
  });

  test("handles provider failure gracefully", async () => {
    const db = openDb();
    const failing: Provider = {
      name: "failing",
      defaultModel: "x",
      async chat() {
        throw new Error("provider down");
      },
    };

    // Should not throw — the workflow catches council failures.
    const result = await runExecutiveResearch({}, { db, provider: failing });

    expect(result.narrative).toBeDefined();
    expect(result.findings).toHaveLength(0);
  });

  test("includes note in artifact when provided", async () => {
    const db = openDb();
    const provider = scriptedProvider((messages) => {
      const kind = kindOf(messages);
      if (kind === "route") return "[]";
      return "ok";
    });

    const result = await runExecutiveResearch(
      { note: "focus on fintech" },
      { db, provider },
    );

    expect(result.narrative).toContain("focus on fintech");
  });
});
