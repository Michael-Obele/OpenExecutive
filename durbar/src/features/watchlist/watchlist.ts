/**
 * Watchlist — external-condition monitoring.
 *
 * Port of `monitoring/store.py` + `monitoring/models.py` + `api/routes/watchlist.py`.
 * The reference has a rich adapter registry and research policy; Durbar ports
 * the CRUD/state surface and stubs the polling/policy parts. Signals are
 * stored but never auto-generated.
 */

import type { Db } from "../../db.ts";

export type WatchlistMode = "active" | "dry_run";
export const MODES: readonly WatchlistMode[] = ["active", "dry_run"];
export const VALID_SEVERITIES = ["low", "medium", "high", "urgent"] as const;
export const VALID_CADENCES = ["real_time", "15min", "hourly", "daily", "weekly"] as const;

export interface WatchlistItem {
  id: number;
  slug: string;
  signal_type: string;
  target: string;
  config_json: string;
  trigger_json: string;
  cadence: string;
  severity_floor: string;
  severity_ceiling: string;
  route_to_specialist: string;
  route_to_department: string;
  route_to_person_id: number | null;
  mode: string;
  enabled: boolean;
  created_at: string;
  last_polled_at: string | null;
  baselined_at: string | null;
  last_fired_at: string | null;
  fired_count: number;
  dismiss_count: number;
  trust_score: number;
  notes: string;
  origin: string;
}

export interface ExternalSignal {
  id: number;
  watchlist_id: number;
  source_kind: string;
  source_external_id: string;
  captured_at: string;
  published_at: string | null;
  normalized_summary: string;
  raw_payload_json: string;
  provenance_url: string;
  severity_hint: string;
  dedup_key: string;
  processed_at: string | null;
  processed_outcome: string | null;
  promoted_alert_id: number | null;
  enrichment_json: string;
}

function nowIso(): string { return new Date().toISOString(); }

function rowToItem(row: Record<string, unknown>): WatchlistItem {
  return {
    id: row["id"] as number,
    slug: row["slug"] as string,
    signal_type: row["signal_type"] as string,
    target: row["target"] as string,
    config_json: (row["config_json"] as string) ?? "{}",
    trigger_json: (row["trigger_json"] as string) ?? "{}",
    cadence: (row["cadence"] as string) ?? "15min",
    severity_floor: (row["severity_floor"] as string) ?? "low",
    severity_ceiling: (row["severity_ceiling"] as string) ?? "urgent",
    route_to_specialist: (row["route_to_specialist"] as string) ?? "",
    route_to_department: (row["route_to_department"] as string) ?? "",
    route_to_person_id: (row["route_to_person_id"] as number | null) ?? null,
    mode: (row["mode"] as string) ?? "active",
    enabled: Boolean(row["enabled"]),
    created_at: row["created_at"] as string,
    last_polled_at: (row["last_polled_at"] as string | null) ?? null,
    baselined_at: (row["baselined_at"] as string | null) ?? null,
    last_fired_at: (row["last_fired_at"] as string | null) ?? null,
    fired_count: (row["fired_count"] as number) ?? 0,
    dismiss_count: (row["dismiss_count"] as number) ?? 0,
    trust_score: (row["trust_score"] as number) ?? 1,
    notes: (row["notes"] as string) ?? "",
    origin: (row["origin"] as string) ?? "manual",
  };
}

export function listWatchlist(db: Db, filters: { enabledOnly?: boolean; signalType?: string } = {}): WatchlistItem[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters.enabledOnly) { clauses.push("enabled = 1"); }
  if (filters.signalType) { clauses.push("signal_type = ?"); params.push(filters.signalType); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = params.length
    ? db.query<Record<string, unknown>, string[]>(`SELECT * FROM watchlist ${where} ORDER BY id`).all(...params)
    : db.query<Record<string, unknown>, []>(`SELECT * FROM watchlist ${where} ORDER BY id`).all();
  return rows.map(rowToItem);
}

export function getWatchlistBySlug(db: Db, slug: string): WatchlistItem | null {
  const row = db.query<Record<string, unknown>, [string]>("SELECT * FROM watchlist WHERE slug = ?").get(slug);
  return row ? rowToItem(row) : null;
}

