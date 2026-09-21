/**
 * Memories — decisions, initiatives, advice.
 *
 * Port of `memory/episodic.py` + `api/routes/episodic.py`. One file owns the
 * types and store helpers so the route layer stays thin.
 *
 * Each kind has GET (list), PATCH (update), DELETE. The upstream store is
 * ~600 lines because it carries dedup windows, Honcho mirroring, and
 * department/session scoping. Durbar keeps the CRUD surface; dedup and
 * mirroring are deferred (they require Honcho and are not part of the State
 * API acceptance).
 */

import type { Db } from "../../db.ts";

// ── types ──────────────────────────────────────────────────────────────────

export interface Decision {
  id: number | null;
  timestamp: string;
  domain: string;
  summary: string;
  rationale: string;
  outcome: string;
  tags: string;
  department: string;
  session_id: string;
}

export interface Initiative {
  id: number | null;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  summary: string;
  department: string;
}

export interface Advice {
  id: number | null;
  timestamp: string;
  domain: string;
  query_summary: string;
  advice_summary: string;
  department: string;
  session_id: string;
}

// ── helpers ────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function rowToDecision(row: Record<string, unknown>): Decision {
  return {
    id: row["id"] as number | null,
    timestamp: row["timestamp"] as string,
    domain: row["domain"] as string,
    summary: row["summary"] as string,
    rationale: (row["rationale"] as string) ?? "",
    outcome: (row["outcome"] as string) ?? "",
    tags: (row["tags"] as string) ?? "",
    department: (row["department"] as string) ?? "",
    session_id: (row["session_id"] as string) ?? "",
  };
}

function rowToInitiative(row: Record<string, unknown>): Initiative {
  return {
    id: row["id"] as number | null,
    title: row["title"] as string,
    status: row["status"] as string,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
    summary: (row["summary"] as string) ?? "",
    department: (row["department"] as string) ?? "",
  };
}

function rowToAdvice(row: Record<string, unknown>): Advice {
  return {
    id: row["id"] as number | null,
    timestamp: row["timestamp"] as string,
    domain: row["domain"] as string,
    query_summary: row["query_summary"] as string,
    advice_summary: row["advice_summary"] as string,
    department: (row["department"] as string) ?? "",
    session_id: (row["session_id"] as string) ?? "",
  };
}

// ── decisions ──────────────────────────────────────────────────────────────

export function listDecisions(db: Db): Decision[] {
  const rows = db.query<Record<string, unknown>, []>("SELECT * FROM decisions ORDER BY timestamp DESC").all();
  return rows.map(rowToDecision);
}

export function getDecision(db: Db, id: number): Decision | null {
  const row = db.query<Record<string, unknown>, [number]>("SELECT * FROM decisions WHERE id = ?").get(id);
  return row ? rowToDecision(row) : null;
}

export function updateDecision(
  db: Db,
  id: number,
  patch: { domain?: string; summary?: string; rationale?: string; outcome?: string; tags?: string },
): boolean {
  const fields: Array<[string, string]> = [];
  if (patch.domain !== undefined) fields.push(["domain", patch.domain]);
  if (patch.summary !== undefined) fields.push(["summary", patch.summary]);
  if (patch.rationale !== undefined) fields.push(["rationale", patch.rationale]);
  if (patch.outcome !== undefined) fields.push(["outcome", patch.outcome]);
  if (patch.tags !== undefined) fields.push(["tags", patch.tags]);
  if (fields.length === 0) return getDecision(db, id) !== null;
  const setClause = fields.map(([name]) => `${name} = ?`).join(", ");
  const values = fields.map(([, value]) => value);
  const result = db.run(`UPDATE decisions SET ${setClause} WHERE id = ?`, [...values, id]);
  return result.changes > 0;
}

export function deleteDecision(db: Db, id: number): boolean {
  const result = db.run("DELETE FROM decisions WHERE id = ?", [id]);
  return result.changes > 0;
}

export function insertDecision(
  db: Db,
  params: { domain: string; summary: string; rationale?: string; outcome?: string; tags?: string; department?: string; session_id?: string },
): number {
  const now = nowIso();
  const result = db.run(
    "INSERT INTO decisions (timestamp, domain, summary, rationale, outcome, tags, department, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [now, params.domain, params.summary, params.rationale ?? "", params.outcome ?? "", params.tags ?? "", params.department ?? "", params.session_id ?? ""],
  );
  return Number(result.lastInsertRowid);
}

