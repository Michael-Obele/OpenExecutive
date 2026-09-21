/**
 * Workflows — catalog, runs, and dynamic (custom) workflows.
 *
 * Port of `workflows/__init__.py` + `workflows/persistence.py` +
 * `workflows/dynamic_store.py` + `workflows/dynamic_models.py` +
 * `api/routes/workflows.py`.
 *
 * The reference implementation has 28 built-in workflows, each a class that
 * streams specialist calls. Durbar defers the LLM execution: a run is created
 * as `running`, immediately completed with a stub artifact, and streamed as
 * SSE so the API contract matches. The persistence surface (list/get/delete,
 * custom CRUD) is fully implemented; the execution is stubbed and documented.
 *
 * Dynamic workflows are user-created definitions stored as JSON in
 * `dynamic_workflows`. They are validated on write (snake_case name, no
 * built-in collision, title, estimated_minutes) and can be activated/
 * deactivated. Cadence scheduling is not yet wired — the definition is stored
 * but no scheduler rows are created (documented as stubbed).
 */

import type { Db } from "../../db.ts";

// ── types ──────────────────────────────────────────────────────────────────

export type WorkflowSection =
  | "Board"
  | "Capital & Investors"
  | "Growth & GTM"
  | "Product"
  | "People"
  | "Risk, Legal & Crisis"
  | "Operating Cadence";

export interface WorkflowStepDef {
  id: string;
  title: string;
  description: string;
}

export interface WorkflowMeta {
  name: string;
  title: string;
  description: string;
  section: WorkflowSection;
  estimated_minutes: number;
  input_schema: Record<string, unknown>;
  steps: WorkflowStepDef[];
  is_custom: boolean;
}

export interface WorkflowRun {
  run_id: string;
  workflow_name: string;
  title: string;
  status: string;
  inputs: string;
  artifact: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  state_json: string | null;
  awaiting_person_id: number | null;
  awaiting_until: string | null;
  resolution_json: string | null;
}

export interface DynamicWorkflowDef {
  name: string;
  title: string;
  description?: string;
  section?: WorkflowSection;
  estimated_minutes?: number;
  input_fields?: Array<{
    name: string;
    label?: string;
    type?: string;
    required?: boolean;
    description?: string;
  }>;
  steps?: Array<{
    id: string;
    title: string;
    description?: string;
    kind?: string;
    specialist?: string;
  }>;
  cadence?: string | null;
  cadence_person_id?: number | null;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
}

// ── built-in catalog ───────────────────────────────────────────────────────
// Mirrors WORKFLOW_REGISTRY in workflows/__init__.py — names and titles are
// copied, sections are approximated from the module's WorkflowSection value.
// The input_schema and steps are minimal stubs sufficient for the API contract;
// the UI renders them but does not execute them client-side.

