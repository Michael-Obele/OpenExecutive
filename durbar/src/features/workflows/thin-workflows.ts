/**
 * Thin workflows — the remaining 27 workflows.
 *
 * Port of `workflows/<name>.py` for all 27 remaining workflows in registry
 * order. Each is thin: prompt + context assembly + rendered Markdown artifact.
 * The weight is in the stores it reads, not the workflow.
 *
 * Pattern follows `executive-reflection.ts` and `executive-research.ts`:
 *   1. gather context (company profile, departments, inputs)
 *   2. call provider.chat with system prompt + user content
 *   3. render artifact as Markdown
 *   4. persist to workflow_runs (caller may also persist)
 *
 * Provider failures are caught and rendered as a fallback artifact rather
 * than thrown — the run still completes so the audit trail is not orphaned.
 * The caller (index.ts) may also catch and mark the run as error; both
 * paths are safe because the workflow is idempotent on runId.
 *
 * Deferred (per task constraints): Slack, Telegram, Discord, email,
 * Google Chat, web search, Honcho.
 *
 * File structure note (deviation from brief): The brief suggested per-workflow
 * files (one file per workflow). This implementation keeps all 27 thin workflows
 * in a single file (thin-workflows.ts + workflow-context.ts) instead. Each
 * workflow is identical in structure (prompt + context + artifact) and differs
 * only in prompt text and required fields; 27 near-identical files would
 * increase drift and review cost without adding clarity. A single registry +
 * generic runner (runThinWorkflow) is more maintainable for thin modules.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "../../db.ts";
import type { Provider } from "../../providers.ts";
import {
  renderCompanyContext,
  renderDepartmentContext,
  renderInputs,
} from "./workflow-context.ts";

// ── types ──────────────────────────────────────────────────────────────────

export interface ThinWorkflowDeps {
  readonly db: Db;
  readonly provider: Provider;
  readonly now?: () => Date;
  readonly runId?: string;
}

export interface ThinWorkflowResult {
  readonly runId: string;
  readonly narrative: string;
}

// ── prompt registry ────────────────────────────────────────────────────────
// One system prompt per workflow, derived from the upstream workflow's
// description and specialist routing. Kept terse — the model does the
// heavy lifting, the prompt just frames the task.

const PROMPTS: Record<string, string> = {
  annual_plan: `You are the Chief Strategy Officer drafting the Annual Operating Plan.

Produce a complete annual plan as Markdown with these sections:
  1. Strategic anchor — thesis and where we want to be by year-end
  2. Financial frame — revenue, hiring, burn, runway, raise plan
  3. Per-function priorities — what each function must deliver
  4. Risk register — top risks and mitigations
  5. Quarterly checkpoint cadence — how we track progress

Be specific and grounded in the inputs. No preamble, no sign-off.`,

  department_check_in: `You are the department lead writing a check-in brief.

Produce a 1-page Markdown check-in with:
  1. Goal status — grade each goal (on_track / at_risk / off_track)
  2. Blockers — top 3 blockers and proposed resolutions
  3. Proposed actions — concrete next steps, gated by authority

Be terse and actionable.`,

  board_prep: `You are the Board Comms lead drafting the board meeting deck.

Produce a complete board deck as Markdown:
  1. Executive summary — headline metrics vs. plan
  2. Business update — wins, challenges, KPIs
  3. Deep dive 1 — strategic topic with options and recommendation
  4. Deep dive 2 — second topic if provided
  5. Decisions needed — items requiring board approval

Use the metrics and context provided. Be crisp and board-ready.`,

  candidate_outreach: `You are the talent specialist drafting a candidate outreach sequence.

Produce a personalized outreach sequence as Markdown:
  1. First-touch message — personalized to the candidate and role
  2. Follow-up messages — each with timing and angle
  3. Scheduling note — when each touch should be sent

Never contact the candidate directly — these are drafts for the principal to review and send.`,

  candidate_screen: `You are the talent specialist screening a candidate.

Produce a fit scorecard as Markdown:
  1. Fit score (0-100) with evidence mapped to must-haves
  2. Biggest risk or gap
  3. Recommendation — advance or pass, with rationale

Be evidence-based and concise.`,

  churn_deep_dive: `You are the product and growth team analyzing churn.

Produce a churn deep-dive as Markdown:
  1. Cohort read — where churn is concentrated
  2. Root-cause hypotheses — ranked by evidence
  3. Retention interventions — ranked by leverage
  4. Financial impact — what fixing churn is worth

Ground every claim in the cohort data provided.`,

  comp_refresh: `You are the CHRO and CFO drafting a comp refresh proposal.

Produce a comp/equity refresh proposal as Markdown:
  1. Band review — current vs. market
  2. Raise logic — who gets what and why
  3. Refresh-grant approach and dilution model
  4. Rollout plan and timing

Be specific about bands and budget.`,

  competitive_teardown: `You are the product strategist tearing down a competitor.

Produce a competitive teardown as Markdown:
  1. Competitor overview — what they do and where they compete with us
  2. Product and positioning analysis
  3. Where we win and where we lose
  4. Implications — what we should do

Be sharp and evidence-based.`,

  crisis_comms: `You are the Board Comms and General Counsel drafting a crisis comms playbook.

Produce a crisis comms playbook as Markdown:
  1. Severity framing and decision tree
  2. Internal message — what the team hears first
  3. Customer message — by segment
  4. Press / regulator message if needed
  5. Post-incident comms plan

Be factual, avoid spin, and note what must not be written down.`,

  exec_search_brief: `You are the talent specialist drafting an exec search brief.

Produce an exec search brief as Markdown:
  1. Role mandate — what this hire must own in year one
  2. Business context — stage, headcount, trajectory
  3. Must-haves and non-negotiables
  4. Search strategy — where to look and how to assess

Be concrete and compelling for candidates.`,

  fundraising_prep: `You are the CFO and CSO prepping a fundraising round.

Produce a fundraising prep memo as Markdown:
  1. Round framing — size, stage, timing
  2. Traction and why-now thesis
  3. Use of funds and milestones it buys
  4. Known risks and how to address investor objections

Be investor-ready and honest about risks.`,

  gtm_launch: `You are the CMO and CPO drafting a GTM launch plan.

Produce a complete GTM launch plan as Markdown:
  1. Positioning and messaging pillars
  2. Channel plan — where and how we launch
  3. Internal enablement — what the team needs
  4. Timeline and success metrics

Be specific about audience, channels, and measurable outcomes.`,

  interview_coordination: `You are the talent coordinator planning interviews.

Produce an interview coordination plan as Markdown:
  1. Interview stages and participants
  2. Schedule and logistics
  3. Evaluation criteria per stage
  4. Next steps and owners

Be organized and actionable.`,

  engagement_value_report: `You are the account lead writing an engagement value report.

Produce a value report as Markdown:
  1. Period summary — what was delivered
  2. Outcomes and impact — measurable results
  3. Value narrative — why it matters to the client
  4. Next steps and recommendations

Be client-ready and outcome-focused.`,

  investor_update: `You are the CEO writing the monthly investor update.

Produce an investor update as Markdown:
  1. Highlights — top wins this month
  2. Lowlights — what didn't go well
  3. Metrics — revenue, burn, cash, runway
  4. Asks — specific help needed from investors
  5. Outlook — what's top of mind

Be candid and concise. Investors value honesty over polish.`,

  ma_evaluation: `You are the CFO and CSO evaluating an M&A target.

Produce an M&A evaluation as Markdown:
  1. Target overview — what they do, size, stage
  2. Strategic rationale — why this acquisition makes sense
  3. Valuation and deal structure
  4. Risks and diligence flags
  5. Recommendation — pursue, pass, or conditional

Be rigorous and flag unknowns.`,

  mbr: `You are the COO drafting the Monthly Business Review.

Produce an MBR deck as Markdown:
  1. Financial actuals vs. plan
  2. KPI movements — the 4-6 metrics that matter most
  3. Function updates — per-team status
  4. Escalations — items needing leadership decision

Be data-driven and highlight variances.`,

  offer_approval: `You are the CHRO drafting an offer package for approval.

Produce an offer approval memo as Markdown:
  1. Candidate summary and fit
  2. Comp package — base, equity, OTE
  3. Market benchmarking
  4. Approval needed — who signs and by when

Be precise about comp and approval path.`,

  new_hire_onboarding: `You are the hiring manager drafting a 30/60/90 onboarding plan.

Produce a 30/60/90 plan as Markdown:
  1. Days 1-30 — learn and connect
  2. Days 31-60 — contribute and own
  3. Days 61-90 — lead and deliver
  4. Success metrics and check-ins

Be specific and milestone-driven.`,

  org_design: `You are the COO and CHRO reviewing org design.

Produce an org design proposal as Markdown:
  1. Current structure — reporting lines and spans
  2. Proposed structure — new roles and reporting
  3. Motivation — why now and what breaks without change
  4. Constraints and rollout plan

Be concrete about roles and reporting.`,

  performance_review: `You are the manager prepping performance reviews.

Produce a performance review prep as Markdown:
  1. Per-report assessment — strengths, gaps, rating
  2. Calibration — how reports compare
  3. Promotion considerations
  4. Development plans

Be fair, specific, and evidence-based.`,

  pricing_review: `You are the product and finance team reviewing pricing.

Produce a pricing review as Markdown:
  1. Current packaging — tiers, prices, who is on each
  2. Proposed change — what moves and why
  3. Supporting data — win/loss, churn, willingness-to-pay
  4. Constraints and rollout — contracts, timing, comms

Be analytical and quantify impact.`,

  product_strategy: `You are the CPO drafting the product strategy memo.

Produce a product strategy memo as Markdown:
  1. Jobs to be done — buyer and user jobs we serve
  2. Current bets — the 3-5 bets this horizon
  3. Capacity and constraints
  4. Explicit non-bets — what we are not doing

Be opinionated and prioritize clearly.`,

  quarterly_plan: `You are the CSO and CFO drafting the quarterly operating plan.

Produce a complete quarterly plan as Markdown:
  1. Strategic objectives with OKRs
  2. Financial frame — revenue, hiring, budget
  3. Per-function priorities
  4. Risk register

Be specific and measurable. Every objective needs a key result.`,

  reference_check: `You are the talent specialist conducting a reference check.

Produce a reference check summary as Markdown:
  1. Reference perspectives — what each reference said
  2. Themes and patterns
  3. Risks or flags
  4. Recommendation

Be thorough and note any inconsistencies.`,

  risk_register: `You are the COO and General Counsel building the risk register.

Produce a risk register as Markdown:
  1. Risk inventory — by category (operational, financial, legal, market)
  2. Likelihood and impact per risk
  3. Mitigations — what we are doing or should do
  4. Owners and review cadence

Be comprehensive and assign owners.`,

  role_onboarding: `You are the hiring manager onboarding a new role.

Produce a role onboarding brief as Markdown:
  1. Role mandate — what this role owns
  2. Key relationships and stakeholders
  3. First 30 days — priorities and quick wins
  4. Success metrics

Be welcoming and clear about expectations.`,
};

// ── input validation ───────────────────────────────────────────────────────
// Minimal required-field checks per workflow. Upstream uses Pydantic with
// min_length etc.; Durbar keeps it thin — just check presence of required
// string fields so the model gets grounded inputs.

export const REQUIRED_FIELDS: Record<string, string[]> = {
  annual_plan: [
    "year_label",
    "prior_year_recap",
    "strategic_thesis",
    "revenue_and_capital",
    "top_priorities",
  ],
  board_prep: [
    "quarter_label",
    "meeting_date",
    "headline_metrics",
    "wins",
    "challenges",
    "deep_dive_topic_1",
  ],
  candidate_outreach: ["candidate_id"],
  candidate_screen: ["engagement_id", "candidate_id"],
  churn_deep_dive: ["overview", "cohort_data"],
  comp_refresh: ["driver", "current_bands", "market_signal"],
  competitive_teardown: ["competitor", "where_we_compete", "our_perception"],
  crisis_comms: ["incident_summary", "audiences"],
  department_check_in: ["department_slug"],
  engagement_value_report: [],
  exec_search_brief: [
    "role_title",
    "function",
    "business_context",
    "year_one_outcomes",
  ],
  fundraising_prep: [
    "round_label",
    "traction_metrics",
    "narrative_thesis",
    "use_of_funds",
  ],
  gtm_launch: [
    "launch_name",
    "target_audience",
    "value_proposition",
    "success_metrics",
  ],
  interview_coordination: ["candidate_id"],
  investor_update: ["month_label", "highlights", "lowlights", "metrics"],
  ma_evaluation: ["target", "strategic_rationale"],
  mbr: [
    "month_label",
    "financial_actuals",
    "kpi_movements",
    "function_updates",
  ],
  new_hire_onboarding: ["candidate_id"],
  offer_approval: ["candidate_id"],
  org_design: ["current_structure", "proposed_structure", "motivation"],
  performance_review: ["review_period", "manager_role", "direct_reports"],
  pricing_review: ["proposed_change", "current_packaging", "motivation"],
  product_strategy: ["horizon", "jobs_to_be_done", "current_bets"],
  quarterly_plan: [
    "quarter_label",
    "prior_quarter_recap",
    "top_strategic_priorities",
    "biggest_bets",
  ],
  reference_check: ["candidate_id"],
  risk_register: ["review_period", "business_context", "known_concerns"],
  role_onboarding: [],
};

function validateInputs(
  name: string,
  inputs: Record<string, unknown>,
): string | null {
  const required = REQUIRED_FIELDS[name] ?? [];
  for (const field of required) {
    const value = inputs[field];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "")
    ) {
      return `Missing required field: ${field}`;
    }
  }
  return null;
}

// ── core runner ────────────────────────────────────────────────────────────

function artifactTitle(name: string, inputs: Record<string, unknown>): string {
  const labelFields = [
    "quarter_label",
    "year_label",
    "month_label",
    "period_label",
    "launch_name",
    "role_title",
    "competitor",
    "target",
    "review_period",
    "horizon",
  ];
  for (const field of labelFields) {
    const val = inputs[field];
    if (typeof val === "string" && val) return `${name} — ${val}`;
  }
  return name;
}

export async function runThinWorkflow(
  name: string,
  inputs: Record<string, unknown>,
  deps: ThinWorkflowDeps,
): Promise<ThinWorkflowResult> {
  const { db, provider } = deps;
  const now = deps.now?.() ?? new Date();
  const runId = deps.runId ?? randomUUID();

  // Validate inputs
  const validationError = validateInputs(name, inputs);
  if (validationError) {
    const narrative = `# ${name}\n\n_Error: ${validationError}_`;
    const timestamp = now.toISOString();
    const existing = db
      .query<
        { run_id: string },
        [string]
      >("SELECT run_id FROM workflow_runs WHERE run_id = ?")
      .get(runId);
    if (existing) {
      db.run(
        `UPDATE workflow_runs SET artifact = ?, status = 'failed', updated_at = ? WHERE run_id = ?`,
        [narrative, timestamp, runId],
      );
    } else {
      db.run(
        `INSERT INTO workflow_runs (run_id, workflow_name, title, status, inputs, artifact, created_at, updated_at)
         VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)`,
        [
          runId,
          name,
          artifactTitle(name, inputs),
          JSON.stringify(inputs),
          narrative,
          timestamp,
          timestamp,
        ],
      );
    }
    return { runId, narrative };
  }

  const systemPrompt =
    PROMPTS[name] ??
    `You are the Executive drafting the ${name} workflow. Produce a Markdown artifact grounded in the inputs.`;
  const companyContext = renderCompanyContext(db);
  const deptContext = renderDepartmentContext(db);
  const inputsBlock = renderInputs(inputs);

  const contextParts: string[] = [];
  if (companyContext) contextParts.push(companyContext);
  if (deptContext) contextParts.push(deptContext);
  contextParts.push(inputsBlock);
  const userContent = contextParts.join("\n\n");

  let narrative: string;
  let failed = false;
  try {
    const modelResponse = await provider.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ]);
    // Render artifact as Markdown with title + model response
    const title = artifactTitle(name, inputs);
    narrative = `# ${title}\n\n${modelResponse.trim()}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    narrative = `# ${artifactTitle(name, inputs)}\n\n_Provider failed: ${message}_\n\nInputs were:\n\`\`\`json\n${JSON.stringify(inputs, null, 2)}\n\`\`\``;
    failed = true;
  }

  const timestamp = now.toISOString();
  const status = failed ? "failed" : "succeeded";
  // Persist — idempotent on runId (caller may have already created the run)
  const existing = db
    .query<
      { run_id: string },
      [string]
    >("SELECT run_id FROM workflow_runs WHERE run_id = ?")
    .get(runId);
  if (existing) {
    db.run(
      `UPDATE workflow_runs SET artifact = ?, status = ?, updated_at = ? WHERE run_id = ?`,
      [narrative, status, timestamp, runId],
    );
  } else {
    db.run(
      `INSERT INTO workflow_runs (run_id, workflow_name, title, status, inputs, artifact, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        name,
        artifactTitle(name, inputs),
        status,
        JSON.stringify(inputs),
        narrative,
        timestamp,
        timestamp,
      ],
    );
  }

  return { runId, narrative };
}

// ── registry helpers ───────────────────────────────────────────────────────

export const THIN_WORKFLOW_NAMES = Object.keys(PROMPTS) as readonly string[];

export function isThinWorkflow(name: string): boolean {
  return name in PROMPTS;
}

export function getThinWorkflowPrompt(name: string): string | null {
  return PROMPTS[name] ?? null;
}
