/**
 * Briefing — today's snapshot and activity feeds.
 *
 * Port of `api/routes/today.py` + `briefing/narrative_cache.py` +
 * `briefing/brief_state.py`. The watermark is "since the last brief I actually
 * delivered" (from `briefing_narrative.generated_at`), not "last 24h". Cold
 * store falls back to 24h. Monitoring/watchlist findings are excluded from
 * proposals — they are not decisions.
 *
 * This is the read side; the write side is `features/briefings/morning-brief.ts`
 * which persists the narrative and watermark.
 */

import type { Db } from "../../db.ts";
import { BRIEF_KIND } from "../briefings/morning-brief.ts";

// ── types ──────────────────────────────────────────────────────────────────

export interface GoalBrief {
  readonly key_result: string;
  readonly current: string;
  readonly target: string;
  readonly status: string;
}

export interface DepartmentBriefItem {
  readonly slug: string;
  readonly title: string;
  readonly authority_level: string;
  readonly goal_count: number;
  readonly at_risk_count: number;
  readonly off_track_count: number;
  readonly awaiting_count: number;
  readonly attention_goals: readonly GoalBrief[];
}

export interface PersonBriefItem {
  readonly id: number;
  readonly full_name: string;
  readonly role: string;
  readonly is_principal: boolean;
  readonly preferred_channel: string;
  readonly awaiting_count: number;
  readonly soonest_sla_at: string | null;
  readonly status: string;
  readonly awaiting_reply_count: number;
  readonly oldest_awaiting_reply_at: string | null;
  readonly on_leave_until: string | null;
  readonly reachable_now: boolean;
  readonly next_window_at: string | null;
  readonly authority_scope: readonly string[];
  readonly department_slugs: readonly string[];
  readonly last_contact_at: string | null;
  readonly overdue: boolean;
  readonly priority: number;
  readonly insight: string | null;
}

export interface ProposalItem {
  readonly alert_id: number;
  readonly headline: string;
  readonly body: string;
  readonly routed_to_person_id: number | null;
  readonly suggested_action: string;
  readonly created_at: string;
  readonly topic_tags: readonly string[];
  readonly score: number;
  readonly category: string;
  readonly surfaced_reason: string | null;
  readonly decision_instance_id: number | null;
  readonly occurrence_count: number;
  readonly last_seen_at: string | null;
  readonly last_reviewed_at: string | null;
  readonly review_verdict: string;
  readonly review_note: string;
  readonly recommended_move: string;
  readonly why_now: string;
  readonly due_at: string | null;
  readonly superseded_count: number;
  readonly suggested_workflow: string;
}

export interface TodayResponse {
  readonly departments: readonly DepartmentBriefItem[];
  readonly people: readonly PersonBriefItem[];
  readonly proposals: readonly ProposalItem[];
  readonly narrative: string | null;
  readonly in_flight: readonly unknown[];
  readonly awaiting: readonly unknown[];
  readonly talent: readonly unknown[];
  readonly onboarding: readonly unknown[];
  readonly practice_clients: readonly unknown[];
  readonly caller_person_id: number | null;
  readonly handled_overnight: readonly unknown[];
}

export interface ActivityItem {
  readonly kind: string;
  readonly summary: string;
  readonly actor: string;
  readonly target: string | null;
  readonly department: string | null;
  readonly at: string;
}

export interface ActivityResponse {
  readonly items: readonly ActivityItem[];
}

export interface DailyActivityCount {
  readonly date: string;
  readonly count: number;
}

export interface DailyActivityResponse {
  readonly days: readonly DailyActivityCount[];
}

// ── helpers ────────────────────────────────────────────────────────────────

const COLD_START_WINDOW_HOURS = 24;