const BUILTINS: readonly WorkflowMeta[] = [
  {
    name: "annual_plan",
    title: "Annual Operating Plan",
    description: "Company-wide annual plan with per-function targets and risks.",
    section: "Operating Cadence",
    estimated_minutes: 8,
    input_schema: { type: "object", properties: {} },
    steps: [
      { id: "context", title: "Load context", description: "Gather company state" },
      { id: "strategic_anchor", title: "Strategic anchor", description: "Define strategic pillars" },
      { id: "financial_frame", title: "Financial frame", description: "Model financial constraints" },
      { id: "assemble", title: "Assemble plan", description: "Render final artifact" },
    ],
    is_custom: false,
  },
  {
    name: "board_prep",
    title: "Board Prep Deck",
    description: "Board meeting preparation with executive summary and deep dives.",
    section: "Board",
    estimated_minutes: 6,
    input_schema: { type: "object", properties: {} },
    steps: [
      { id: "context", title: "Load context", description: "" },
      { id: "exec_summary", title: "Draft executive summary", description: "" },
      { id: "assemble", title: "Assemble final deck", description: "" },
    ],
    is_custom: false,
  },
  {
    name: "candidate_outreach",
    title: "Candidate Outreach Sequence",
    description: "Outreach sequence for a candidate.",
    section: "People",
    estimated_minutes: 3,
    input_schema: { type: "object", properties: {} },
    steps: [
      { id: "load", title: "Load candidate & recipient", description: "" },
      { id: "draft", title: "Draft the sequence", description: "" },
    ],
    is_custom: false,
  },
  {
    name: "candidate_screen",
    title: "Candidate Screen",
    description: "Screen a candidate against a role.",
    section: "People",
    estimated_minutes: 4,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "screen", title: "Screen candidate", description: "" }],
    is_custom: false,
  },
  {
    name: "churn_deep_dive",
    title: "Churn Deep Dive",
    description: "Analysis of churn drivers and mitigations.",
    section: "Growth & GTM",
    estimated_minutes: 5,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "analyze", title: "Analyze churn", description: "" }],
    is_custom: false,
  },
  {
    name: "comp_refresh",
    title: "Comp Refresh",
    description: "Compensation benchmarking and refresh proposal.",
    section: "People",
    estimated_minutes: 4,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "benchmark", title: "Benchmark comp", description: "" }],
    is_custom: false,
  },
  {
    name: "competitive_teardown",
    title: "Competitive Teardown",
    description: "Teardown of a competitor's product and positioning.",
    section: "Product",
    estimated_minutes: 5,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "teardown", title: "Teardown", description: "" }],
    is_custom: false,
  },
  {
    name: "crisis_comms",
    title: "Crisis Communications Plan",
    description: "Crisis comms plan with holding statements.",
    section: "Risk, Legal & Crisis",
    estimated_minutes: 4,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "assess", title: "Assess crisis", description: "" }],
    is_custom: false,
  },
  {
    name: "department_check_in",
    title: "Department Check-In",
    description: "Check-in brief for a department.",
    section: "Operating Cadence",
    estimated_minutes: 3,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "check", title: "Check in", description: "" }],
    is_custom: false,
  },
  {
    name: "end_of_day_digest",
    title: "End of Day Digest",
    description: "End-of-day summary for the principal.",
    section: "Operating Cadence",
    estimated_minutes: 2,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "digest", title: "Digest", description: "" }],
    is_custom: false,
  },
  {
    name: "engagement_value_report",
    title: "Engagement Value Report",
    description: "Value report for an engagement.",
    section: "Capital & Investors",
    estimated_minutes: 4,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "report", title: "Report", description: "" }],
    is_custom: false,
  },
  {
    name: "exec_search_brief",
    title: "Exec Search Brief",
    description: "Brief for an executive search.",
    section: "People",
    estimated_minutes: 4,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "brief", title: "Brief", description: "" }],
    is_custom: false,
  },
  {
    name: "executive_reflection",
    title: "Executive Reflection",
    description: "Self-reflection on org coordination.",
    section: "Operating Cadence",
    estimated_minutes: 3,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "reflect", title: "Reflect", description: "" }],
    is_custom: false,
  },
  {
    name: "executive_research",
    title: "Executive Research",
    description: "Research synthesis across specialists.",
    section: "Operating Cadence",
    estimated_minutes: 6,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "research", title: "Research", description: "" }],
    is_custom: false,
  },
  {
    name: "fundraising_prep",
    title: "Fundraising Prep",
    description: "Prep for a fundraising round.",
    section: "Capital & Investors",
    estimated_minutes: 6,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "prep", title: "Prep", description: "" }],
    is_custom: false,
  },
  {
    name: "gtm_launch",
    title: "GTM Launch Plan",
    description: "Go-to-market launch plan.",
    section: "Growth & GTM",
    estimated_minutes: 5,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "plan", title: "Plan", description: "" }],
    is_custom: false,
  },
  {
    name: "interview_coordination",
    title: "Interview Coordination",
    description: "Coordinate interviews for a candidate.",
    section: "People",
    estimated_minutes: 3,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "coordinate", title: "Coordinate", description: "" }],
    is_custom: false,
  },
  {
    name: "investor_update",
    title: "Investor Update",
    description: "Investor update memo.",
    section: "Capital & Investors",
    estimated_minutes: 4,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "update", title: "Draft update", description: "" }],
    is_custom: false,
  },
  {
    name: "ma_evaluation",
    title: "M&A Evaluation",
    description: "Evaluation of an M&A opportunity.",
    section: "Capital & Investors",
    estimated_minutes: 6,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "evaluate", title: "Evaluate", description: "" }],
    is_custom: false,
  },
  {
    name: "mbr",
    title: "Monthly Business Review",
    description: "Monthly business review deck.",
    section: "Operating Cadence",
    estimated_minutes: 5,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "review", title: "Review", description: "" }],
    is_custom: false,
  },
  {
    name: "morning_brief",
    title: "Morning Brief",
    description: "Morning brief for the principal.",
    section: "Operating Cadence",
    estimated_minutes: 2,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "brief", title: "Brief", description: "" }],
    is_custom: false,
  },
  {
    name: "new_hire_onboarding",
    title: "New Hire Onboarding",
    description: "Onboarding plan for a new hire.",
    section: "People",
    estimated_minutes: 4,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "onboard", title: "Onboard", description: "" }],
    is_custom: false,
  },
  {
    name: "offer_approval",
    title: "Offer Approval",
    description: "Offer approval workflow with human gate.",
    section: "People",
    estimated_minutes: 3,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "draft", title: "Draft offer", description: "" }],
    is_custom: false,
  },
  {
    name: "org_design",
    title: "Org Design",
    description: "Organizational design proposal.",
    section: "People",
    estimated_minutes: 5,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "design", title: "Design", description: "" }],
    is_custom: false,
  },
  {
    name: "performance_review",
    title: "Performance Review",
    description: "Performance review for a team member.",
    section: "People",
    estimated_minutes: 4,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "review", title: "Review", description: "" }],
    is_custom: false,
  },
  {
    name: "pricing_review",
    title: "Pricing Review",
    description: "Pricing strategy review.",
    section: "Product",
    estimated_minutes: 4,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "review", title: "Review pricing", description: "" }],
    is_custom: false,
  },
  {
    name: "product_strategy",
    title: "Product Strategy",
    description: "Product strategy memo.",
    section: "Product",
    estimated_minutes: 5,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "strategy", title: "Strategy", description: "" }],
    is_custom: false,
  },
  {
    name: "quarterly_plan",
    title: "Quarterly Plan",
    description: "Quarterly operating plan.",
    section: "Operating Cadence",
    estimated_minutes: 6,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "plan", title: "Plan", description: "" }],
    is_custom: false,
  },
  {
    name: "reference_check",
    title: "Reference Check",
    description: "Reference check for a candidate.",
    section: "People",
    estimated_minutes: 3,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "check", title: "Check references", description: "" }],
    is_custom: false,
  },
  {
    name: "risk_register",
    title: "Risk Register",
    description: "Risk register with mitigations.",
    section: "Risk, Legal & Crisis",
    estimated_minutes: 4,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "register", title: "Register risks", description: "" }],
    is_custom: false,
  },
  {
    name: "role_onboarding",
    title: "Role Onboarding",
    description: "Onboarding for a new role.",
    section: "People",
    estimated_minutes: 3,
    input_schema: { type: "object", properties: {} },
    steps: [{ id: "onboard", title: "Onboard role", description: "" }],
    is_custom: false,
  },
];

