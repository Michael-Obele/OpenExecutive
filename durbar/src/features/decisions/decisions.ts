/**
 * Decisions — the approve/reject surface for gated Executive proposals.
 *
 * Port of `memory/decision_ledger.py` + `api/routes/decisions.py`.
 * A proposal sits as `status='proposed'` until a human approves or rejects it.
 * On approve the payload is optionally edited; the status becomes
 * `approved_unchanged` or `approved_with_edit`. The MCP calendar execution is
 * deferred — Durbar records the decision transition without calling an external
 * gateway.
 *
 * Reliability card aggregates per-class metrics over a trailing window.
 */

import type { Db } from "../../db.ts";

// ── types ──────────────────────────────────────────────────────────────────

export const STATUS_PROPOSED = "proposed";
export const STATUS_EXECUTED = "executed";
export const STATUS_APPROVED_UNCHANGED = "approved_unchanged";
export const STATUS_APPROVED_WITH_EDIT = "approved_with_edit";
export const STATUS_REJECTED = "rejected";
export const STATUS_AUTO_NO_RESPONSE = "auto_no_response";
export const STATUS_REVERSED = "reversed";
export const STATUS_FAILED = "failed";

export interface DecisionInstance {
  id: number;
  decision_class: string;
  created_at: string;
  department: string;
  originating_session_id: string | null;
  proposed_payload_json: string;
  idempotency_key: string | null;
  gate_mode: string;
  approver_person_id: number | null;
  confidence: number | null;
  status: string;
  resolved_at: string | null;
  resolver_person_id: number | null;
  final_payload_json: string | null;
  external_event_id: string | null;
  reversal_reason: string | null;
  severity: string;
}

export interface CalibrationBucket {
  confidence_min: number;
  confidence_max: number;
  count: number;
  unchanged_rate: number;
}

export interface ReliabilityCard {
  decision_class: string;
  window_start: string;
  window_end: string;
  volume: number;
  unchanged_approval_rate: number;
  edit_rate: number;
  rejection_rate: number;
  reversal_rate: number;
  no_response_rate: number;
  high_severity_misses: number;
  calibration: CalibrationBucket[];
}

// ── helpers ────────────────────────────────────────────────────────────────