function sinceFor(db: Db, kind: string, now: Date = new Date()): string {
  const row = db
    .query<
      { generated_at: string },
      [string]
    >("SELECT generated_at FROM briefing_narrative WHERE scope = ?")
    .get(kind);
  if (row?.generated_at) return row.generated_at;
  return new Date(
    now.getTime() - COLD_START_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
}

function isActionable(source: string): boolean {
  return !source.startsWith("monitoring") && !source.startsWith("watchlist");
}

function parseDecisionInstanceId(topicTags: readonly string[]): number | null {
  for (const tag of topicTags) {
    if (tag.startsWith("decision_instance:")) {
      const suffix = tag.slice("decision_instance:".length);
      const n = Number(suffix);
      if (Number.isInteger(n)) return n;
    }
  }
  return null;
}

// ── builders ───────────────────────────────────────────────────────────────

export function buildToday(
  db: Db,
  callerPersonId: number | null = null,
): TodayResponse {
  // Departments with goal health.
  const deptRows = db
    .query<
      { slug: string; title: string; authority_level: string },
      []
    >("SELECT slug, title, authority_level FROM departments ORDER BY slug")
    .all();

  // Awaiting counts per department from scheduled_actions (pending, with department).
  const awaitingByDept = new Map<string, number>();
  try {
    const rows = db
      .query<
        { department: string; cnt: number },
        []
      >("SELECT department, COUNT(*) as cnt FROM scheduled_actions WHERE status = 'pending' AND department != '' GROUP BY department")
      .all();
    for (const r of rows) awaitingByDept.set(r.department, r.cnt);
  } catch {
    // scheduled_actions may not have department column on old DBs — ignore.
  }

  const departments: DepartmentBriefItem[] = deptRows.map((dept) => {
    const goals = db
      .query<
        {
          key_result: string;
          current: string;
          target: string;
          status: string;
          id: number;
        },
        [string]
      >(
        "SELECT id, key_result, current, target, status FROM department_goals WHERE department_slug = ? ORDER BY id",
      )
      .all(dept.slug);

    const atRisk = goals.filter((g) => g.status === "at_risk");
    const offTrack = goals.filter((g) => g.status === "off_track");
    const attention = [...offTrack, ...atRisk]
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "off_track" ? -1 : 1;
        return a.id - b.id;
      })
      .slice(0, 3)
      .map((g) => ({
        key_result: g.key_result,
        current: g.current,
        target: g.target,
        status: g.status,
      }));

    return {
      slug: dept.slug,
      title: dept.title,
      authority_level: dept.authority_level,
      goal_count: goals.length,
      at_risk_count: atRisk.length,
      off_track_count: offTrack.length,
      awaiting_count: awaitingByDept.get(dept.slug) ?? 0,
      attention_goals: attention,
    };
  });

  // People with awaiting counts.
  const peopleRows = db
    .query<
      {
        id: number;
        full_name: string;
        role: string;
        is_principal: number;
        preferred_channel: string;
        on_leave_until: string | null;
        department_slugs_json: string;
      },
      []
    >(
      "SELECT id, full_name, role, is_principal, preferred_channel, on_leave_until, department_slugs_json FROM people WHERE archived = 0 ORDER BY full_name",
    )
    .all();

  // Awaiting workflow counts per person (from workflow_runs where status='awaiting' — but Durbar uses scheduled_actions).
  // For now, use scheduled_actions pending assigned_to_person_id.
  const awaitingByPerson = new Map<number, number>();
  const soonestByPerson = new Map<number, string>();
  try {
    const rows = db
      .query<
        { assigned_to_person_id: number; run_at: string },
        []
      >("SELECT assigned_to_person_id, run_at FROM scheduled_actions WHERE status = 'pending' AND assigned_to_person_id IS NOT NULL ORDER BY run_at")
      .all();
    for (const r of rows) {
      awaitingByPerson.set(
        r.assigned_to_person_id,
        (awaitingByPerson.get(r.assigned_to_person_id) ?? 0) + 1,
      );
      if (!soonestByPerson.has(r.assigned_to_person_id)) {
        soonestByPerson.set(r.assigned_to_person_id, r.run_at);
      }
    }
  } catch {
    // ignore
  }

  // Authority scopes per person.
  const scopeByPerson = new Map<number, string[]>();
  try {
    const rows = db
      .query<
        { person_id: number; scope_token: string },
        []
      >("SELECT person_id, scope_token FROM person_authority_scope")
      .all();
    for (const r of rows) {
      const arr = scopeByPerson.get(r.person_id) ?? [];
      arr.push(r.scope_token);
      scopeByPerson.set(r.person_id, arr);
    }
  } catch {
    // ignore
  }

  const now = new Date();
  const people: PersonBriefItem[] = peopleRows.map((person) => {
    const awaiting = awaitingByPerson.get(person.id) ?? 0;
    const soonest = soonestByPerson.get(person.id) ?? null;
    const onLeave = person.on_leave_until
      ? new Date(person.on_leave_until) >= now
      : false;
    let departmentSlugs: string[] = [];
    try {
      departmentSlugs = JSON.parse(person.department_slugs_json) as string[];
    } catch {
      departmentSlugs = [];
    }

    // Simple status: on_leave > awaiting > clear
    let status = "clear";
    if (onLeave) status = "on_leave";
    else if (awaiting > 0) status = "awaiting";

    return {
      id: person.id,
      full_name: person.full_name,
      role: person.role,
      is_principal: person.is_principal === 1,
      preferred_channel: person.preferred_channel,
      awaiting_count: awaiting,
      soonest_sla_at: soonest,
      status,
      awaiting_reply_count: 0,
      oldest_awaiting_reply_at: null,
      on_leave_until: person.on_leave_until,
      reachable_now: !onLeave,
      next_window_at: null,
      authority_scope: scopeByPerson.get(person.id) ?? [],
      department_slugs: departmentSlugs,
      last_contact_at: null,
      overdue: false,
      priority: awaiting > 0 ? 20 : 0,
      insight: null,
    };
  });

  // Sort people by priority desc, then name.
  people.sort(
    (a, b) => b.priority - a.priority || a.full_name.localeCompare(b.full_name),
  );

  // Proposals from live alerts (unread, not snoozed, inside TTL).
  // Simplified: just unread alerts, filtered by isActionable.
  const alertRows = db
    .query<
      {
        id: number;
        headline: string;
        body: string;
        routed_to_person_id: number | null;
        suggested_action: string;
        created_at: string;
        topic_tags: string;
        source: string;
        severity: string;
        occurrence_count: number | null;
        last_seen_at: string | null;
        last_reviewed_at: string | null;
        review_verdict: string | null;
        review_note: string | null;
        recommended_move: string | null;
        why_now: string | null;
        due_at: string | null;
        suggested_workflow: string | null;
      },
      []
    >(
      "SELECT id, headline, body, routed_to_person_id, suggested_action, created_at, topic_tags, source, severity, occurrence_count, last_seen_at, last_reviewed_at, review_verdict, review_note, recommended_move, why_now, due_at, suggested_workflow FROM alerts WHERE status = 'unread' ORDER BY created_at DESC LIMIT 100",
    )
    .all();

  const proposals: ProposalItem[] = alertRows
    .filter((row) => isActionable(row.source))
    .map((row) => {
      let tags: string[] = [];
      try {
        tags = JSON.parse(row.topic_tags) as string[];
        if (!Array.isArray(tags)) tags = [];
      } catch {
        tags = [];
      }
      return {
        alert_id: row.id,
        headline: row.headline,
        body: row.body || row.headline,
        routed_to_person_id: row.routed_to_person_id,
        suggested_action: row.suggested_action ?? "",
        created_at: row.created_at,
        topic_tags: tags,
        score: 0,
        category: "action",
        surfaced_reason: null,
        decision_instance_id: parseDecisionInstanceId(tags),
        occurrence_count: row.occurrence_count ?? 1,
        last_seen_at: row.last_seen_at,
        last_reviewed_at: row.last_reviewed_at,
        review_verdict: row.review_verdict ?? "",
        review_note: row.review_note ?? "",
        recommended_move: row.recommended_move ?? "",
        why_now: row.why_now ?? "",
        due_at: row.due_at,
        superseded_count: 0,
        suggested_workflow: row.suggested_workflow ?? "",
      };
    });

  // Narrative from watermark cache.
  let narrative: string | null = null;
  try {
    const cached = db
      .query<
        { narrative_text: string },
        [string]
      >("SELECT narrative_text FROM briefing_narrative WHERE scope = ?")
      .get(BRIEF_KIND);
    if (cached) narrative = cached.narrative_text;
  } catch {
    // ignore
  }

  return {
    departments,
    people,
    proposals,
    narrative,
    in_flight: [],
    awaiting: [],
    talent: [],
    onboarding: [],
    practice_clients: [],
    caller_person_id: callerPersonId,
    handled_overnight: [],
  };
}