const BUILTIN_NAMES = new Set(BUILTINS.map((w) => w.name));

// ── validation ─────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z][a-z0-9_]{2,48}$/;

export function validateDynamicDef(defn: DynamicWorkflowDef): string[] {
  const errors: string[] = [];
  if (!defn.name || !NAME_RE.test(defn.name)) {
    errors.push("name must be snake_case, 3-49 chars, starting with a letter");
  } else if (BUILTIN_NAMES.has(defn.name)) {
    errors.push(`name ${JSON.stringify(defn.name)} collides with a built-in workflow`);
  }
  if (!defn.title || !defn.title.trim()) {
    errors.push("title must not be empty");
  }
  const mins = defn.estimated_minutes ?? 4;
  if (mins < 1 || mins > 120) {
    errors.push("estimated_minutes must be between 1 and 120");
  }
  if (defn.input_fields && defn.input_fields.length > 20) {
    errors.push("too many input fields (max 20)");
  }
  if (defn.steps && defn.steps.length > 20) {
    errors.push("too many steps (max 20)");
  }
  if (defn.cadence && !defn.cadence_person_id) {
    errors.push("cadence requires cadence_person_id");
  }
  if (!defn.cadence && defn.cadence_person_id) {
    errors.push("cadence_person_id is set but cadence is not");
  }
  return errors;
}

// ── catalog helpers ────────────────────────────────────────────────────────

export function listWorkflows(db: Db): WorkflowMeta[] {
  const customs = listDynamicDefs(db, true).map(dynamicToMeta);
  return [...BUILTINS, ...customs];
}

export function getWorkflow(db: Db, name: string): WorkflowMeta | null {
  const builtin = BUILTINS.find((w) => w.name === name);
  if (builtin) return builtin;
  const defn = getDynamicDef(db, name);
  if (defn && defn.is_active !== false) return dynamicToMeta(defn);
  return null;
}

function dynamicToMeta(defn: DynamicWorkflowDef): WorkflowMeta {
  return {
    name: defn.name,
    title: defn.title,
    description: defn.description ?? "",
    section: (defn.section as WorkflowSection) ?? "Operating Cadence",
    estimated_minutes: defn.estimated_minutes ?? 4,
    input_schema: { type: "object", properties: {} },
    steps: (defn.steps ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description ?? "",
    })),
    is_custom: true,
  };
}

// ── persistence ────────────────────────────────────────────────────────────

export function createRun(
  db: Db,
  runId: string,
  workflowName: string,
  title: string,
  inputs: Record<string, unknown>,
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO workflow_runs (run_id, workflow_name, title, status, inputs, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    [runId, workflowName, title, JSON.stringify(inputs), now, now],
  );
}

