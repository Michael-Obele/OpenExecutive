/**
 * Nudge engine — proactive heartbeat that decides what to chase.
 *
 * Port of `scheduler/nudge_engine.py` (667 lines). The Executive used to be
 * purely reactive; this fills the gap for stalled workflows, open commitments,
 * and idle initiatives. A `kind="nudge_scan"` heartbeat fires every
 * NUDGE_SCAN_INTERVAL_MINUTES (default 15) and each tick:
 *
 *   1. Selects candidates from three sources (stalled workflows, stale
 *      commitments, idle initiatives).
 *   2. Dedups via scope_key + per-source cooldowns.
 *   3. Routes via person's preferred channel (or defers to next window).
 *   4. Emits `kind="proactive_nudge"` rows for the scheduler to dispatch.
 *
 * Durbar's version keeps the same scope-key scheme and dedup logic, but
 * simplifies channel routing (no availability-window deferral — that needs
 * people.channel which is not yet ported). The scheduler's existing claim/
 * retry machinery handles delivery; no second background loop.
 */

import type { Db } from "../../db.ts";

// ── constants ────────────────────────────────────────────────────────────

export const SCOPE_PREFIX_STALLED = "nudge:stalled";
export const SCOPE_PREFIX_COMMITMENT = "nudge:commitment";
export const SCOPE_PREFIX_INITIATIVE = "nudge:initiative";

export const HEARTBEAT_KIND = "nudge_scan";
export const HEARTBEAT_CHANNEL = "__internal__";
export const HEARTBEAT_CHANNEL_REF = "nudge_engine";
export const HEARTBEAT_INTENT = "Proactive nudge engine — periodic scan.";

// Defaults mirror the reference's settings (from config.py)
export const DEFAULTS = {
  scanIntervalMinutes: 15,
  stalledLeadHours: 24,
  stalledMinQuietHours: 4,
  stalledCooldownHours: 24,
  commitmentStaleDays: 3,
  commitmentCooldownHours: 24,
  initiativeIdleDays: 7,
  initiativeCooldownDays: 7,
  maxPerScan: 5,
  maxPerPersonPerScan: 2,
  maxPerScope: 3,
  maxDeferDays: 7,
} as const;

// ── types ────────────────────────────────────────────────────────────────

export interface NudgeCandidate {
  scope_key: string;
  intent_text: string;
  source: string;
  urgency_seconds: number;
  cooldown_ms: number;
  person_id: number | null;
  originating_session_id?: string | null;
  department?: string;
  fallback_channel?: string | null;
  fallback_channel_ref?: string | null;
}

// ── helpers ──────────────────────────────────────────────────────────────

function parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ── candidate selectors ──────────────────────────────────────────────────

function selectStalledWorkflowCandidates(
  db: Db,
  now: Date,
  opts: { leadHours: number; minQuietHours: number; cooldownHours: number },
): NudgeCandidate[] {
  const out: NudgeCandidate[] = [];
  const leadMs = opts.leadHours * 3600 * 1000;
  const minQuietMs = opts.minQuietHours * 3600 * 1000;
  const cooldownMs = opts.cooldownHours * 3600 * 1000;

  let rows: Record<string, unknown>[] = [];
  try {
    rows = db
      .query<Record<string, unknown>, []>(
        "SELECT run_id, workflow_name, title, status, awaiting_person_id, awaiting_until, updated_at FROM workflow_runs WHERE status = 'awaiting_human'",
      )
      .all();
  } catch {
    return [];
  }

  for (const row of rows) {
    const personId = row["awaiting_person_id"] as number | null;
    if (!personId) continue;
    const awaitingUntil = parseIso(row["awaiting_until"] as string | null);
    if (!awaitingUntil || awaitingUntil.getTime() <= now.getTime()) continue;
    if (awaitingUntil.getTime() - now.getTime() > leadMs) continue;
    const updatedAt = parseIso(row["updated_at"] as string | null);
    if (updatedAt && now.getTime() - updatedAt.getTime() < minQuietMs) continue;

    const runId = row["run_id"] as string;
    const title = (row["title"] as string) || (row["workflow_name"] as string) || runId;
    const intent =
      `Nudge the approver about the paused workflow "${title}" (run_id=${runId}). ` +
      `It is awaiting a human decision and times out at ${awaitingUntil.toISOString()}. ` +
      `Send ONE concise message: name the workflow, state what's needed, and give a clear next action. Do not call schedule_followup.`;

    out.push({
      scope_key: `${SCOPE_PREFIX_STALLED}:${runId}`,
      intent_text: intent,
      source: "stalled",
      urgency_seconds: (awaitingUntil.getTime() - now.getTime()) / 1000,
      cooldown_ms: cooldownMs,
      person_id: personId,
    });
  }
  return out;
}

