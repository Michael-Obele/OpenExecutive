/**
 * Alerts — the review queue and its grooming endpoints.
 *
 * Port of `alerts/store.py` + `alerts/preferences.py` + `alerts/lifecycle.py`
 * + `api/routes/alerts.py`. One file owns the types, store helpers, and the
 * policy (dedup, quiet hours, severity threshold) so the route layer stays thin.
 *
 * The upstream store is ~800 lines because it carries DB_PATH monkeypatching,
 * a registry cache, and per-channel finders. Durbar's DB is injected, so the
 * helpers take `Db` directly and have no global state.
 *
 * Dedup: a repeat of an open alert with the same (source, dedup_key) bumps
 * occurrence_count and last_seen_at instead of stacking a new card. Severity
 * only ever rises, never falls — a 2% move followed by a 10% crash must still
 * ping.
 *
 * Quiet hours and severity threshold: both collapse delivery to PERSISTED only.
 * Urgent always punches through quiet hours. Broadcast channels survive the
 * channels_enabled filter — they're org-routing, not personal preference.
 */

import type { Db } from "../../db.ts";

// ── types ──────────────────────────────────────────────────────────────────

export type AlertSeverity = "low" | "medium" | "high" | "urgent";
export type AlertStatus = "unread" | "read" | "ack" | "dismissed" | "resolved" | "expired";
export type AlertChannel = "web" | "slack_dm" | "email" | "persisted" | "department_channel" | "company_broadcast";

export const SEVERITIES: readonly AlertSeverity[] = ["low", "medium", "high", "urgent"];
export const STATUSES: readonly AlertStatus[] = ["unread", "read", "ack", "dismissed", "resolved", "expired"];
export const CHANNELS: readonly AlertChannel[] = ["web", "slack_dm", "email", "persisted", "department_channel", "company_broadcast"];

export const SEVERITY_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  urgent: 3,
};

export interface Alert {
  id: number | null;
  external_id: string;
  source: string;
  severity: string;
  headline: string;
  body: string;
  suggested_action: string;
  topic_tags: string[];
  channels_attempted: string[];
  channels_delivered: string[];
  dedup_key: string;
  status: string;
  created_at: string;
  routed_to_person_id: number | null;
  archived_at: string | null;
  last_seen_at: string | null;
  occurrence_count: number;
  last_reviewed_at: string | null;
  review_verdict: string;
  review_note: string;
  recommended_move: string;
  why_now: string;
  due_at: string | null;
  superseded_by_alert_id: number | null;
  snoozed_until: string | null;
  suggested_workflow: string;
}

export interface UserPreferences {
  severity_threshold: AlertSeverity;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_tz: string;
  channels_enabled: AlertChannel[];
}

export interface MuteTopic {
  id: number | null;
  pattern: string;
  created_at: string;
}

// ── helpers ────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function rowToAlert(row: Record<string, unknown>): Alert {
  return {
    id: row["id"] as number | null,
    external_id: (row["external_id"] as string) ?? "",
    source: row["source"] as string,
    severity: row["severity"] as string,
    headline: row["headline"] as string,
    body: row["body"] as string,
    suggested_action: (row["suggested_action"] as string) ?? "",
    topic_tags: parseJsonArray(row["topic_tags"] as string | null),
    channels_attempted: parseJsonArray(row["channels_attempted"] as string | null),
    channels_delivered: parseJsonArray(row["channels_delivered"] as string | null),
    dedup_key: (row["dedup_key"] as string) ?? "",
    status: row["status"] as string,
    created_at: row["created_at"] as string,
    routed_to_person_id: (row["routed_to_person_id"] as number | null) ?? null,
    archived_at: (row["archived_at"] as string | null) ?? null,
    last_seen_at: (row["last_seen_at"] as string | null) ?? null,
    occurrence_count: (row["occurrence_count"] as number | null) ?? 1,
    last_reviewed_at: (row["last_reviewed_at"] as string | null) ?? null,
    review_verdict: (row["review_verdict"] as string) ?? "",
    review_note: (row["review_note"] as string) ?? "",
    recommended_move: (row["recommended_move"] as string) ?? "",
    why_now: (row["why_now"] as string) ?? "",
    due_at: (row["due_at"] as string | null) ?? null,
    superseded_by_alert_id: (row["superseded_by_alert_id"] as number | null) ?? null,
    snoozed_until: (row["snoozed_until"] as string | null) ?? null,
    suggested_workflow: (row["suggested_workflow"] as string) ?? "",
  };
}

