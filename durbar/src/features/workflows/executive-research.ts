/**
 * Executive research — specialists research, Executive routes.
 *
 * Port of `workflows/executive_research.py`. Five steps, matching upstream:
 *   1. gather_context       — company profile, initiatives, watchlist.
 *   2. research_specialists — fan out to specialists via the council.
 *   3. dedup               — collapse near-identical findings.
 *   4. executive_synthesis — Executive routes findings (DM, alert, follow-up).
 *   5. emit_artifact       — Markdown summary of what was researched + routed.
 *
 * This is the workflow that exercises the council end-to-end:
 * select → consult → synthesize. It reuses `src/features/council/council.ts`
 * rather than reimplementing the fan-out.
 *
 * Thin by design: prompt + context assembly + rendered Markdown artifact.
 * The weight is in the stores it reads.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "../../db.ts";
import type { Provider } from "../../providers.ts";
import { convene } from "../council/council.ts";

export const RESEARCH_KIND = "executive_research";

export interface ExecutiveResearchInput {
  readonly note?: string;
}

export interface ExecutiveResearchDeps {
  readonly db: Db;
  readonly provider: Provider;
  readonly now?: () => Date;
  readonly runId?: string;
}

export interface ResearchFinding {
  readonly title: string;
  readonly summary: string;
  readonly specialist: string;
}

export interface ExecutiveResearchResult {
  readonly runId: string;
  readonly period: string;
  readonly narrative: string;
  readonly findings: readonly ResearchFinding[];
}

/** Builds the research context block given to every specialist. */
export function renderResearchContext(
  db: Db,
  note?: string,
  now: Date = new Date(),
): string {
  const parts: string[] = [];

  const today = now.toISOString().slice(0, 10);
  parts.push(
    `TODAY'S DATE: ${today} (UTC). Scanning for recent developments.\n`,
  );

  if (note) parts.push(`USER NOTE: ${note}\n`);

  // Company profile — read directly via db to avoid cross-feature imports
  // (AGENTS.md: features talk to DB via db.ts). Minimal inline parsing.
  let profileName = "";
  let profileIndustry = "";
  let profileStage = "";
  let profileMission = "";
  let profileCompetitors: string[] = [];
  try {
    const row = db
      .query<
        { data: string },
        []
      >("SELECT data FROM company_profile WHERE id = 1")
      .get();
    if (row?.data) {
      const parsed = JSON.parse(row.data) as Record<string, unknown>;
      profileName = typeof parsed["name"] === "string" ? parsed["name"] : "";
      profileIndustry =
        typeof parsed["industry"] === "string" ? parsed["industry"] : "";
      profileStage = typeof parsed["stage"] === "string" ? parsed["stage"] : "";
      profileMission =
        typeof parsed["mission"] === "string" ? parsed["mission"] : "";
      const cl = parsed["competitive_landscape"] as
        | Record<string, unknown>
        | undefined;
      if (cl && Array.isArray(cl["primary_competitors"])) {
        profileCompetitors = (cl["primary_competitors"] as unknown[]).filter(
          (x): x is string => typeof x === "string",
        );
      }
    }
  } catch {
    // ignore parse errors — profile is optional
  }
  if (profileName) {
    parts.push(
      `COMPANY: ${profileName} — ${profileIndustry} (${profileStage})`,
    );
    if (profileMission) parts.push(`Mission: ${profileMission}`);
    if (profileCompetitors.length > 0) {
      parts.push(`Competitors: ${profileCompetitors.join(", ")}`);
    }
    parts.push("");
  }

  // Initiatives — direct db query to avoid cross-feature import
  let activeInitiatives: Array<{
    title: string;
    status: string;
    summary: string;
  }> = [];
  try {
    const rows = db
      .query<
        { title: string; status: string; summary: string },
        []
      >("SELECT title, status, summary FROM initiatives ORDER BY updated_at DESC")
      .all();
    activeInitiatives = rows.filter(
      (r) => r.status !== "completed" && r.status !== "done",
    );
  } catch {
    // ignore — initiatives table may not exist on old DBs
  }
  if (activeInitiatives.length > 0) {
    parts.push("ACTIVE INITIATIVES:");
    for (const item of activeInitiatives.slice(0, 10)) {
      parts.push(
        `- ${item.title} (${item.status})${item.summary ? `: ${item.summary.slice(0, 120)}` : ""}`,
      );
    }
    parts.push("");
  }

  // Watchlist — direct db query to avoid cross-feature import
  let watchlistItems: Array<{
    slug: string;
    signal_type: string;
    target: string;
  }> = [];
  try {
    const rows = db
      .query<
        { slug: string; signal_type: string; target: string },
        []
      >("SELECT slug, signal_type, target FROM watchlist WHERE enabled = 1 ORDER BY id")
      .all();
    watchlistItems = rows;
  } catch {
    // ignore — watchlist table may not exist on old DBs
  }
  if (watchlistItems.length > 0) {
    parts.push("ALREADY ON THE WATCHLIST:");
    for (const item of watchlistItems.slice(0, 20)) {
      parts.push(`- ${item.slug} [${item.signal_type}] target=${item.target}`);
    }
    parts.push("");
  }

  // Department watch interests
  try {
    const depts = db
      .query<
        { slug: string; watched_entities_json: string },
        []
      >("SELECT slug, watched_entities_json FROM departments ORDER BY slug")
      .all();
    const interestLines: string[] = [];
    for (const dept of depts) {
      try {
        const entities: unknown = JSON.parse(dept.watched_entities_json);
        if (Array.isArray(entities) && entities.length > 0) {
          const names = (entities as string[])
            .map((e) => String(e).trim())
            .filter(Boolean);
          if (names.length > 0)
            interestLines.push(`- ${dept.slug}: ${names.join(", ")}`);
        }
      } catch {
        // ignore malformed JSON
      }
    }
    if (interestLines.length > 0) {
      parts.push("DEPARTMENT WATCH INTERESTS:");
      parts.push(...interestLines);
      parts.push("");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !message.includes("no such column") &&
      !message.includes("no such table")
    ) {
      throw error;
    }
  }

  parts.push(
    "Research within your domain. Use what you know to surface findings relevant to this company. " +
      "The Executive will decide what to do with each finding.",
  );

  return parts.join("\n");
}