function selectStaleCommitmentCandidates(
  db: Db,
  now: Date,
  opts: { staleDays: number; cooldownHours: number },
): NudgeCandidate[] {
  const cutoff = new Date(now.getTime() - opts.staleDays * 24 * 3600 * 1000);
  const cooldownMs = opts.cooldownHours * 3600 * 1000;
  const out: NudgeCandidate[] = [];

  let rows: Record<string, unknown>[] = [];
  try {
    rows = db
      .query<Record<string, unknown>, [string]>(
        "SELECT id, channel, channel_ref, intent_text, originating_session_id, assigned_to_person_id, awaiting_response_since, department FROM scheduled_actions WHERE awaiting_response_since IS NOT NULL AND status IN ('pending', 'done') AND kind != 'proactive_nudge' AND awaiting_response_since <= ? ORDER BY awaiting_response_since",
      )
      .all(cutoff.toISOString());
  } catch {
    return [];
  }

  for (const r of rows) {
    const awaiting = parseIso(r["awaiting_response_since"] as string | null);
    if (!awaiting) continue;
    const actionId = r["id"] as number;
    const original = ((r["intent_text"] as string) ?? "").slice(0, 200);
    const intent =
      `Chase the open commitment from scheduled action #${actionId}: "${original}". ` +
      `No reply since ${awaiting.toISOString()}. Send ONE polite follow-up that references the original ask and gives a clear next action. Do not call schedule_followup.`;

    out.push({
      scope_key: `${SCOPE_PREFIX_COMMITMENT}:${actionId}`,
      intent_text: intent,
      source: "commitment",
      urgency_seconds: -(now.getTime() - awaiting.getTime()) / 1000,
      cooldown_ms: cooldownMs,
      person_id: (r["assigned_to_person_id"] as number | null) ?? null,
      originating_session_id: r["originating_session_id"] as string | null,
      department: (r["department"] as string) ?? "",
      fallback_channel: r["channel"] as string | null,
      fallback_channel_ref: r["channel_ref"] as string | null,
    });
  }
  return out;
}

function selectIdleInitiativeCandidates(
  db: Db,
  now: Date,
  opts: { idleDays: number; cooldownDays: number },
): NudgeCandidate[] {
  const threshold = new Date(now.getTime() - opts.idleDays * 24 * 3600 * 1000);
  const cooldownMs = opts.cooldownDays * 24 * 3600 * 1000;
  const out: NudgeCandidate[] = [];

  let rows: Record<string, unknown>[] = [];
  try {
    rows = db
      .query<Record<string, unknown>, []>(
        "SELECT id, title, status, updated_at, department FROM initiatives WHERE status = 'active'",
      )
      .all();
  } catch {
    return [];
  }

  for (const r of rows) {
    const updated = parseIso(r["updated_at"] as string | null);
    if (!updated || updated.getTime() >= threshold.getTime()) continue;
    const slug = (r["department"] as string) ?? "";

    // Check if dept cadence recently refreshed this department — if so, don't pile on
    if (slug) {
      try {
        const cadenceRow = db
          .query<Record<string, unknown>, [string, string]>(
            "SELECT 1 as x FROM scheduled_actions WHERE kind = 'dept_cadence' AND department = ? AND status IN ('done', 'running') AND run_at >= ? LIMIT 1",
          )
          .get(slug, threshold.toISOString());
        if (cadenceRow) continue;
      } catch {
        /* ignore */
      }
    }

    // Resolve owner via department head
    let personId: number | null = null;
    if (slug) {
      try {
        const dept = db
          .query<Record<string, unknown>, [string]>("SELECT head_person_id FROM departments WHERE slug = ?")
          .get(slug);
        if (dept) personId = dept["head_person_id"] as number | null;
      } catch {
        /* ignore */
      }
    }
    if (personId === null) continue;

    const title = r["title"] as string;
    const intent =
      `Check in on the active initiative "${title}". It is in status 'active' and was last updated on ` +
      `${(r["updated_at"] as string).slice(0, 10)}. Send ONE short message asking for a status update; cite the initiative by name. Do not call schedule_followup.`;

    out.push({
      scope_key: `${SCOPE_PREFIX_INITIATIVE}:${r["id"]}`,
      intent_text: intent,
      source: "initiative",
      urgency_seconds: (updated.getTime() - now.getTime()) / 1000,
      cooldown_ms: cooldownMs,
      person_id: personId,
      department: slug,
    });
  }
  return out;
}