export function completeRun(db: Db, runId: string, artifact: string): void {
  const now = new Date().toISOString();
  db.run(`UPDATE workflow_runs SET status = 'done', artifact = ?, updated_at = ? WHERE run_id = ?`, [
    artifact,
    now,
    runId,
  ]);
}

export function failRun(db: Db, runId: string, error: string): void {
  const now = new Date().toISOString();
  db.run(`UPDATE workflow_runs SET status = 'error', error = ?, updated_at = ? WHERE run_id = ?`, [
    error,
    now,
    runId,
  ]);
}

export function getRun(db: Db, runId: string): Record<string, unknown> | null {
  const row = db
    .query<Record<string, unknown>, [string]>("SELECT * FROM workflow_runs WHERE run_id = ?",)
    .get(runId);
  if (!row) return null;
  // Parse inputs JSON for the API response.
  try {
    const raw = row["inputs"] as string;
    row["inputs"] = raw ? JSON.parse(raw) : {};
  } catch {
    row["inputs"] = {};
  }
  return row;
}

export function listRuns(
  db: Db,
  workflowName?: string | null,
  limit = 100,
): Array<Record<string, unknown>> {
  const capped = Math.max(1, Math.min(limit, 500));
  if (workflowName) {
    return db
      .query<Record<string, unknown>, [string, number]>(
        `SELECT run_id, workflow_name, title, status, created_at, updated_at
         FROM workflow_runs WHERE workflow_name = ? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(workflowName, capped) as Array<Record<string, unknown>>;
  }
  return db
    .query<Record<string, unknown>, [number]>(
      `SELECT run_id, workflow_name, title, status, created_at, updated_at
       FROM workflow_runs ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(capped) as Array<Record<string, unknown>>;
}

export function deleteRun(db: Db, runId: string): boolean {
  const result = db.run("DELETE FROM workflow_runs WHERE run_id = ?", [runId]);
  return result.changes > 0;
}

// ── dynamic store ──────────────────────────────────────────────────────────

export function listDynamicDefs(db: Db, activeOnly = false): DynamicWorkflowDef[] {
  const rows = activeOnly
    ? db
        .query<{ definition: string }, []>(
          "SELECT definition FROM dynamic_workflows WHERE is_active = 1 ORDER BY name",
        )
        .all()
    : db
        .query<{ definition: string }, []>("SELECT definition FROM dynamic_workflows ORDER BY name")
        .all();
  return rows.map((r) => JSON.parse(r.definition) as DynamicWorkflowDef);
}

export function getDynamicDef(db: Db, name: string): DynamicWorkflowDef | null {
  const row = db
    .query<{ definition: string }, [string]>("SELECT definition FROM dynamic_workflows WHERE name = ?")
    .get(name);
  if (!row) return null;
  return JSON.parse(row.definition) as DynamicWorkflowDef;
}

export function upsertDynamicDef(db: Db, defn: DynamicWorkflowDef): DynamicWorkflowDef {
  const now = new Date().toISOString();
  const existing = getDynamicDef(db, defn.name);
  const createdAt = existing?.created_at ?? now;
  const stored: DynamicWorkflowDef = { ...defn, created_at: createdAt, updated_at: now };
  const isActive = stored.is_active !== false ? 1 : 0;
  db.run(
    `INSERT INTO dynamic_workflows (name, definition, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET definition = excluded.definition, is_active = excluded.is_active, updated_at = excluded.updated_at`,
    [stored.name, JSON.stringify(stored), isActive, createdAt, now],
  );
  return stored;
}

export function deleteDynamicDef(db: Db, name: string): boolean {
  const result = db.run("DELETE FROM dynamic_workflows WHERE name = ?", [name]);
  return result.changes > 0;
}

export function setDynamicActive(db: Db, name: string, isActive: boolean): boolean {
  const defn = getDynamicDef(db, name);
  if (!defn) return false;
  defn.is_active = isActive;
  defn.updated_at = new Date().toISOString();
  const activeInt = isActive ? 1 : 0;
  db.run(
    `UPDATE dynamic_workflows SET definition = ?, is_active = ?, updated_at = ? WHERE name = ?`,
    [JSON.stringify(defn), activeInt, defn.updated_at, name],
  );
  return true;
}

export function deriveTitle(workflowName: string, payload: Record<string, unknown>): string {
  const MAX = 80;
  for (const field of ["quarter_label", "period", "title", "topic"]) {
    const val = payload[field];
    if (typeof val === "string" && val) {
      const base = `${workflowName} — ${val}`;
      return base.slice(0, MAX);
    }
  }
  const meta = BUILTINS.find((w) => w.name === workflowName);
  if (meta) return meta.title;
  const dyn = null;
  void dyn;
  return workflowName;
}
