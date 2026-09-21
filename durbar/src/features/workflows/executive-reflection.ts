/**
 * Executive reflection — OE's daily standup with itself.
 *
 * Port of `workflows/executive_reflection.py`. Three steps, matching upstream:
 *   1. gather_signals — at-risk goals, proposals, awaiting people, activity, alerts.
 *   2. decide        — one LLM call with the full signal context.
 *   3. emit_artifact — Markdown summary of what was decided.
 *
 * The reference implementation drives a tool-use loop (the model can call
 * schedule_followup, send_dm, create_alert, etc.). Durbar's port is thin:
 * prompt + context assembly + rendered Markdown artifact. The weight is in the
 * stores it reads, not the workflow. The tool loop is deferred — the artifact
 * still captures what the Executive *would* have done, and the scheduler
 * chaining ensures it runs daily without being asked.
 *
 * No watermark: reflection is not a brief, it does not suppress. It always
 * produces an artifact, even when quiet — the quiet line is part of the
 * artifact, not a suppression.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "../../db.ts";
import type { Provider } from "../../providers.ts";

export const REFLECTION_KIND = "executive_reflection";

export interface ExecutiveReflectionInput {
  readonly periodLabel?: string;
}

export interface ExecutiveReflectionDeps {
  readonly db: Db;
  readonly provider: Provider;
  readonly now?: () => Date;
}

export interface AtRiskGoal {
  readonly department: string;
  readonly keyResult: string;
  readonly status: string;
  readonly current: string;
}

export interface Proposal {
  readonly headline: string;
  readonly severity: string;
}

export interface AwaitingPerson {
  readonly fullName: string;
  readonly role: string;
  readonly awaitingCount: number;
}

export interface Activity {
  readonly summary: string;
  readonly ts: string;
}

export interface AlertSummary {
  readonly headline: string;
  readonly severity: string;
}

export interface ReflectionContext {
  readonly atRiskGoals: readonly AtRiskGoal[];
  readonly proposals: readonly Proposal[];
  readonly awaitingPeople: readonly AwaitingPerson[];
  readonly activity: readonly Activity[];
  readonly recentAlerts: readonly AlertSummary[];
}

export interface ExecutiveReflectionResult {
  readonly runId: string;
  readonly period: string;
  readonly narrative: string;
}

function isActionable(source: string): boolean {
  return !source.startsWith("monitoring") && !source.startsWith("watchlist");
}

export function gatherReflectionContext(db: Db): ReflectionContext {
  const atRiskGoals = db
    .query<AtRiskGoal, []>(
      `SELECT d.title AS department,
              g.key_result AS keyResult,
              g.status      AS status,
              g.current     AS current
         FROM department_goals g
         JOIN departments d ON d.slug = g.department_slug
        WHERE g.status IN ('at_risk', 'off_track')
        ORDER BY g.status DESC, d.title`,
    )
    .all();

  const proposals = db
    .query<Proposal & { source: string }, []>(
      `SELECT headline, severity, source
         FROM alerts
        WHERE status = 'unread'
        ORDER BY created_at DESC
        LIMIT 20`,
    )
    .all()
    .filter((row) => isActionable(row.source))
    .map(({ headline, severity }) => ({ headline, severity }));

  // People still waiting — from scheduled_actions pending with department,
  // plus people table awaiting counts via scheduled_actions.
  // Simplified: count pending scheduled_actions per person via assigned_to_person_id
  // and also check people awaiting via scheduled_actions department.
  // For Durbar, we approximate by listing people with pending actions.
  let awaitingPeople: AwaitingPerson[] = [];
  try {
    const rows = db
      .query<{ full_name: string; role: string; cnt: number }, []>(
        `SELECT p.full_name AS full_name, p.role AS role, COUNT(sa.id) AS cnt
           FROM people p
           JOIN scheduled_actions sa ON sa.assigned_to_person_id = p.id
          WHERE sa.status = 'pending' AND p.archived = 0
          GROUP BY p.id
          HAVING cnt > 0
          ORDER BY cnt DESC
          LIMIT 10`,
      )
      .all();
    awaitingPeople = rows.map((r) => ({
      fullName: r.full_name,
      role: r.role,
      awaitingCount: r.cnt,
    }));
  } catch {
    // scheduled_actions may not have assigned_to_person_id on old DBs — ignore.
    awaitingPeople = [];
  }

  const activity = db
    .query<Activity, []>(
      `SELECT summary, ts
         FROM audit_log
        ORDER BY ts DESC
        LIMIT 15`,
    )
    .all();

  const recentAlertsWithSource = db
    .query<AlertSummary & { source: string }, []>(
      `SELECT headline, severity, source
         FROM alerts
        WHERE status = 'unread'
        ORDER BY created_at DESC
        LIMIT 10`,
    )
    .all()
    .filter((row) => isActionable(row.source))
    .map(({ headline, severity }) => ({ headline, severity }));

  return {
    atRiskGoals,
    proposals,
    awaitingPeople,
    activity,
    recentAlerts: recentAlertsWithSource,
  };
}

export function renderReflectionContext(
  context: ReflectionContext,
  period: string,
): string {
  const lines: string[] = [`Period: ${period}`, ""];

  lines.push(`DEPARTMENTS WITH RISK (${context.atRiskGoals.length})`);
  if (context.atRiskGoals.length === 0) lines.push("- none");
  for (const goal of context.atRiskGoals) {
    lines.push(
      `- [${goal.status}] ${goal.department}: ${goal.keyResult}` +
        (goal.current ? ` — current: ${goal.current}` : ""),
    );
  }

  lines.push("", `PROPOSALS AWAITING DECISION (${context.proposals.length})`);
  if (context.proposals.length === 0) lines.push("- none");
  for (const p of context.proposals) {
    lines.push(`- (${p.severity}) ${p.headline}`);
  }

  lines.push("", `PEOPLE WAITING (${context.awaitingPeople.length})`);
  if (context.awaitingPeople.length === 0) lines.push("- none");
  for (const person of context.awaitingPeople) {
    lines.push(
      `- ${person.fullName}${person.role ? ` (${person.role})` : ""}: ${person.awaitingCount} awaiting`,
    );
  }

  lines.push("", `RECENT ACTIVITY (${context.activity.length})`);
  if (context.activity.length === 0) lines.push("- nothing");
  for (const event of context.activity) lines.push(`- ${event.summary}`);

  lines.push("", `RECENT ALERTS (${context.recentAlerts.length})`);
  if (context.recentAlerts.length === 0) lines.push("- none");
  for (const alert of context.recentAlerts) {
    lines.push(`- [${alert.severity}] ${alert.headline}`);
  }

  if (
    context.atRiskGoals.length === 0 &&
    context.proposals.length === 0 &&
    context.awaitingPeople.length === 0 &&
    context.activity.length === 0 &&
    context.recentAlerts.length === 0
  ) {
    lines.push("", "(No signals worth acting on this period.)");
  }

  return lines.join("\n");
}

export const REFLECTION_SYSTEM_PROMPT = `You are the user's Executive on your morning solo standup. You are reviewing your own org state — what departments did overnight, what's pending decisions, who's been waiting, what alerts are open — and deciding what to act on BEFORE the principal opens their morning brief.

Audience choice rule: smallest audience that owns the matter.
  • Single human owns it → DM that person.
  • Department-scoped → message the department.
  • Company-wide → broadcast.

Decision rule: act on small things within authority; propose for big calls (spend, hire, board); say so plainly when you don't know.

Per signal, decide one of:
  (a) ACT NOW — execute a follow-up, DM, broadcast, or alert.
  (b) NOTIFY the right audience.
  (c) RAISE IN MORNING BRIEF — note that the principal should see this.
  (d) IGNORE — quiet signals don't need action.

When done, emit a SHORT Markdown summary (≤200 words):
  **Acted on:** (bullets — one per action)
  **Flagged for the brief:** (bullets — surface without acting)
  **Quiet:** (one line — how much you ignored)

Skip headers for empty sections. Be terse — this is an internal note, not a board memo.`;

export async function runExecutiveReflection(
  input: ExecutiveReflectionInput,
  deps: ExecutiveReflectionDeps,
): Promise<ExecutiveReflectionResult> {
  const { db, provider } = deps;
  const now = deps.now?.() ?? new Date();
  const period = input.periodLabel ?? now.toISOString().slice(0, 10);

  const context = gatherReflectionContext(db);
  const userContent = renderReflectionContext(context, period);

  const narrative = await provider.chat([
    { role: "system", content: REFLECTION_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ]);

  const runId = randomUUID();
  const timestamp = now.toISOString();

  db.run(
    `INSERT INTO workflow_runs
       (run_id, workflow_name, title, status, inputs, artifact, created_at, updated_at)
     VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?)`,
    [
      runId,
      "executive_reflection",
      `Executive Reflection — ${period}`,
      JSON.stringify(input),
      narrative,
      timestamp,
      timestamp,
    ],
  );

  return { runId, period, narrative };
}