export function buildActivity(db: Db, limit: number): ActivityResponse {
  const since = sinceFor(db, BRIEF_KIND);
  const items: ActivityItem[] = [];

  // Audit log entries since watermark.
  try {
    const auditLimit = Math.max(1, Math.min(limit * 2, 100));
    const rows = db
      .query<
        { summary: string; event_type: string; ts: string },
        [string, number]
      >("SELECT summary, event_type, ts FROM audit_log WHERE ts > ? ORDER BY ts DESC LIMIT ?")
      .all(since, auditLimit);
    for (const row of rows) {
      items.push({
        kind: row.event_type,
        summary: row.summary,
        actor: "Executive",
        target: null,
        department: null,
        at: row.ts,
      });
    }
  } catch {
    // ignore
  }

  // Fired scheduled actions (done).
  try {
    const cap = Math.max(1, Math.min(limit, 100));
    const rows = db
      .query<
        {
          intent_text: string;
          channel: string;
          channel_ref: string;
          department: string;
          created_at: string;
          kind: string;
        },
        [number]
      >(
        "SELECT intent_text, channel, channel_ref, department, created_at, kind FROM scheduled_actions WHERE status = 'done' ORDER BY created_at DESC LIMIT ?",
      )
      .all(cap);
    for (const row of rows) {
      if (row.kind === "nudge_scan" || row.channel === "__internal__") continue;
      let kind = "action";
      if (row.kind === "proactive_nudge") kind = "nudge_sent";
      else if (row.kind === "dept_cadence") kind = "cadence_sent";
      else if (row.channel === "slack_dm" || row.channel === "discord_dm")
        kind = "dm_sent";
      else if (row.channel === "email") kind = "email_sent";
      items.push({
        kind,
        summary: row.intent_text,
        actor: "Executive",
        target: row.channel_ref || null,
        department: row.department || null,
        at: row.created_at,
      });
    }
  } catch {
    // ignore
  }

  // Sort by timestamp desc and cap.
  items.sort((a, b) => b.at.localeCompare(a.at));
  return { items: items.slice(0, limit) };
}