// ── initiatives ────────────────────────────────────────────────────────────

export function listInitiatives(db: Db): Initiative[] {
  const rows = db.query<Record<string, unknown>, []>("SELECT * FROM initiatives ORDER BY updated_at DESC").all();
  return rows.map(rowToInitiative);
}

export function getInitiative(db: Db, id: number): Initiative | null {
  const row = db.query<Record<string, unknown>, [number]>("SELECT * FROM initiatives WHERE id = ?").get(id);
  return row ? rowToInitiative(row) : null;
}

export function updateInitiative(
  db: Db,
  id: number,
  patch: { title?: string; status?: string; summary?: string },
): boolean {
  const fields: Array<[string, string]> = [];
  if (patch.title !== undefined) fields.push(["title", patch.title]);
  if (patch.status !== undefined) fields.push(["status", patch.status]);
  if (patch.summary !== undefined) fields.push(["summary", patch.summary]);
  if (fields.length === 0) return getInitiative(db, id) !== null;
  fields.push(["updated_at", nowIso()]);
  const setClause = fields.map(([name]) => `${name} = ?`).join(", ");
  const values = fields.map(([, value]) => value);
  const result = db.run(`UPDATE initiatives SET ${setClause} WHERE id = ?`, [...values, id]);
  return result.changes > 0;
}

export function deleteInitiative(db: Db, id: number): boolean {
  const result = db.run("DELETE FROM initiatives WHERE id = ?", [id]);
  return result.changes > 0;
}

export function insertInitiative(
  db: Db,
  params: { title: string; status: string; summary?: string; department?: string },
): number {
  const now = nowIso();
  const result = db.run("INSERT INTO initiatives (title, status, created_at, updated_at, summary, department) VALUES (?, ?, ?, ?, ?, ?)", [
    params.title,
    params.status,
    now,
    now,
    params.summary ?? "",
    params.department ?? "",
  ]);
  return Number(result.lastInsertRowid);
}

// ── advice ─────────────────────────────────────────────────────────────────

export function listAdvice(db: Db): Advice[] {
  const rows = db.query<Record<string, unknown>, []>("SELECT * FROM advice_given ORDER BY timestamp DESC").all();
  return rows.map(rowToAdvice);
}

export function getAdvice(db: Db, id: number): Advice | null {
  const row = db.query<Record<string, unknown>, [number]>("SELECT * FROM advice_given WHERE id = ?").get(id);
  return row ? rowToAdvice(row) : null;
}

export function updateAdvice(
  db: Db,
  id: number,
  patch: { domain?: string; query_summary?: string; advice_summary?: string },
): boolean {
  const fields: Array<[string, string]> = [];
  if (patch.domain !== undefined) fields.push(["domain", patch.domain]);
  if (patch.query_summary !== undefined) fields.push(["query_summary", patch.query_summary]);
  if (patch.advice_summary !== undefined) fields.push(["advice_summary", patch.advice_summary]);
  if (fields.length === 0) return getAdvice(db, id) !== null;
  const setClause = fields.map(([name]) => `${name} = ?`).join(", ");
  const values = fields.map(([, value]) => value);
  const result = db.run(`UPDATE advice_given SET ${setClause} WHERE id = ?`, [...values, id]);
  return result.changes > 0;
}

export function deleteAdvice(db: Db, id: number): boolean {
  const result = db.run("DELETE FROM advice_given WHERE id = ?", [id]);
  return result.changes > 0;
}

export function insertAdvice(
  db: Db,
  params: { domain: string; query_summary: string; advice_summary: string; department?: string; session_id?: string },
): number {
  const now = nowIso();
  const result = db.run(
    "INSERT INTO advice_given (timestamp, domain, query_summary, advice_summary, department, session_id) VALUES (?, ?, ?, ?, ?, ?)",
    [now, params.domain, params.query_summary, params.advice_summary, params.department ?? "", params.session_id ?? ""],
  );
  return Number(result.lastInsertRowid);
}
