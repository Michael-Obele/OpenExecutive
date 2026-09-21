/**
 * Morning brief — a short proactive briefing for the principal.
 *
 * Port of `workflows/morning_brief.py`. Two steps, matching upstream:
 *   1. load_context — today's state: at-risk goals, proposals awaiting a
 *      decision, and what was acted on since the last brief.
 *   2. synthesize   — one screen of Markdown in the Executive's voice.
 *
 * Two upstream details are load-bearing and easy to lose in a port:
 *
 *   • The window is "since the last brief I *actually delivered*", not "the
 *     last 24 hours". On a cold store there is no prior brief, so it falls back
 *     to 24h. Getting this wrong turns "what changed" into "the latest N
 *     rows", which reads as noise and trains the reader to ignore the brief.
 *
 *   • Monitoring/watchlist findings are excluded. They are real, but they are
 *     not decisions, and mixing them into "Needs you" is what makes a brief
 *     skimmable-once and then ignored.
 *
 * Target audience is hardcoded to the principal: this is a personal-rhythm
 * artefact, not org coordination.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from '../../db.ts';
import type { Provider } from '../../providers.ts';

export const BRIEF_KIND = 'principal_brief_morning';

/** Cold-store window when no brief has ever been delivered. */
const COLD_START_WINDOW_HOURS = 24;

export interface MorningBriefInput {
  /** Human-readable period label; defaults to today's date. */
  readonly periodLabel?: string;
  /** Render the full brief even when nothing changed since the last one. */
  readonly forceFull?: boolean;
}

export interface MorningBriefDeps {
  readonly db: Db;
  readonly provider: Provider;
  /** Injectable clock — the watermark logic is untestable against Date.now(). */
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

export interface BriefContext {
  readonly since: string;
  readonly atRiskGoals: readonly AtRiskGoal[];
  readonly proposals: readonly Proposal[];
  readonly activity: readonly Activity[];
}

export interface MorningBriefResult {
  readonly runId: string;
  readonly period: string;
  readonly narrative: string;
  /** True when the one-line "nothing new" path was taken. */
  readonly suppressed: boolean;
}

/**
 * Start of the window: when the last brief was delivered, else 24h ago.
 *
 * Reads `briefing_narrative` rather than `workflow_runs` on purpose — a run can
 * be recorded without being delivered, and counting an undelivered run would
 * silently swallow whatever it contained.
 */
export function sinceFor(
  db: Db,
  kind: string,
  now: Date = new Date(),
): string {
  const row = db
    .query<{ generated_at: string }, [string]>(
      'SELECT generated_at FROM briefing_narrative WHERE scope = ?',
    )
    .get(kind);

  if (row?.generated_at) return row.generated_at;

  return new Date(
    now.getTime() - COLD_START_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
}

/**
 * Monitoring and watchlist findings are not decisions. Ported from the
 * `/today` route's exclusion so the brief and the page tell the same story.
 */
function isActionable(source: string): boolean {
  return !source.startsWith('monitoring') && !source.startsWith('watchlist');
}

export function gatherContext(db: Db, since: string): BriefContext {
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

/** Renders the context as plain text for the model. No prompt cleverness. */
export function renderContext(context: BriefContext, period: string): string {
  const lines: string[] = [`Period: ${period}`, `Since: ${context.since}`, ''];

  lines.push(`AT-RISK GOALS (${context.atRiskGoals.length})`);
  if (context.atRiskGoals.length === 0) lines.push('- none');
  for (const goal of context.atRiskGoals) {
    lines.push(
      `- [${goal.status}] ${goal.department}: ${goal.keyResult}` +
        (goal.current ? ` — current: ${goal.current}` : ''),
    );
  }

  lines.push('', `AWAITING A DECISION (${context.proposals.length})`);
  if (context.proposals.length === 0) lines.push('- none');
  for (const proposal of context.proposals) {
    lines.push(
      `- (${proposal.severity}) ${proposal.headline}` +
        (proposal.suggestedAction ? ` → ${proposal.suggestedAction}` : ''),
    );
  }

  lines.push('', `ACTED ON SINCE THE LAST BRIEF (${context.activity.length})`);
  if (context.activity.length === 0) lines.push('- nothing');
  for (const event of context.activity) lines.push(`- ${event.summary}`);

  return lines.join('\n');
}

export const SYSTEM_PROMPT = `You are the principal's chief of staff, writing their morning brief.

Write in one calm, direct voice. Never mention tools, agents, models, prompts, or
that a system produced this — the reader is the principal, and the machinery is
not their concern.

Rules:
- Lead with what actually changed. If nothing did, say so in one line and stop.
- Put anything needing a decision in its own short section, most urgent first.
- Name the single most important thing to decide today, or omit the section.
- At most 200 words. Terse beats thorough; this is read in under a minute.
- No preamble, no sign-off, no headings that only restate the word "brief".`;

export function isQuiet(context: BriefContext): boolean {
  return (
    context.atRiskGoals.length === 0 &&
    context.proposals.length === 0 &&
    context.activity.length === 0
  );
}

export async function runMorningBrief(
  input: MorningBriefInput,
  deps: MorningBriefDeps,
): Promise<MorningBriefResult> {
  const { db, provider } = deps;
  const now = deps.now?.() ?? new Date();
  const period = input.periodLabel ?? now.toISOString().slice(0, 10);

  const since = sinceFor(db, BRIEF_KIND, now);
  const context = gatherContext(db, since);

  // Step 1 done (load_context). Step 2 follows.
  const suppressed = isQuiet(context) && input.forceFull !== true;
  const narrative = suppressed
    ? 'Nothing new since the last brief.'
    : await provider.chat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: renderContext(context, period) },
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
        'morning_brief',
        `Morning Brief — ${period}`,
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
      [BRIEF_KIND, String(context.activity.length), narrative, timestamp],
    );
  });
  persist();

  return { runId, period, narrative, suppressed };
}