function rowToInstance(row: Record<string, unknown>): DecisionInstance {
  return {
    id: row["id"] as number,
    decision_class: row["decision_class"] as string,
    created_at: row["created_at"] as string,
    department: (row["department"] as string) ?? "",
    originating_session_id: (row["originating_session_id"] as string | null) ?? null,
    proposed_payload_json: row["proposed_payload_json"] as string,
    idempotency_key: (row["idempotency_key"] as string | null) ?? null,
    gate_mode: (row["gate_mode"] as string) ?? "propose",
    approver_person_id: (row["approver_person_id"] as number | null) ?? null,
    confidence: (row["confidence"] as number | null) ?? null,
    status: row["status"] as string,
    resolved_at: (row["resolved_at"] as string | null) ?? null,
    resolver_person_id: (row["resolver_person_id"] as number | null) ?? null,
    final_payload_json: (row["final_payload_json"] as string | null) ?? null,
    external_event_id: (row["external_event_id"] as string | null) ?? null,
    reversal_reason: (row["reversal_reason"] as string | null) ?? null,
    severity: (row["severity"] as string) ?? "",
  };
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function payloadDiff(original: Record<string, unknown>, final: Record<string, unknown>): boolean {
  for (const key of ["title", "start", "end", "description"]) {
    if (original[key] !== final[key]) return true;
  }
  const origAtt = [...((original["attendee_emails"] as string[] | undefined) ?? [])].sort();
  const finalAtt = [...((final["attendee_emails"] as string[] | undefined) ?? [])].sort();
  if (origAtt.length !== finalAtt.length) return true;
  for (let i = 0; i < origAtt.length; i += 1) {
    if (origAtt[i] !== finalAtt[i]) return true;
  }
  return false;
}

// ── store ──────────────────────────────────────────────────────────────────

export function getDecisionInstance(db: Db, id: number): DecisionInstance | null {
  const row = db
    .query<Record<string, unknown>, [number]>("SELECT * FROM decision_instances WHERE id = ?",)
    .get(id);
  return row ? rowToInstance(row) : null;
}

export function listInstances(
  db: Db,
  decisionClass: string,
  opts: { status?: string | null; limit?: number } = {},
): DecisionInstance[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  if (opts.status) {
    return db
      .query<Record<string, unknown>, [string, string, number]>(
        "SELECT * FROM decision_instances WHERE decision_class = ? AND status = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(decisionClass, opts.status, limit)
      .map(rowToInstance);
  }
  return db
    .query<Record<string, unknown>, [string, number]>(
      "SELECT * FROM decision_instances WHERE decision_class = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(decisionClass, limit)
    .map(rowToInstance);
}

export function markResolved(
  db: Db,
  id: number,
  status: string,
  opts: {
    finalPayload?: Record<string, unknown> | null;
    resolverPersonId?: number | null;
    externalEventId?: string | null;
  } = {},
): boolean {
  const now = new Date().toISOString();
  const finalJson = opts.finalPayload ? JSON.stringify(opts.finalPayload) : null;
  const result = db.run(
    `UPDATE decision_instances
     SET status = ?, resolved_at = ?, resolver_person_id = ?, final_payload_json = ?, external_event_id = ?
     WHERE id = ? AND status = ?`,
    [status, now, opts.resolverPersonId ?? null, finalJson, opts.externalEventId ?? null, id, STATUS_PROPOSED],
  );
  return result.changes === 1;
}

export function approveDecision(
  db: Db,
  id: number,
  edits?: Record<string, unknown> | null,
): { instance: DecisionInstance | null; error?: string; statusCode?: number } {
  const instance = getDecisionInstance(db, id);
  if (!instance) return { instance: null, error: "Decision instance not found", statusCode: 404 };
  if (instance.status !== STATUS_PROPOSED) {
    return {
      instance: null,
      error: `Cannot approve a decision with status=${JSON.stringify(instance.status)}`,
      statusCode: 409,
    };
  }
  const original = parsePayload(instance.proposed_payload_json);
  const finalPayload: Record<string, unknown> = { ...original };
  if (edits) {
    for (const key of ["title", "start", "end", "description"]) {
      if (key in edits) finalPayload[key] = edits[key];
    }
    if ("attendee_emails" in edits) finalPayload["attendee_emails"] = edits["attendee_emails"];
  }
  const edited = payloadDiff(original, finalPayload);
  const outcome = edited ? STATUS_APPROVED_WITH_EDIT : STATUS_APPROVED_UNCHANGED;
  const ok = markResolved(db, id, outcome, { finalPayload });
  if (!ok) {
    return { instance: null, error: "Decision was already resolved", statusCode: 409 };
  }
  // Clear companion alert if present (best-effort).
  try {
    db.run("UPDATE alerts SET status = 'ack' WHERE source = 'decision_scheduling' AND external_id = ?", [
      `decision:${id}`,
    ]);
  } catch {
    // ignore
  }
  return { instance: getDecisionInstance(db, id) };
}

export function rejectDecision(
  db: Db,
  id: number,
): { instance: DecisionInstance | null; error?: string; statusCode?: number } {
  const instance = getDecisionInstance(db, id);
  if (!instance) return { instance: null, error: "Decision instance not found", statusCode: 404 };
  if (instance.status !== STATUS_PROPOSED) {
    return {
      instance: null,
      error: `Cannot reject a decision with status=${JSON.stringify(instance.status)}`,
      statusCode: 409,
    };
  }
  const ok = markResolved(db, id, STATUS_REJECTED);
  if (!ok) return { instance: null, error: "Decision was already resolved", statusCode: 409 };
  try {
    db.run("UPDATE alerts SET status = 'dismissed' WHERE source = 'decision_scheduling' AND external_id = ?", [
      `decision:${id}`,
    ]);
  } catch {
    // ignore
  }
  return { instance: getDecisionInstance(db, id) };
}

export function aggregateReliability(
  db: Db,
  decisionClass: string,
  windowDays = 30,
): ReliabilityCard {
  const now = new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .query<{ status: string; severity: string; confidence: number | null }, [string, string]>(
      "SELECT status, severity, confidence FROM decision_instances WHERE decision_class = ? AND created_at >= ?",
    )
    .all(decisionClass, since);

  const volume = rows.length;
  const counts = new Map<string, number>();
  let highSeverity = 0;
  const confWithStatus: Array<[number, string]> = [];
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    if (row.severity === "high") highSeverity += 1;
    if (row.confidence !== null) confWithStatus.push([row.confidence, row.status]);
  }

  const approvedTotal =
    (counts.get(STATUS_APPROVED_UNCHANGED) ?? 0) + (counts.get(STATUS_APPROVED_WITH_EDIT) ?? 0);
  const resolved = approvedTotal + (counts.get(STATUS_REJECTED) ?? 0);
  const executedOrApproved = (counts.get(STATUS_EXECUTED) ?? 0) + approvedTotal;

  const rate = (num: number, denom: number): number => (denom > 0 ? Math.round((num / denom) * 10000) / 10000 : 0);

  // Calibration buckets: 0.1-wide bands.
  const buckets = new Map<string, string[]>();
  for (const [conf, status] of confWithStatus) {
    const lo = Math.round(Math.floor(conf * 10) * 10) / 100;
    const hi = Math.round(lo * 10 + 1) / 10;
    const key = `${lo.toFixed(1)}:${hi.toFixed(1)}`;
    const arr = buckets.get(key) ?? [];
    arr.push(status);
    buckets.set(key, arr);
  }
  const calibration: CalibrationBucket[] = [];
  for (const [key, statuses] of [...buckets.entries()].sort()) {
    const [loStr, hiStr] = key.split(":");
    const lo = Number(loStr);
    const hi = Number(hiStr);
    const n = statuses.length;
    const nUnchanged = statuses.filter((s) => s === STATUS_APPROVED_UNCHANGED).length;
    calibration.push({
      confidence_min: lo,
      confidence_max: hi,
      count: n,
      unchanged_rate: n > 0 ? Math.round((nUnchanged / n) * 10000) / 10000 : 0,
    });
  }

  return {
    decision_class: decisionClass,
    window_start: since,
    window_end: now.toISOString(),
    volume,
    unchanged_approval_rate: rate(counts.get(STATUS_APPROVED_UNCHANGED) ?? 0, resolved),
    edit_rate: rate(counts.get(STATUS_APPROVED_WITH_EDIT) ?? 0, resolved),
    rejection_rate: rate(counts.get(STATUS_REJECTED) ?? 0, resolved),
    reversal_rate: rate(counts.get(STATUS_REVERSED) ?? 0, executedOrApproved),
    no_response_rate: rate(counts.get(STATUS_AUTO_NO_RESPONSE) ?? 0, volume),
    high_severity_misses: highSeverity,
    calibration,
  };
}