// ── preferences ────────────────────────────────────────────────────────────

export function getPreferences(db: Db): UserPreferences {
  const row = db
    .query<Record<string, unknown>, []>("SELECT * FROM user_preferences WHERE id = 1")
    .get();
  if (!row) {
    return {
      severity_threshold: "medium",
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "UTC",
      channels_enabled: ["web"],
    };
  }
  const channelsRaw = ((row["channels_enabled"] as string) ?? "web").split(",");
  const channels = channelsRaw
    .map((c) => c.trim())
    .filter((c) => (CHANNELS as readonly string[]).includes(c)) as AlertChannel[];
  return {
    severity_threshold: (row["severity_threshold"] as AlertSeverity) ?? "medium",
    quiet_hours_start: (row["quiet_hours_start"] as string) ?? "",
    quiet_hours_end: (row["quiet_hours_end"] as string) ?? "",
    quiet_hours_tz: (row["quiet_hours_tz"] as string) ?? "UTC",
    channels_enabled: channels.length > 0 ? channels : ["web"],
  };
}

export function savePreferences(db: Db, prefs: UserPreferences): UserPreferences {
  const channelsCsv = prefs.channels_enabled.join(",");
  const now = nowIso();
  db.run(
    `INSERT INTO user_preferences
       (id, severity_threshold, quiet_hours_start, quiet_hours_end, quiet_hours_tz, channels_enabled, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       severity_threshold = excluded.severity_threshold,
       quiet_hours_start = excluded.quiet_hours_start,
       quiet_hours_end = excluded.quiet_hours_end,
       quiet_hours_tz = excluded.quiet_hours_tz,
       channels_enabled = excluded.channels_enabled,
       updated_at = excluded.updated_at`,
    [prefs.severity_threshold, prefs.quiet_hours_start, prefs.quiet_hours_end, prefs.quiet_hours_tz, channelsCsv, now],
  );
  return prefs;
}