/** Deduplicates findings by title (case-insensitive). */
export function dedupFindings(
  findings: readonly ResearchFinding[],
): ResearchFinding[] {
  const seen = new Set<string>();
  const out: ResearchFinding[] = [];
  for (const finding of findings) {
    const key = finding.title.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

export const RESEARCH_SYNTHESIS_PROMPT = `You are the user's Executive reviewing research findings from your specialist council.

## DEFAULT IS IGNORE

Most findings DO NOT warrant action. Only route a finding when all three are true:
  (i)   it is specifically actionable for this company today,
  (ii)  there is a verifiable next step a named human can take in <15 minutes, AND
  (iii) the audience would be worse off without seeing it now.
If any one of those is false, IGNORE.

## ROUTING OPTIONS

When you do act, pick the SMALLEST audience that owns the matter.
  (a) DM a single named person — preferred for tactical items.
  (b) Message a department channel when no single human owns it.
  (c) Surface as briefing card — rare, only when the principal must decide.
  (d) Schedule a follow-up for time-shifted chases.

After your tool calls, emit a SHORT Markdown summary (≤150 words):
  **Acted on:** (bullets — one per action)
  **Quiet:** (one line — N findings reviewed, K ignored)

Skip headers with no content. Be terse.`;

export async function runExecutiveResearch(
  input: ExecutiveResearchInput,
  deps: ExecutiveResearchDeps,
): Promise<ExecutiveResearchResult> {
  const { db, provider } = deps;
  const now = deps.now?.() ?? new Date();
  const period = now.toISOString().slice(0, 10);

  // Step 1: gather_context
  const researchContext = renderResearchContext(db, input.note, now);

  // Step 2: research_specialists — fan out via the council.
  // The research question is the context itself: each specialist reads the
  // company state and surfaces what matters in their domain.
  const question = researchContext;

  let councilAnswer = "";
  let rawFindings: ResearchFinding[] = [];

  try {
    const result = await convene(question, {
      provider,
      db,
      context: researchContext,
    });
    councilAnswer = result.answer;

    // Each consultation is one specialist's analysis — treat each as a finding.
    rawFindings = result.consultations.map((c) => ({
      title: `${c.title}: ${c.analysis.slice(0, 80)}`,
      summary: c.analysis,
      specialist: c.specialist,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`executive_research council failed: ${message}`);
  }

  // Step 3: dedup
  const deduped = dedupFindings(rawFindings);

  // Step 4: executive_synthesis — route findings via a synthesis call.
  let synthesisNarrative = "";
  if (deduped.length > 0) {
    const findingsBlock = deduped
      .map(
        (f, i) =>
          `#${i + 1} [${f.specialist}] ${f.title}\n  ${f.summary.slice(0, 300)}`,
      )
      .join("\n\n");

    try {
      synthesisNarrative = await provider.chat([
        { role: "system", content: RESEARCH_SYNTHESIS_PROMPT },
        {
          role: "user",
          content: `FINDINGS FROM YOUR SPECIALIST COUNCIL:\n\n${findingsBlock}\n\nRoute each finding or leave it quiet. Cite sources in outbound messages.`,
        },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`executive_research synthesis failed: ${message}`);
      synthesisNarrative = `_Synthesis failed: ${message}_`;
    }
  } else {
    synthesisNarrative = "No findings surfaced this run.";
  }

  // Step 5: emit_artifact
  const lines: string[] = ["# Executive research"];
  if (input.note) lines.push(`\n_Note: ${input.note}_\n`);

  if (councilAnswer) {
    lines.push(`\n${councilAnswer.trim()}`);
  }

  if (synthesisNarrative) {
    lines.push(`\n${synthesisNarrative.trim()}`);
  }

  if (deduped.length > 0) {
    lines.push(`\n\n## Findings reviewed`);
    lines.push(`_${deduped.length} finding(s) after dedup._\n`);
    for (const finding of deduped.slice(0, 25)) {
      lines.push(
        `- [${finding.specialist}] **${finding.title}** — ${finding.summary.slice(0, 160)}`,
      );
    }
  }

  const narrative = lines.join("\n");

  const runId = deps.runId ?? randomUUID();
  const timestamp = now.toISOString();

  db.run(
    `INSERT INTO workflow_runs
       (run_id, workflow_name, title, status, inputs, artifact, created_at, updated_at)
     VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?)`,
    [
      runId,
      "executive_research",
      `Executive Research — ${period}`,
      JSON.stringify(input),
      narrative,
      timestamp,
      timestamp,
    ],
  );

  return { runId, period, narrative, findings: deduped };
}