// ── dedup & caps ─────────────────────────────────────────────────────────

function recentNudgeForScope(db: Db, scopeKey: string, since: Date): boolean {
  try {
    const row = db
      .query<Record<string, unknown>, [string, string]>(
        "SELECT 1 as x FROM scheduled_actions WHERE scope_key = ? AND kind = 'proactive_nudge' AND created_at >= ? LIMIT 1",
      )
      .get(scopeKey, since.toISOString());
    return !!row;
  } catch {
    return false;
  }
}

function countNudgesForScope(db: Db, scopeKey: string): number {
  try {
    const row = db
      .query<Record<string, unknown>, [string]>(
        "SELECT COUNT(*) as n FROM scheduled_actions WHERE scope_key = ? AND kind = 'proactive_nudge'",
      )
      .get(scopeKey);
    return (row?.["n"] as number) ?? 0;
  } catch {
    return 0;
  }
}

function applyCaps(
  candidates: NudgeCandidate[],
  opts: { maxTotal: number; maxPerPerson: number },
): NudgeCandidate[] {
  const ranked = [...candidates].sort((a, b) => a.urgency_seconds - b.urgency_seconds);
  const perPerson = new Map<number, number>();
  const accepted: NudgeCandidate[] = [];
  for (const c of ranked) {
    if (accepted.length >= opts.maxTotal) break;
    if (c.person_id !== null) {
      const count = perPerson.get(c.person_id) ?? 0;
      if (count >= opts.maxPerPerson) continue;
      perPerson.set(c.person_id, count + 1);
    }
    accepted.push(c);
  }
  return accepted;
}

// ── channel routing (simplified — no availability-window deferral) ───────

function routeCandidate(
  db: Db,
  candidate: NudgeCandidate,
): { channel: string; channel_ref: string } | null {
  if (candidate.person_id !== null) {
    // Look up person's preferred channel from people table
    try {
      const person = db
        .query<Record<string, unknown>, [number]>(
          "SELECT preferred_channel, email, slack_user_id, telegram_chat_id, discord_user_id FROM people WHERE id = ? AND archived = 0",
        )
        .get(candidate.person_id);
      if (!person) return null;
      const pref = (person["preferred_channel"] as string) ?? "any";
      // Map preferred_channel to scheduled_actions channel
      const channelMap: Record<string, { col: string; sched: string }> = {
        email: { col: "email", sched: "email" },
        slack: { col: "slack_user_id", sched: "slack_dm" },
        slack_dm: { col: "slack_user_id", sched: "slack_dm" },
        telegram: { col: "telegram_chat_id", sched: "telegram" },
        discord: { col: "discord_user_id", sched: "discord_dm" },
      };
      let entry = channelMap[pref];
      if (!entry) {
        // "any" or unknown — pick first available
        for (const [, v] of Object.entries(channelMap)) {
          if (person[v.col]) {
            entry = v;
            break;
          }
        }
      }
      if (!entry) return null;
      const ref = person[entry.col] as string | null;
      if (!ref) return null;
      return { channel: entry.sched, channel_ref: ref };
    } catch {
      return null;
    }
  }
  // No person — fallback to original action's channel (commitment source only)
  if (candidate.fallback_channel && candidate.fallback_channel_ref) {
    return { channel: candidate.fallback_channel, channel_ref: candidate.fallback_channel_ref };
  }
  return null;
}

// ── scan orchestration ───────────────────────────────────────────────────

export interface NudgeScanOpts {
  stalledLeadHours?: number;
  stalledMinQuietHours?: number;
  stalledCooldownHours?: number;
  commitmentStaleDays?: number;
  commitmentCooldownHours?: number;
  initiativeIdleDays?: number;
  initiativeCooldownDays?: number;
  maxPerScan?: number;
  maxPerPersonPerScan?: number;
  maxPerScope?: number;
}

/**
 * One scan pass: collect → cap → dedup → route → insert. Returns count emitted.
 * Mirrors `run_nudge_scan` in the reference.
 */