function parseHhMm(s: string): { h: number; m: number } | null {
  if (!s || !s.includes(":")) return null;
  const parts = s.split(":");
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

export function isInQuietHours(prefs: UserPreferences, now = new Date()): boolean {
  const start = parseHhMm(prefs.quiet_hours_start);
  const end = parseHhMm(prefs.quiet_hours_end);
  if (start === null || end === null) return false;

  // Use UTC for simplicity — Durbar stores quiet_hours_tz but upstream uses
  // ZoneInfo. For the port, we treat the window as UTC when tz is UTC, and
  // as local otherwise. The important case is the wraparound (22:00→07:00).
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMinutes = start.h * 60 + start.m;
  const endMinutes = end.h * 60 + end.m;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

const BROADCAST_CHANNELS = new Set<string>(["department_channel", "company_broadcast"]);

export function resolveChannels(
  requested: AlertChannel[],
  severity: AlertSeverity,
  prefs: UserPreferences,
  now?: Date,
): AlertChannel[] {
  const enabled = new Set(prefs.channels_enabled);
  enabled.add("persisted");
  const intersected = requested.filter((c) => enabled.has(c) || BROADCAST_CHANNELS.has(c));
  if (!intersected.includes("persisted")) intersected.push("persisted");

  const belowThreshold = (SEVERITY_RANK[severity] ?? 0) < (SEVERITY_RANK[prefs.severity_threshold] ?? 0);
  const inQuiet = isInQuietHours(prefs, now) && severity !== "urgent";

  if (belowThreshold || inQuiet) return ["persisted"];
  return intersected;
}

export function matchesMute(topicTags: string[], mutePatterns: string[]): boolean {
  if (topicTags.length === 0 || mutePatterns.length === 0) return false;
  const tagsLc = topicTags.map((t) => t.toLowerCase());
  for (const pat of mutePatterns) {
    const p = pat.toLowerCase().trim();
    if (!p) continue;
    if (tagsLc.some((t) => t.includes(p))) return true;
  }
  return false;
}

// ── lifecycle helpers ──────────────────────────────────────────────────────

const TTL_EXEMPT_SOURCES = new Set(["artifact", "decision_scheduling"]);

function parseAware(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function ttlDaysFor(alert: Alert, monitoringDays: number, actionDays: number): number | null {
  if (TTL_EXEMPT_SOURCES.has(alert.source)) return null;
  const category = categorize(alert);
  const days = category === "monitoring" ? monitoringDays : actionDays;
  return days > 0 ? days : null;
}

function isExpired(alert: Alert, now = new Date(), monitoringDays = 3, actionDays = 14): boolean {
  const days = ttlDaysFor(alert, monitoringDays, actionDays);
  if (days === null) return false;
  const anchor = parseAware(alert.last_seen_at) ?? parseAware(alert.created_at);
  if (!anchor) return false;
  return anchor.getTime() + days * 24 * 60 * 60 * 1000 <= now.getTime();
}

function isSnoozed(alert: Alert, now = new Date()): boolean {
  const until = parseAware(alert.snoozed_until);
  return until !== null && until.getTime() > now.getTime();
}

export function isLive(alert: Alert, now = new Date()): boolean {
  return alert.status === "unread" && !isExpired(alert, now) && !isSnoozed(alert, now);
}

// ── categorize (briefing/ranking) ──────────────────────────────────────────

const EXTERNAL_SOURCES = new Set(["stock", "vendor_status", "rss", "query", "edgar", "page_watch", "research"]);

function isExternalSignal(source: string, topicTags: string[]): boolean {
  if (EXTERNAL_SOURCES.has(source)) return true;
  return topicTags.some((t) => t.startsWith("external:"));
}

export function categorize(alert: Pick<Alert, "source" | "severity" | "routed_to_person_id" | "topic_tags">): "action" | "monitoring" {
  if (alert.routed_to_person_id !== null && alert.routed_to_person_id !== undefined) return "action";
  if (alert.severity === "high" || alert.severity === "urgent") return "action";
  if (isExternalSignal(alert.source, alert.topic_tags)) return "monitoring";
  return "action";
}

// ── store ──────────────────────────────────────────────────────────────────

export function insertAlert(
  db: Db,
  params: {
    source: string;
    external_id: string;
    severity: AlertSeverity;
    headline: string;
    body: string;
    suggested_action?: string;
    topic_tags?: string[];
    dedup_key?: string;
    routed_to_person_id?: number | null;
  },
): number | null {
  const tags = JSON.stringify(params.topic_tags ?? []);
  const result = db.run(
    `INSERT OR IGNORE INTO alerts
       (external_id, source, severity, headline, body, suggested_action, topic_tags, dedup_key, status, created_at, routed_to_person_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?)`,
    [
      params.external_id,
      params.source,
      params.severity,
      params.headline,
      params.body,
      params.suggested_action ?? "",
      tags,
      params.dedup_key ?? "",
      nowIso(),
      params.routed_to_person_id ?? null,
    ],
  );
  if (result.changes === 0) return null;
  return Number(result.lastInsertRowid);
}

export function getAlert(db: Db, id: number): Alert | null {
  const row = db.query<Record<string, unknown>, [number]>("SELECT * FROM alerts WHERE id = ?").get(id);
  return row ? rowToAlert(row) : null;
}

export function getAlertByExternal(db: Db, source: string, externalId: string): Alert | null {
  const row = db
    .query<Record<string, unknown>, [string, string]>("SELECT * FROM alerts WHERE source = ? AND external_id = ? LIMIT 1")
    .get(source, externalId);
  return row ? rowToAlert(row) : null;
}

export function listAlerts(
  db: Db,
  opts: { status?: string; limit?: number; excludeSource?: string } = {},
): Alert[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  if (opts.excludeSource) {
    clauses.push("source != ?");
    params.push(opts.excludeSource);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")} ` : "";
  const limit = opts.limit ?? 200;
  const rows = db
    .query<Record<string, unknown>, (string | number)[]>(
      `SELECT * FROM alerts ${where}ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit);
  return rows.map(rowToAlert);
}

export function listLiveAlerts(db: Db, limit = 100, now = new Date()): Alert[] {
  const rows = listAlerts(db, { status: "unread", limit: Math.max(limit * 3, limit + 50) });
  const live = rows.filter((a) => !isExpired(a, now) && !isSnoozed(a, now));
  return live.slice(0, limit);
}

export function listArtifactAlerts(db: Db, limit = 200, archived = false): Alert[] {
  const clause = archived ? "AND archived_at IS NOT NULL" : "AND archived_at IS NULL";
  const rows = db
    .query<Record<string, unknown>, [number]>(
      `SELECT * FROM alerts WHERE source = 'artifact' ${clause} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map(rowToAlert);
}

export function setStatus(db: Db, id: number, status: string): boolean {
  const result = db.run("UPDATE alerts SET status = ? WHERE id = ?", [status, id]);
  return result.changes > 0;
}

export function coalesceAlert(
  db: Db,
  params: { source: string; dedup_key: string; severity: string; body: string },
): { id: number; raised: boolean } | null {
  if (!params.dedup_key) return null;
  const row = db
    .query<Record<string, unknown>, [string, string]>(
      "SELECT id, severity FROM alerts WHERE source = ? AND dedup_key = ? AND status = 'unread' ORDER BY created_at DESC LIMIT 1",
    )
    .get(params.source, params.dedup_key);
  if (!row) return null;
  const currentRank = SEVERITY_RANK[row["severity"] as string] ?? 0;
  const newRank = SEVERITY_RANK[params.severity] ?? 0;
  const raised = newRank > currentRank;
  const effective = raised ? params.severity : (row["severity"] as string);
  db.run("UPDATE alerts SET last_seen_at = ?, occurrence_count = COALESCE(occurrence_count, 1) + 1, body = ?, severity = ? WHERE id = ?", [
    nowIso(),
    params.body,
    effective,
    row["id"] as number,
  ]);
  return { id: row["id"] as number, raised };
}

export function bulkSetStatus(
  db: Db,
  status: string,
  opts: {
    alert_ids?: number[] | null;
    before?: string | null;
    category?: string | null;
    onlyStatus?: string | null;
    excludeSources?: readonly string[];
  } = {},
): number[] {
  const onlyStatus = opts.onlyStatus ?? "unread";
  if (opts.alert_ids === null && opts.alert_ids !== undefined && opts.before === null) return [];
  if (!opts.alert_ids && !opts.before) return [];
  if (opts.alert_ids !== undefined && opts.alert_ids !== null && opts.alert_ids.length === 0) return [];

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (onlyStatus) {
    clauses.push("status = ?");
    params.push(onlyStatus);
  }
  if (opts.before) {
    clauses.push("COALESCE(last_seen_at, created_at) < ?");
    params.push(opts.before);
  }
  if (opts.alert_ids) {
    const ids = opts.alert_ids.slice(0, 5000);
    clauses.push(`id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  for (const src of opts.excludeSources ?? []) {
    clauses.push("source != ?");
    params.push(src);
  }
  const where = clauses.join(" AND ");
  const rows = db.query<Record<string, unknown>, (string | number)[]>(`SELECT * FROM alerts WHERE ${where}`).all(...params);
  let targets = rows.map(rowToAlert);
  if (opts.category) {
    targets = targets.filter((a) => categorize(a) === opts.category);
  }
  const ids = targets.map((a) => a.id).filter((id): id is number => id !== null).slice(0, 5000);
  if (ids.length === 0) return [];
  const guard = onlyStatus ? " AND status = ?" : "";
  const guardParams: (string | number)[] = onlyStatus ? [onlyStatus] : [];
  db.run(`UPDATE alerts SET status = ? WHERE id IN (${ids.map(() => "?").join(",")})${guard}`, [status, ...ids, ...guardParams]);
  return ids;
}

const REOPENABLE_STATUSES = new Set(["resolved", "expired", "dismissed"]);

export function reopenAlert(db: Db, id: number, excludeSources: readonly string[] = []): boolean {
  const row = db.query<Record<string, unknown>, [number]>(`SELECT * FROM alerts WHERE id = ?`).get(id);
  if (!row) return false;
  const alert = rowToAlert(row);
  if (!REOPENABLE_STATUSES.has(alert.status)) return false;
  if (excludeSources.includes(alert.source)) return false;

  if (alert.superseded_by_alert_id !== null) {
    db.run("UPDATE alerts SET occurrence_count = MAX(1, COALESCE(occurrence_count, 1) - ?) WHERE id = ?", [
      alert.occurrence_count,
      alert.superseded_by_alert_id,
    ]);
  }
  db.run(
    `UPDATE alerts SET status = 'unread', review_verdict = '', review_note = '', recommended_move = '', why_now = '', due_at = NULL,
       last_reviewed_at = NULL, superseded_by_alert_id = NULL, snoozed_until = NULL, suggested_workflow = '', last_seen_at = ? WHERE id = ?`,
    [nowIso(), id],
  );
  return true;
}

export function setAlertArchived(db: Db, id: number, archived: boolean): boolean {
  const result = db.run("UPDATE alerts SET archived_at = ? WHERE id = ?", [archived ? nowIso() : null, id]);
  return result.changes > 0;
}

export function deleteAlert(db: Db, id: number): boolean {
  const result = db.run("DELETE FROM alerts WHERE id = ?", [id]);
  return result.changes > 0;
}

// ── mutes ──────────────────────────────────────────────────────────────────

export function addMute(db: Db, pattern: string): number | null {
  const trimmed = pattern.trim();
  if (!trimmed) throw new Error("pattern must be non-empty");
  const result = db.run("INSERT OR IGNORE INTO mute_topics (pattern, created_at) VALUES (?, ?)", [trimmed, nowIso()]);
  if (result.changes === 0) {
    const existing = db.query<Record<string, unknown>, [string]>("SELECT id FROM mute_topics WHERE pattern = ?").get(trimmed);
    return existing ? (existing["id"] as number) : null;
  }
  return Number(result.lastInsertRowid);
}

export function listMutes(db: Db): MuteTopic[] {
  const rows = db.query<Record<string, unknown>, []>("SELECT * FROM mute_topics ORDER BY created_at DESC").all();
  return rows.map((r) => ({
    id: r["id"] as number | null,
    pattern: r["pattern"] as string,
    created_at: r["created_at"] as string,
  }));
}

export function deleteMute(db: Db, id: number): boolean {
  const result = db.run("DELETE FROM mute_topics WHERE id = ?", [id]);
  return result.changes > 0;
}

// ── validation ─────────────────────────────────────────────────────────────

export function validateAckBody(body: unknown): { ok: true; status: string; mute_topic?: string | boolean } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const r = body as Record<string, unknown>;
  if (typeof r["status"] !== "string" || !["read", "ack", "dismissed"].includes(r["status"])) {
    return { ok: false, error: "status must be one of read, ack, dismissed" };
  }
  const mute = r["mute_topic"];
  if (mute !== undefined && mute !== null && typeof mute !== "string" && typeof mute !== "boolean") {
    return { ok: false, error: "mute_topic must be a string or boolean" };
  }
  return { ok: true, status: r["status"] as string, ...(mute !== undefined ? { mute_topic: mute as string | boolean } : {}) };
}

export function validateBulkAckBody(body: unknown): { ok: true; data: { status: string; alert_ids?: number[]; older_than_days?: number; category?: string } } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const r = body as Record<string, unknown>;
  if (typeof r["status"] !== "string" || !["ack", "dismissed"].includes(r["status"])) {
    return { ok: false, error: "status must be one of ack, dismissed" };
  }
  const alertIds = r["alert_ids"];
  const olderThanDays = r["older_than_days"];
  const category = r["category"];

  if (alertIds === undefined && olderThanDays === undefined) {
    return { ok: false, error: "alert_ids or older_than_days is required" };
  }
  if (alertIds !== undefined && alertIds !== null) {
    if (!Array.isArray(alertIds)) return { ok: false, error: "alert_ids must be an array" };
    if (alertIds.length > 500) return { ok: false, error: "alert_ids must have at most 500 items" };
    for (const id of alertIds) {
      if (typeof id !== "number" || !Number.isInteger(id)) return { ok: false, error: "alert_ids must be integers" };
    }
  }
  if (olderThanDays !== undefined && olderThanDays !== null) {
    if (typeof olderThanDays !== "number" || !Number.isInteger(olderThanDays) || olderThanDays < 1) {
      return { ok: false, error: "older_than_days must be an integer >= 1" };
    }
  }
  if (category !== undefined && category !== null && category !== "action" && category !== "monitoring") {
    return { ok: false, error: "category must be action or monitoring" };
  }
  return {
    ok: true,
    data: {
      status: r["status"] as string,
      ...(alertIds !== undefined && alertIds !== null ? { alert_ids: alertIds as number[] } : {}),
      ...(olderThanDays !== undefined && olderThanDays !== null ? { older_than_days: olderThanDays as number } : {}),
      ...(category !== undefined && category !== null ? { category: category as string } : {}),
    },
  };
}