export function getWatchlistById(db: Db, id: number): WatchlistItem | null {
  const row = db.query<Record<string, unknown>, [number]>("SELECT * FROM watchlist WHERE id = ?").get(id);
  return row ? rowToItem(row) : null;
}

export function createWatchlist(db: Db, data: { slug: string; signal_type: string; target: string; config?: Record<string, unknown>; trigger?: Record<string, unknown>; cadence?: string; severity_floor?: string; severity_ceiling?: string; mode?: string; route_to_specialist?: string; notes?: string }): WatchlistItem {
  const now = nowIso();
  db.run(
    `INSERT INTO watchlist (slug, signal_type, target, config_json, trigger_json, cadence, severity_floor, severity_ceiling, route_to_specialist, mode, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.slug, data.signal_type, data.target, JSON.stringify(data.config ?? {}), JSON.stringify(data.trigger ?? {}), data.cadence ?? "15min", data.severity_floor ?? "low", data.severity_ceiling ?? "urgent", data.route_to_specialist ?? "", data.mode ?? "active", data.notes ?? "", now],
  );
  const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id);
  const created = getWatchlistById(db, id);
  if (!created) throw new Error("Watchlist vanished after insert");
  return created;
}

export function updateWatchlist(db: Db, id: number, patch: Record<string, unknown>): WatchlistItem | null {
  const existing = getWatchlistById(db, id);
  if (!existing) return null;
  const allowed: Record<string, unknown> = {};
  if ("enabled" in patch) allowed["enabled"] = patch["enabled"] ? 1 : 0;
  if ("mode" in patch && typeof patch["mode"] === "string") allowed["mode"] = patch["mode"];
  if ("cadence" in patch && typeof patch["cadence"] === "string") allowed["cadence"] = patch["cadence"];
  if ("severity_floor" in patch && typeof patch["severity_floor"] === "string") allowed["severity_floor"] = patch["severity_floor"];
  if ("severity_ceiling" in patch && typeof patch["severity_ceiling"] === "string") allowed["severity_ceiling"] = patch["severity_ceiling"];
  if ("trigger" in patch && patch["trigger"] !== undefined) allowed["trigger_json"] = JSON.stringify(patch["trigger"]);
  if ("notes" in patch && typeof patch["notes"] === "string") allowed["notes"] = (patch["notes"] as string).slice(0, 500);
  if (Object.keys(allowed).length === 0) return existing;
  const sets = Object.keys(allowed).map((k) => `${k} = ?`).join(", ");
  const vals: Array<string | number | null> = [...Object.values(allowed) as Array<string | number | null>, id];
  db.run(`UPDATE watchlist SET ${sets} WHERE id = ?`, vals as unknown as Array<string | number>);
  return getWatchlistById(db, id);
}

export function deleteWatchlist(db: Db, slug: string): boolean {
  const result = db.run("DELETE FROM watchlist WHERE slug = ?", [slug]);
  return result.changes > 0;
}

export function listSignalsForWatchlist(db: Db, watchlistId: number, limit = 50): ExternalSignal[] {
  const rows = db.query<Record<string, unknown>, [number, number]>(
    `SELECT * FROM external_signals WHERE watchlist_id = ? ORDER BY captured_at DESC LIMIT ?`,
  ).all(watchlistId, limit);
  return rows.map((r) => ({
    id: r["id"] as number,
    watchlist_id: r["watchlist_id"] as number,
    source_kind: r["source_kind"] as string,
    source_external_id: r["source_external_id"] as string,
    captured_at: r["captured_at"] as string,
    published_at: (r["published_at"] as string | null) ?? null,
    normalized_summary: r["normalized_summary"] as string,
    raw_payload_json: (r["raw_payload_json"] as string) ?? "{}",
    provenance_url: r["provenance_url"] as string,
    severity_hint: (r["severity_hint"] as string) ?? "low",
    dedup_key: r["dedup_key"] as string,
    processed_at: (r["processed_at"] as string | null) ?? null,
    processed_outcome: (r["processed_outcome"] as string | null) ?? null,
    promoted_alert_id: (r["promoted_alert_id"] as number | null) ?? null,
    enrichment_json: (r["enrichment_json"] as string) ?? "{}",
  }));
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug) && slug.length <= 61 && slug.length >= 1;
}
