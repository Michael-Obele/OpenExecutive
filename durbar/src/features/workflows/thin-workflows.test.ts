/**
 * Spec for thin workflows — the 27 remaining workflows.
 *
 * Each workflow is thin: prompt + context + artifact. Tests verify:
 *   - happy path: provider is called, narrative returned, run persisted
 *   - validation edge: missing required field produces error artifact without calling provider
 *   - provider failure: graceful fallback artifact, run still persisted
 *   - registry helpers: isThinWorkflow, getThinWorkflowPrompt, THIN_WORKFLOW_NAMES
 *
 * Isolation: openDb() returns an isolated in-memory SQLite DB per test — no
 * shared state between tests, no cleanup needed.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import type { ChatMessage, ChatOptions, Provider } from "../../providers.ts";
import {
  getThinWorkflowPrompt,
  isThinWorkflow,
  REQUIRED_FIELDS,
  runThinWorkflow,
  THIN_WORKFLOW_NAMES,
} from "./thin-workflows.ts";

function fakeProvider(
  reply = "Model artifact.",
): Provider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    name: "fake",
    defaultModel: "fake-model",
    calls,
    async chat(messages: readonly ChatMessage[], _options?: ChatOptions) {
      calls.push([...messages]);
      return reply;
    },
  };
}

function failingProvider(message = "provider down"): Provider {
  return {
    name: "failing",
    defaultModel: "x",
    async chat() {
      throw new Error(message);
    },
  };
}

// Minimal valid inputs per workflow — satisfies REQUIRED_FIELDS
const VALID_INPUTS: Record<string, Record<string, unknown>> = {
  annual_plan: {
    year_label: "FY 2026",
    prior_year_recap:
      "Closed at $4M ARR, launched mid-market motion, 14mo runway.",
    strategic_thesis:
      "Market shifting to ops-layer analytics, consolidate mid-market.",
    revenue_and_capital: "Plan $9M ARR, 22 to 50 people, Series B Q3.",
    top_priorities: "1. Workspaces GA 2. Platform tier 3. AI query 4. Series B",
  },
  department_check_in: { department_slug: "finance" },
  board_prep: {
    quarter_label: "Q2 2026",
    meeting_date: "June 15, 2026",
    headline_metrics: "ARR $4.1M, NRR 112%, cash $9.2M",
    wins: "Closed Acme $240K, shipped v2 reporting",
    challenges: "Pipeline 2.1x vs 3x target, churn 1.8%",
    deep_dive_topic_1: "Whether to raise Series B in Q3 or Q1 2027",
  },
  candidate_outreach: { candidate_id: 1 },
  candidate_screen: { engagement_id: 1, candidate_id: 1 },
  churn_deep_dive: {
    overview: "Churn 1.2% to 1.8%, concentrated in <50 seats",
    cohort_data: "<50: 3.1%, 50-200: 1.4%, >200: 0.6%",
  },
  comp_refresh: {
    driver: "Two finalists declined over comp band, eng bands stale 14mo",
    current_bands: "L3 $130-150K + 0.05%, L4 $160-185K + 0.08%",
    market_signal: "Bands 87% of median, equity 50% of Series-A median",
  },
  competitive_teardown: {
    competitor: "Mode Analytics",
    where_we_compete: "Mid-market BI, 100-500 person SaaS",
    our_perception: "They require central data team, we are self-serve",
  },
  crisis_comms: {
    incident_summary:
      "Security breach via compromised laptop, 14h access, 3% accounts",
    audiences: "50 enterprise accounts, 40 internal, press reached out",
  },
  engagement_value_report: {},
  exec_search_brief: {
    role_title: "VP Engineering",
    function: "Engineering",
    business_context: "Series A, 38 people, scaling mid-market",
    year_one_outcomes: "Ship platform tier, hire 10 eng, cut churn to 1%",
  },
  fundraising_prep: {
    round_label: "Series B $15M",
    traction_metrics: "ARR $4.1M +18% QoQ, NRR 112%, 38 headcount",
    narrative_thesis: "Analytics as ops-layer, mid-market consolidation",
    use_of_funds: "Platform tier, GTm expansion, 12 hires",
  },
  gtm_launch: {
    launch_name: "Workspaces GA",
    target_audience: "Mid-market RevOps at 100-500 person SaaS",
    value_proposition: "Team analytics in one place with IT controls",
    success_metrics: "40% adoption in 60d, $300K ARR, 3 case studies",
  },
  interview_coordination: { candidate_id: 1 },
  investor_update: {
    month_label: "May 2026",
    highlights: "Closed Acme $240K, shipped v2, hired VPE",
    lowlights: "Pipeline 2.1x, churn 1.8%",
    metrics: "ARR $4.1M, burn $660K, cash $9.2M, 14mo runway",
  },
  ma_evaluation: {
    target: "Acme Analytics, 20 people, $2M ARR, event pipeline",
    strategic_rationale: "Event pipeline fills our gap, 6mo faster than build",
  },
  mbr: {
    month_label: "May 2026",
    financial_actuals: "Revenue $340K vs $360K plan, burn $660K, cash $9.2M",
    kpi_movements: "NRR 112%, logo churn 1.8%, NPS 47",
    function_updates: "Eng: v2 shipped, GTM: 11 logos vs 14 plan, CS: NPS 47",
  },
  new_hire_onboarding: { candidate_id: 1 },
  offer_approval: { candidate_id: 1 },
  org_design: {
    current_structure: "CTO -> 3 eng leads, flat, 12 eng",
    proposed_structure: "Add VPE, 2 teams of 6, eng managers",
    motivation: "Span of control breaking, CTO bottleneck",
  },
  performance_review: {
    review_period: "H1 2026",
    manager_role: "VP Engineering",
    direct_reports:
      "Alice: shipped v2, strong. Bob: missed deadlines, needs coaching.",
  },
  pricing_review: {
    proposed_change: "Add usage-based tier at $0.10 per 1K events",
    current_packaging: "Seat-based: $50/seat, 3 tiers",
    motivation: "Heavy-usage accounts underpay, SMB churn on price",
  },
  product_strategy: {
    horizon: "H2 2026",
    jobs_to_be_done: "RevOps: share reports, Data: self-serve query",
    current_bets: "Workspaces GA, AI query, platform tier",
  },
  quarterly_plan: {
    quarter_label: "Q3 2026",
    prior_quarter_recap: "Shipped v2, mid-market 2x pipeline, SOC2 done",
    top_strategic_priorities: "Land 5 mid-market, ship onboarding, cut churn",
    biggest_bets: "Mid-market motion, self-serve onboarding",
  },
  reference_check: { candidate_id: 1 },
  risk_register: {
    review_period: "FY 2026",
    business_context: "Series A, 38 people, $4M ARR, 14mo runway",
    known_concerns: "Key-person risk on CTO, churn in SMB, burn rate",
  },
  role_onboarding: {},
};

const ALL_THIN_NAMES = Object.keys(VALID_INPUTS);

describe("THIN_WORKFLOW_NAMES", () => {
  test("lists 27 workflows", () => {
    expect(THIN_WORKFLOW_NAMES).toHaveLength(27);
  });

  test("contains expected names", () => {
    expect(THIN_WORKFLOW_NAMES).toContain("annual_plan");
    expect(THIN_WORKFLOW_NAMES).toContain("board_prep");
    expect(THIN_WORKFLOW_NAMES).toContain("quarterly_plan");
    expect(THIN_WORKFLOW_NAMES).toContain("risk_register");
  });
});

describe("isThinWorkflow", () => {
  test("returns true for thin workflows", () => {
    expect(isThinWorkflow("annual_plan")).toBe(true);
    expect(isThinWorkflow("board_prep")).toBe(true);
  });

  test("returns false for non-thin workflows", () => {
    expect(isThinWorkflow("morning_brief")).toBe(false);
    expect(isThinWorkflow("executive_reflection")).toBe(false);
    expect(isThinWorkflow("does_not_exist")).toBe(false);
  });
});

describe("getThinWorkflowPrompt", () => {
  test("returns prompt for known workflow", () => {
    const prompt = getThinWorkflowPrompt("annual_plan");
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("Annual Operating Plan");
  });

  test("returns null for unknown workflow", () => {
    expect(getThinWorkflowPrompt("does_not_exist")).toBeNull();
  });
});

describe("runThinWorkflow — happy path (parameterized over all 27)", () => {
  for (const name of ALL_THIN_NAMES) {
    test(`${name}: calls provider and persists artifact`, async () => {
      const db = openDb();
      const provider = fakeProvider(`Artifact for ${name}.`);
      const inputs = VALID_INPUTS[name] ?? {};

      const result = await runThinWorkflow(name, inputs, { db, provider });

      expect(result.narrative).toContain(`Artifact for ${name}`);
      expect(result.runId).toBeTruthy();
      expect(provider.calls).toHaveLength(1);
      // System prompt contains workflow-specific framing
      const systemMsg = provider.calls[0]?.[0];
      expect(systemMsg?.role).toBe("system");
      expect(systemMsg?.content.length).toBeGreaterThan(20);
      // User content contains inputs
      const userMsg = provider.calls[0]?.[1];
      expect(userMsg?.role).toBe("user");
      // Persisted
      const row = db
        .query<
          { workflow_name: string; status: string; artifact: string },
          [string]
        >("SELECT workflow_name, status, artifact FROM workflow_runs WHERE run_id = ?")
        .get(result.runId);
      expect(row?.workflow_name).toBe(name);
      expect(row?.status).toBe("succeeded");
      expect(row?.artifact).toContain(`Artifact for ${name}`);
    });
  }
});

describe("runThinWorkflow — validation edge", () => {
  test("annual_plan: missing required field produces error artifact without calling provider", async () => {
    const db = openDb();
    const provider = fakeProvider("should not be called");
    const result = await runThinWorkflow("annual_plan", {}, { db, provider });
    expect(result.narrative).toContain("Missing required field");
    expect(provider.calls).toHaveLength(0);
    const row = db
      .query<
        { artifact: string; status: string },
        [string]
      >("SELECT artifact, status FROM workflow_runs WHERE run_id = ?")
      .get(result.runId);
    expect(row?.artifact).toContain("Missing required field");
    expect(row?.status).toBe("failed");
  });

  test("board_prep: missing required field", async () => {
    const db = openDb();
    const provider = fakeProvider("should not be called");
    const result = await runThinWorkflow(
      "board_prep",
      { quarter_label: "Q2" },
      { db, provider },
    );
    expect(result.narrative).toContain("Missing required field");
    expect(provider.calls).toHaveLength(0);
  });

  test("candidate_screen: missing candidate_id", async () => {
    const db = openDb();
    const provider = fakeProvider("should not be called");
    const result = await runThinWorkflow(
      "candidate_screen",
      { engagement_id: 1 },
      { db, provider },
    );
    expect(result.narrative).toContain("Missing required field");
    expect(provider.calls).toHaveLength(0);
  });

  test("engagement_value_report: no required fields, empty inputs still calls provider", async () => {
    const db = openDb();
    const provider = fakeProvider("Value report artifact.");
    const result = await runThinWorkflow(
      "engagement_value_report",
      {},
      { db, provider },
    );
    expect(provider.calls).toHaveLength(1);
    expect(result.narrative).toContain("Value report artifact");
  });

  test("role_onboarding: no required fields, empty inputs still calls provider", async () => {
    const db = openDb();
    const provider = fakeProvider("Role onboarding artifact.");
    const result = await runThinWorkflow(
      "role_onboarding",
      {},
      { db, provider },
    );
    expect(provider.calls).toHaveLength(1);
    expect(result.narrative).toContain("Role onboarding artifact");
  });

  test("whitespace-only required field is rejected", async () => {
    const db = openDb();
    const provider = fakeProvider("should not be called");
    const result = await runThinWorkflow(
      "annual_plan",
      { year_label: "   " },
      { db, provider },
    );
    expect(result.narrative).toContain("Missing required field");
    expect(provider.calls).toHaveLength(0);
  });

  test("validation is idempotent on retry with same runId", async () => {
    const db = openDb();
    const provider = fakeProvider("should not be called");
    const runId = "validation-retry-id";
    const r1 = await runThinWorkflow(
      "annual_plan",
      {},
      { db, provider, runId },
    );
    expect(r1.narrative).toContain("Missing required field");
    const r2 = await runThinWorkflow(
      "annual_plan",
      {},
      { db, provider, runId },
    );
    expect(r2.narrative).toContain("Missing required field");
    expect(r2.runId).toBe(runId);
    const row = db
      .query<
        { status: string },
        [string]
      >("SELECT status FROM workflow_runs WHERE run_id = ?")
      .get(runId);
    expect(row?.status).toBe("failed");
  });

  // Parameterized: every workflow with required fields must reject missing field
  for (const name of ALL_THIN_NAMES) {
    const required = REQUIRED_FIELDS[name] ?? [];
    if (required.length === 0) continue;
    const firstRequired = required[0] as string;
    test(`${name}: missing required field '${firstRequired}' → failed without provider call`, async () => {
      const db = openDb();
      const provider = fakeProvider("should not be called");
      // Provide all valid inputs except the first required field
      const inputs = { ...(VALID_INPUTS[name] ?? {}) };
      delete (inputs as Record<string, unknown>)[firstRequired];
      const result = await runThinWorkflow(name, inputs, { db, provider });
      expect(result.narrative).toContain("Missing required field");
      expect(result.narrative).toContain(firstRequired);
      expect(provider.calls).toHaveLength(0);
      const row = db
        .query<
          { status: string },
          [string]
        >("SELECT status FROM workflow_runs WHERE run_id = ?")
        .get(result.runId);
      expect(row?.status).toBe("failed");
    });
  }
});

describe("runThinWorkflow — provider failure", () => {
  test("gracefully renders fallback artifact and persists as failed", async () => {
    const db = openDb();
    const provider = failingProvider("deepseek 429 rate limited");
    const inputs = VALID_INPUTS["annual_plan"] ?? {};
    const result = await runThinWorkflow("annual_plan", inputs, {
      db,
      provider,
    });
    expect(result.narrative).toContain("Provider failed");
    expect(result.narrative).toContain("429");
    const row = db
      .query<
        { status: string; artifact: string },
        [string]
      >("SELECT status, artifact FROM workflow_runs WHERE run_id = ?")
      .get(result.runId);
    expect(row?.status).toBe("failed");
    expect(row?.artifact).toContain("Provider failed");
  });

  test("churn_deep_dive: provider failure persists as failed", async () => {
    const db = openDb();
    const provider = failingProvider("timeout");
    const inputs = VALID_INPUTS["churn_deep_dive"] ?? {};
    const result = await runThinWorkflow("churn_deep_dive", inputs, {
      db,
      provider,
    });
    expect(result.narrative).toContain("Provider failed");
    const row = db
      .query<
        { status: string },
        [string]
      >("SELECT status FROM workflow_runs WHERE run_id = ?")
      .get(result.runId);
    expect(row?.status).toBe("failed");
  });

  // Parameterized: sample of workflows — provider failure must persist as failed
  for (const name of [
    "board_prep",
    "gtm_launch",
    "risk_register",
    "mbr",
    "pricing_review",
  ] as const) {
    test(`${name}: provider failure persists as failed`, async () => {
      const db = openDb();
      const provider = failingProvider("provider down");
      const inputs = VALID_INPUTS[name] ?? {};
      const result = await runThinWorkflow(name, inputs, { db, provider });
      expect(result.narrative).toContain("Provider failed");
      const row = db
        .query<
          { status: string },
          [string]
        >("SELECT status FROM workflow_runs WHERE run_id = ?")
        .get(result.runId);
      expect(row?.status).toBe("failed");
    });
  }
});

describe("runThinWorkflow — context assembly", () => {
  test("includes company context when profile exists", async () => {
    const db = openDb();
    db.run(
      "INSERT INTO company_profile (id, data, updated_at) VALUES (1, ?, ?)",
      [
        JSON.stringify({
          name: "Acme Corp",
          industry: "SaaS",
          stage: "Series A",
          mission: "Build great software",
        }),
        new Date().toISOString(),
      ],
    );
    const provider = fakeProvider("ok");
    await runThinWorkflow("annual_plan", VALID_INPUTS["annual_plan"] ?? {}, {
      db,
      provider,
    });
    const userContent = provider.calls[0]?.[1]?.content ?? "";
    expect(userContent).toContain("Acme Corp");
  });

  test("includes department context when departments exist", async () => {
    const db = openDb();
    db.run(
      "INSERT INTO departments (slug, title, updated_at) VALUES (?, ?, ?)",
      ["finance", "Finance", new Date().toISOString()],
    );
    const provider = fakeProvider("ok");
    await runThinWorkflow("board_prep", VALID_INPUTS["board_prep"] ?? {}, {
      db,
      provider,
    });
    const userContent = provider.calls[0]?.[1]?.content ?? "";
    expect(userContent).toContain("Finance");
  });

  test("uses provided runId", async () => {
    const db = openDb();
    const provider = fakeProvider("ok");
    const runId = "test-run-id-123";
    const result = await runThinWorkflow(
      "annual_plan",
      VALID_INPUTS["annual_plan"] ?? {},
      { db, provider, runId },
    );
    expect(result.runId).toBe(runId);
    const row = db
      .query<
        { run_id: string },
        [string]
      >("SELECT run_id FROM workflow_runs WHERE run_id = ?")
      .get(runId);
    expect(row?.run_id).toBe(runId);
  });

  test("updates existing run when runId already exists", async () => {
    const db = openDb();
    const provider = fakeProvider("updated artifact");
    const runId = "existing-run-id";
    db.run(
      "INSERT INTO workflow_runs (run_id, workflow_name, title, status, inputs, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?, ?)",
      [
        runId,
        "annual_plan",
        "Annual Plan",
        JSON.stringify({}),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    const result = await runThinWorkflow(
      "annual_plan",
      VALID_INPUTS["annual_plan"] ?? {},
      { db, provider, runId },
    );
    expect(result.runId).toBe(runId);
    const row = db
      .query<
        { artifact: string; status: string },
        [string]
      >("SELECT artifact, status FROM workflow_runs WHERE run_id = ?")
      .get(runId);
    expect(row?.artifact).toContain("updated artifact");
    expect(row?.status).toBe("succeeded");
  });
});

describe("workflow-context truncation", () => {
  test("renderInputs truncates values longer than 2000 chars", async () => {
    const { renderInputs } = await import("./workflow-context.ts");
    const longValue = "x".repeat(3000);
    const rendered = renderInputs({ big_field: longValue });
    expect(rendered).toContain("…");
    expect(rendered.length).toBeLessThan(3000 + 100);
  });

  test("renderInputs does not truncate short values", async () => {
    const { renderInputs } = await import("./workflow-context.ts");
    const rendered = renderInputs({ short: "hello world" });
    expect(rendered).toContain("hello world");
    expect(rendered).not.toContain("…");
  });
});