export function buildDailyActivity(
  db: Db,
  days: number,
): DailyActivityResponse {
  // Count audit_log entries per day.
  const counts = new Map<string, number>();
  try {
    const sinceIso = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();
    const rows = db
      .query<
        { date: string; cnt: number },
        [string]
      >("SELECT substr(ts, 1, 10) as date, COUNT(*) as cnt FROM audit_log WHERE ts >= ? GROUP BY date")
      .all(sinceIso);
    for (const r of rows) counts.set(r.date, r.cnt);
  } catch {
    // ignore
  }

  // Also count scheduled_actions done per day.
  try {
    const sinceIso2 = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();
    const rows = db
      .query<
        { date: string; cnt: number },
        [string]
      >("SELECT substr(created_at, 1, 10) as date, COUNT(*) as cnt FROM scheduled_actions WHERE status = 'done' AND created_at >= ? GROUP BY date")
      .all(sinceIso2);
    for (const r of rows) {
      counts.set(r.date, (counts.get(r.date) ?? 0) + r.cnt);
    }
  } catch {
    // ignore
  }

  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));

  const out: DailyActivityCount[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const date = d.toISOString().slice(0, 10);
    out.push({ date, count: counts.get(date) ?? 0 });
  }
  return { days: out };
}

export function resolveCallerPersonId(
  db: Db,
  email: string | null,
): number | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  try {
    const row = db
      .query<
        { id: number },
        [string]
      >("SELECT id FROM people WHERE lower(email) = ? AND archived = 0")
      .get(normalized);
    if (row) return row.id;
    return null;
  } catch {
    return null;
  }
}
