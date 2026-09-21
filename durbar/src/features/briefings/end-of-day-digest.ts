/**
 * End-of-day digest — a short proactive recap for the principal.
 *
 * Port of `workflows/end_of_day_digest.py`. Two steps, matching upstream:
 *   1. load_context — today's actions, pending proposals, at-risk goals.
 *   2. synthesize   — one screen of Markdown in the Executive's voice.
 *
 * Two upstream details are load-bearing and easy to lose in a port:
 *
 *   • The window is "since the last digest I *actually delivered*", not "the
 *     last 24 hours". On a cold store there is no prior digest, so it falls
 *     back to 24h. Getting this wrong turns "what changed" into "the latest N
 *     rows", which reads as noise.
 *
 *   • Monitoring/watchlist findings are excluded. They are real, but they are
 *     not decisions, and mixing them into "Still pending" is what makes a
 *     digest skimmable-once and then ignored.
 *
 * Suppression: when nothing changed and forceFull is not set, the digest
 * short-circuits to a one-liner without calling the model — same contract as
 * the morning brief, different quiet line.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../../db.ts";
import type { Provider } from "../../providers.ts";

export const EOD_BRIEF_KIND = "principal_brief_eod";

/** Cold-store window when no digest has ever been delivered. */
const COLD_START_WINDOW_HOURS = 24;

export interface EndOfDayDigestInput {
  readonly periodLabel?: string;
  readonly forceFull?: boolean;
}

export interface EndOfDayDigestDeps {
  readonly db: Db;
  readonly provider: Provider;
  readonly now?: () => Date;
  readonly runId?: string;
}

export interface AtRiskGoal {
  readonly department: string;
  readonly keyResult: string;
  readonly status: string;
  readonly current: string;
}

export interface Proposal {
  readonly headline: string;
  readonly suggestedAction: string;
  readonly severity: string;
}

export interface Activity {
  readonly summary: string;
  readonly eventType: string;
  readonly ts: string;
}

export interface EodContext {
  readonly since: string;
  readonly atRiskGoals: readonly AtRiskGoal[];
  readonly proposals: readonly Proposal[];
  readonly activity: readonly Activity[];
}

export interface EndOfDayDigestResult {
  readonly runId: string;
  readonly period: string;
  readonly narrative: string;
  readonly suppressed: boolean;
}

/**
 * Start of the window: when the last digest was delivered, else 24h ago.
 *
 * Reads `briefing_narrative` rather than `workflow_runs` on purpose — a run
 * can be recorded without being delivered, and counting an undelivered run
 * would silently swallow whatever it contained.
 */
