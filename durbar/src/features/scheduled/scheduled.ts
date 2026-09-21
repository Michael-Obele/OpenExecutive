/**
 * Scheduled actions — inspection and cancellation.
 *
 * Port of `memory/episodic.py` (scheduled_actions table + helpers) +
 * `api/routes/scheduled.py`. The table already exists via migration 3; this
 * module owns the typed helpers so the route layer stays thin.
 *
 * Cancellation is gated by `SCHEDULED_ADMIN_TOKEN` when set (constant-time
 * compare), otherwise loopback-only. That policy lives in `src/index.ts` where
 * the request is available; this file only decides whether a row is
 * cancellable.
 */

import type { Db } from "../../db.ts";

// ── types ──────────────────────────────────────────────────────────────────

export interface ScheduledAction {
  id: number;
  created_at: string;
  run_at: string;
  channel: string;
  channel_ref: string;
  intent_text: string;
  originating_session_id: string | null;
  status: string;
  attempts: number;
  last_error: string;
  department: string;
  session_id: string;
  kind: string;
  assigned_to_person_id: number | null;
  awaiting_response_since: string | null;
  scope_key: string | null;
  required_scope: string | null;
}

export const VALID_STATUSES = new Set(["pending", "running", "done", "failed", "cancelled"]);

// ── helpers ────────────────────────────────────────────────────────────────

function rowToAction(row: Record<string, unknown>): ScheduledAction {
  return {
    id: row["id"] as number,
    created_at: row["created_at"] as string,
    run_at: row["run_at"] as string,
    channel: row["channel"] as string,
    channel_ref: row["channel_ref"] as string,
    intent_text: row["intent_text"] as string,
    originating_session_id: (row["originating_session_id"] as string | null) ?? null,
    status: row["status"] as string,
    attempts: row["attempts"] as number,
    last_error: (row["last_error"] as string) ?? "",
    department: (row["department"] as string) ?? "",
    session_id: (row["session_id"] as string) ?? "",
    kind: (row["kind"] as string) ?? "ad_hoc",
    assigned_to_person_id: (row["assigned_to_person_id"] as number | null) ?? null,
    awaiting_response_since: (row["awaiting_response_since"] as string | null) ?? null,
    scope_key: (row["scope_key"] as string | null) ?? null,
    required_scope: (row["required_scope"] as string | null) ?? null,
  };
}

// ── store ──────────────────────────────────────────────────────────────────

export function listScheduledActions(
  db: Db,
  status: string | null,
  limit: number,
  order: string,
): ScheduledAction[] {
  const dir = order === "desc" ? "DESC" : "ASC";
  if (status === null) {
    return db
      .query<Record<string, unknown>, [number]>(
        `SELECT * FROM scheduled_actions ORDER BY run_at ${dir} LIMIT ?`,
      )
      .all(limit)
      .map(rowToAction);
  }
  return db
    .query<Record<string, unknown>, [string, number]>(
      `SELECT * FROM scheduled_actions WHERE status = ? ORDER BY run_at ${dir} LIMIT ?`,
    )
    .all(status, limit)
    .map(rowToAction);
}

export function getScheduledAction(db: Db, id: number): ScheduledAction | null {
  const row = db
    .query<Record<string, unknown>, [number]>("SELECT * FROM scheduled_actions WHERE id = ?",)
    .get(id);
  return row ? rowToAction(row) : null;
}

/**
 * Attempts to cancel a scheduled action.
 *
 * Returns "not_found" if no row, "not_cancellable" if the row is already
 * running/done/failed/cancelled, otherwise marks it cancelled and returns
 * "cancelled".
 */
export function cancelScheduledAction(db: Db, id: number): "not_found" | "not_cancellable" | "cancelled" {
  const row = getScheduledAction(db, id);
  if (!row) return "not_found";
  if (row.status !== "pending") return "not_cancellable";
  db.run("UPDATE scheduled_actions SET status = 'cancelled' WHERE id = ?", [id]);
  return "cancelled";
}

// ── admin token helper ─────────────────────────────────────────────────────

/**
 * Constant-time string comparison to avoid timing leaks on the admin token.
 * Falls back to false when lengths differ without early exit on content.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