export function runNudgeScan(
  db: Db,
  now = new Date(),
  opts: NudgeScanOpts = {},
): number {
  const o = { ...DEFAULTS, ...opts } as typeof DEFAULTS & NudgeScanOpts;

  const candidates: NudgeCandidate[] = [];
  try {
    candidates.push(
      ...selectStalledWorkflowCandidates(db, now, {
        leadHours: o.stalledLeadHours ?? DEFAULTS.stalledLeadHours,
        minQuietHours: o.stalledMinQuietHours ?? DEFAULTS.stalledMinQuietHours,
        cooldownHours: o.stalledCooldownHours ?? DEFAULTS.stalledCooldownHours,
      }),
    );
  } catch {
    /* source failed */
  }
  try {
    candidates.push(
      ...selectStaleCommitmentCandidates(db, now, {
        staleDays: o.commitmentStaleDays ?? DEFAULTS.commitmentStaleDays,
        cooldownHours: o.commitmentCooldownHours ?? DEFAULTS.commitmentCooldownHours,
      }),
    );
  } catch {
    /* source failed */
  }
  try {
    candidates.push(
      ...selectIdleInitiativeCandidates(db, now, {
        idleDays: o.initiativeIdleDays ?? DEFAULTS.initiativeIdleDays,
        cooldownDays: o.initiativeCooldownDays ?? DEFAULTS.initiativeCooldownDays,
      }),
    );
  } catch {
    /* source failed */
  }

  if (candidates.length === 0) return 0;

  const ranked = applyCaps(candidates, {
    maxTotal: o.maxPerScan ?? DEFAULTS.maxPerScan,
    maxPerPerson: o.maxPerPersonPerScan ?? DEFAULTS.maxPerPersonPerScan,
  });

  let emitted = 0;
  const maxPerScope = o.maxPerScope ?? DEFAULTS.maxPerScope;

  for (const cand of ranked) {
    const since = new Date(now.getTime() - cand.cooldown_ms);
    if (recentNudgeForScope(db, cand.scope_key, since)) continue;
    if (maxPerScope > 0 && countNudgesForScope(db, cand.scope_key) >= maxPerScope) continue;

    const routed = routeCandidate(db, cand);
    if (!routed) continue;

    try {
      const nowIso = now.toISOString();
      db.run(
        "INSERT INTO scheduled_actions (created_at, run_at, channel, channel_ref, intent_text, originating_session_id, status, attempts, department, kind, assigned_to_person_id, scope_key) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, '', ?, ?, ?)",
        [
          nowIso,
          nowIso,
          routed.channel,
          routed.channel_ref,
          cand.intent_text,
          cand.originating_session_id ?? null,
          "proactive_nudge",
          cand.person_id,
          cand.scope_key,
        ],
      );
      emitted++;
    } catch {
      /* insert failed */
    }
  }
  return emitted;
}

// ── heartbeat bootstrap / chain ──────────────────────────────────────────

function heartbeatPending(db: Db): boolean {
  try {
    const row = db
      .query<Record<string, unknown>, [string]>(
        "SELECT 1 as x FROM scheduled_actions WHERE kind = ? AND status IN ('pending', 'running') LIMIT 1",
      )
      .get(HEARTBEAT_KIND);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Ensure exactly one pending nudge_scan row exists. Returns its id or null.
 * Mirrors `bootstrap_nudge_scan` in the reference.
 */
export function bootstrapNudgeScan(db: Db, now = new Date()): number | null {
  if (heartbeatPending(db)) return null;
  const runAt = new Date(now.getTime() + DEFAULTS.scanIntervalMinutes * 60 * 1000);
  try {
    const result = db.run(
      "INSERT INTO scheduled_actions (created_at, run_at, channel, channel_ref, intent_text, status, attempts, kind) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)",
      [now.toISOString(), runAt.toISOString(), HEARTBEAT_CHANNEL, HEARTBEAT_CHANNEL_REF, HEARTBEAT_INTENT, HEARTBEAT_KIND],
    );
    return Number(result.lastInsertRowid);
  } catch {
    return null;
  }
}

/**
 * Schedule the next nudge_scan tick. Called by the scheduler after each fire.
 * Mirrors `enqueue_next_scan` in the reference.
 */
export function enqueueNextScan(db: Db, after?: Date): number | null {
  const base = after ?? new Date();
  const runAt = new Date(base.getTime() + DEFAULTS.scanIntervalMinutes * 60 * 1000);
  try {
    const result = db.run(
      "INSERT INTO scheduled_actions (created_at, run_at, channel, channel_ref, intent_text, status, attempts, kind) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)",
      [base.toISOString(), runAt.toISOString(), HEARTBEAT_CHANNEL, HEARTBEAT_CHANNEL_REF, HEARTBEAT_INTENT, HEARTBEAT_KIND],
    );
    return Number(result.lastInsertRowid);
  } catch {
    return null;
  }
}