export function sinceForEod(
  db: Db,
  kind: string,
  now: Date = new Date(),
): string {
  const row = db
    .query<{ generated_at: string }, [string]>(
      "SELECT generated_at FROM briefing_narrative WHERE scope = ? ORDER BY generated_at DESC LIMIT 1",
    )
    .get(kind);

  if (row?.generated_at) return row.generated_at;

  return new Date(
    now.getTime() - COLD_START_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
}

function eodInputHash(context: EodContext): string {
  const payload = JSON.stringify({
    atRiskGoals: context.atRiskGoals.map((g) => `${g.department}:${g.keyResult}:${g.status}`),
    proposals: context.proposals.map((p) => `${p.headline}:${p.severity}`),
    activity: context.activity.map((a) => `${a.summary}:${a.eventType}`),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function isActionable(source: string): boolean {
  return !source.startsWith("monitoring") && !source.startsWith("watchlist");
}

export function gatherEodContext(db: Db, since: string): EodContext {
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
      `SELECT headline, suggested_action AS suggestedAction, severity, source
         FROM alerts
        WHERE status = 'unread'
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    .all()
    .filter((row) => isActionable(row.source))
    .map(({ headline, suggestedAction, severity }) => ({
      headline,
      suggestedAction,
      severity,
    }));

  const activity = db
    .query<Activity, [string]>(
      `SELECT summary, event_type AS eventType, ts
         FROM audit_log
        WHERE ts > ?
        ORDER BY ts DESC
        LIMIT 50`,
    )
    .all(since);

  return { since, atRiskGoals, proposals, activity };
}

export function renderEodContext(context: EodContext, period: string): string {
  const lines: string[] = [`Period: ${period}`, `Since: ${context.since}`, ""];

  lines.push(`WHAT I DID TODAY (${context.activity.length})`);
  if (context.activity.length === 0) lines.push("- nothing");
  for (const event of context.activity) lines.push(`- ${event.summary}`);

  lines.push("", `STILL PENDING (${context.proposals.length})`);
  if (context.proposals.length === 0) lines.push("- none");
  for (const proposal of context.proposals) {
    lines.push(
      `- (${proposal.severity}) ${proposal.headline}` +
        (proposal.suggestedAction ? ` → ${proposal.suggestedAction}` : ""),
    );
  }

  lines.push("", `AT RISK TOMORROW (${context.atRiskGoals.length})`);
  if (context.atRiskGoals.length === 0) lines.push("- none");
  for (const goal of context.atRiskGoals) {
    lines.push(
      `- [${goal.status}] ${goal.department}: ${goal.keyResult}` +
        (goal.current ? ` — current: ${goal.current}` : ""),
    );
  }

  return lines.join("\n");
}

export const EOD_SYSTEM_PROMPT = `You are the user's Executive writing the end-of-day digest — a short message the principal reads before logging off. Audience is the principal alone; peer-to-peer tone.

Output ≤200 words of Markdown with these sections, in order, each only when there is real content:
  1. **What I did today** — actions you took without prompting. One bullet per item, terse.
  2. **Still pending** — only new items since last brief. If nothing new, say so in one line.
  3. **At risk tomorrow** — what might trip if no action happens overnight.
  4. **Sleep on this** — at most ONE open question worth mulling overnight. Skip if none.

Skip headers for empty sections. If the day was genuinely quiet, output one line: 'Quiet day — nothing carrying forward.'`;

export function isEodQuiet(context: EodContext): boolean {
  return (
    context.atRiskGoals.length === 0 &&
    context.proposals.length === 0 &&
    context.activity.length === 0
  );
}

export async function runEndOfDayDigest(
  input: EndOfDayDigestInput,
  deps: EndOfDayDigestDeps,
): Promise<EndOfDayDigestResult> {
  const { db, provider } = deps;
  const now = deps.now?.() ?? new Date();
  const period = input.periodLabel ?? now.toISOString().slice(0, 10);

  const since = sinceForEod(db, EOD_BRIEF_KIND, now);
  const context = gatherEodContext(db, since);

  const suppressed = isEodQuiet(context) && input.forceFull !== true;
  const narrative = suppressed
    ? "Quiet day — nothing carrying forward."
    : await provider.chat([
        { role: "system", content: EOD_SYSTEM_PROMPT },
        { role: "user", content: renderEodContext(context, period) },
      ]);

  const runId = deps.runId ?? randomUUID();
  const timestamp = now.toISOString();

  const persist = db.transaction(() => {
    db.run(
      `INSERT INTO workflow_runs
         (run_id, workflow_name, title, status, inputs, artifact, created_at, updated_at)
       VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?)`,
      [
        runId,
        "end_of_day_digest",
        `End of Day Digest — ${period}`,
        JSON.stringify(input),
        narrative,
        timestamp,
        timestamp,
      ],
    );
    db.run(
      `INSERT INTO briefing_narrative (scope, input_hash, narrative_text, generated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         input_hash = excluded.input_hash,
         narrative_text = excluded.narrative_text,
         generated_at = excluded.generated_at`,
      [EOD_BRIEF_KIND, eodInputHash(context), narrative, timestamp],
    );
  });
  persist();

  return { runId, period, narrative, suppressed };
}
