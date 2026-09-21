/**
 * Talent — engagements, candidates, offers.
 *
 * Port of `talent/store.py` + `talent/models.py` + `talent/offers.py` +
 * `api/routes/talent.py`. The reference keeps three tables in the shared
 * `episodic_memory.db`; Durbar keeps them in the same SQLite file.
 *
 * Offer lifecycle: draft/pending_approval are the only insert states; extend
 * moves to extended and schedules nudges (stubbed); decision moves to a
 * terminal state (accepted/declined/expired/rescinded) and optionally places
 * the candidate. The DB-level partial unique index on (candidate_id) WHERE
 * status IN (draft,pending_approval,extended) is the real guard for the
 * one-open-offer invariant — the SELECT check has a race window.
 *
 * Graph matching (match/similar/reindex) is stubbed: it returns empty or
 * trivial scores so the route contract is stable without an embedding stack.
 */

import type { Db } from "../../db.ts";

// ── types ──────────────────────────────────────────────────────────────────

export type EngagementStatus = "open" | "on_hold" | "filled" | "cancelled";
export const ENGAGEMENT_STATUSES: readonly EngagementStatus[] = ["open", "on_hold", "filled", "cancelled"];

export type CandidateStage = "lead" | "screened" | "interviewed" | "offer" | "placed" | "rejected";
export const CANDIDATE_STAGES: readonly CandidateStage[] = ["lead", "screened", "interviewed", "offer", "placed", "rejected"];

export type OfferStatus = "draft" | "pending_approval" | "extended" | "accepted" | "declined" | "expired" | "rescinded";
export const OFFER_STATUSES: readonly OfferStatus[] = ["draft", "pending_approval", "extended", "accepted", "declined", "expired", "rescinded"];
export const OPEN_OFFER_STATUSES: readonly OfferStatus[] = ["draft", "pending_approval", "extended"];
export const TERMINAL_OFFER_STATUSES: readonly OfferStatus[] = ["accepted", "declined", "expired", "rescinded"];

export interface Engagement {
  id: number;
  role_title: string;
  department: string;
  status: EngagementStatus;
  location: string;
  comp_band: string;
  must_haves: string;
  description: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface Candidate {
  id: number;
  engagement_id: number;
  full_name: string;
  current_title: string;
  current_company: string;
  location: string;
  email: string | null;
  linkedin_url: string | null;
  source: string;
  stage: CandidateStage;
  fit_score: number | null;
  screening_summary: string;
  notes: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface Offer {
  id: number;
  candidate_id: number;
  engagement_id: number;
  status: OfferStatus;
  comp_summary: string;
  package_md: string;
  note: string;
  expires_at: string | null;
  extended_at: string;
  decided_at: string;
  approval_run_id: string;
  approved_by_person_id: number | null;
  nudge_action_ids: number[];
  archived: boolean;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToEngagement(row: Record<string, unknown>): Engagement {
  return {
    id: row["id"] as number,
    role_title: row["role_title"] as string,
    department: (row["department"] as string) ?? "",
    status: row["status"] as EngagementStatus,
    location: (row["location"] as string) ?? "",
    comp_band: (row["comp_band"] as string) ?? "",
    must_haves: (row["must_haves"] as string) ?? "",
    description: (row["description"] as string) ?? "",
    archived: Boolean(row["archived"]),
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

function rowToCandidate(row: Record<string, unknown>): Candidate {
  return {
    id: row["id"] as number,
    engagement_id: row["engagement_id"] as number,
    full_name: row["full_name"] as string,
    current_title: (row["current_title"] as string) ?? "",
    current_company: (row["current_company"] as string) ?? "",
    location: (row["location"] as string) ?? "",
    email: (row["email"] as string | null) ?? null,
    linkedin_url: (row["linkedin_url"] as string | null) ?? null,
    source: (row["source"] as string) ?? "",
    stage: row["stage"] as CandidateStage,
    fit_score: (row["fit_score"] as number | null) ?? null,
    screening_summary: (row["screening_summary"] as string) ?? "",
    notes: (row["notes"] as string) ?? "",
    archived: Boolean(row["archived"]),
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

function rowToOffer(row: Record<string, unknown>): Offer {
  let nudgeIds: number[] = [];
  try {
    const raw = row["nudge_action_ids_json"] as string | null;
    if (raw) nudgeIds = (JSON.parse(raw) as unknown[]).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  } catch { nudgeIds = []; }
  return {
    id: row["id"] as number,
    candidate_id: row["candidate_id"] as number,
    engagement_id: row["engagement_id"] as number,
    status: row["status"] as OfferStatus,
    comp_summary: (row["comp_summary"] as string) ?? "",
    package_md: (row["package_md"] as string) ?? "",
    note: (row["note"] as string) ?? "",
    expires_at: (row["expires_at"] as string | null) ?? null,
    extended_at: (row["extended_at"] as string) ?? "",
    decided_at: (row["decided_at"] as string) ?? "",
    approval_run_id: (row["approval_run_id"] as string) ?? "",
    approved_by_person_id: (row["approved_by_person_id"] as number | null) ?? null,
    nudge_action_ids: nudgeIds,
    archived: Boolean(row["archived"]),
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

// ── engagements ────────────────────────────────────────────────────────────

export function listEngagements(db: Db, includeArchived = false): Engagement[] {
  const where = includeArchived ? "" : "WHERE archived = 0";
  const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM engagements ${where} ORDER BY id`).all();
  return rows.map(rowToEngagement);
}

export function getEngagement(db: Db, id: number): Engagement | null {
  const row = db.query<Record<string, unknown>, [number]>("SELECT * FROM engagements WHERE id = ?").get(id);
  return row ? rowToEngagement(row) : null;
}

export function createEngagement(db: Db, data: Omit<Engagement, "id" | "archived" | "created_at" | "updated_at">): Engagement {
  const now = nowIso();
  const result = db.query<Record<string, unknown>, Array<string | number>>(
    `INSERT INTO engagements (role_title, department, status, location, comp_band, must_haves, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(data.role_title, data.department, data.status, data.location, data.comp_band, data.must_haves, data.description, now, now);
  // Fallback for bun:sqlite without RETURNING support via run
  if (!result) {
    const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id);
    const row = getEngagement(db, id);
    if (!row) throw new Error("Engagement vanished after insert");
    return row;
  }
  return rowToEngagement(result);
}

export function upsertEngagement(db: Db, id: number | null, data: Partial<Omit<Engagement, "id" | "archived" | "created_at" | "updated_at">> & { role_title: string }): Engagement {
  if (id !== null) {
    const existing = getEngagement(db, id);
    if (!existing) throw new Error("Engagement not found");
    const merged = {
      role_title: data.role_title ?? existing.role_title,
      department: data.department ?? existing.department,
      status: (data.status as EngagementStatus) ?? existing.status,
      location: data.location ?? existing.location,
      comp_band: data.comp_band ?? existing.comp_band,
      must_haves: data.must_haves ?? existing.must_haves,
      description: data.description ?? existing.description,
    };
    db.run(
      `UPDATE engagements SET role_title=?, department=?, status=?, location=?, comp_band=?, must_haves=?, description=?, updated_at=? WHERE id=?`,
      [merged.role_title, merged.department, merged.status, merged.location, merged.comp_band, merged.must_haves, merged.description, nowIso(), id],
    );
    const updated = getEngagement(db, id);
    if (!updated) throw new Error("Engagement vanished");
    return updated;
  }
  // create
  const now = nowIso();
  db.run(
    `INSERT INTO engagements (role_title, department, status, location, comp_band, must_haves, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.role_title, data.department ?? "", (data.status as string) ?? "open", data.location ?? "", data.comp_band ?? "", data.must_haves ?? "", data.description ?? "", now, now],
  );
  const newId = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id);
  const created = getEngagement(db, newId);
  if (!created) throw new Error("Engagement vanished after insert");
  return created;
}

export function archiveEngagement(db: Db, id: number): boolean {
  const result = db.run("UPDATE engagements SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0", [nowIso(), id]);
  return result.changes > 0;
}

// ── candidates ─────────────────────────────────────────────────────────────

export function listCandidates(db: Db, filters: { engagement_id?: number; stage?: CandidateStage; includeArchived?: boolean } = {}): Candidate[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (!filters.includeArchived) clauses.push("archived = 0");
  if (filters.engagement_id !== undefined) { clauses.push("engagement_id = ?"); params.push(filters.engagement_id); }
  if (filters.stage !== undefined) { clauses.push("stage = ?"); params.push(filters.stage); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = params.length
    ? db.query<Record<string, unknown>, Array<string | number>>(`SELECT * FROM candidates ${where} ORDER BY id`).all(...params)
    : db.query<Record<string, unknown>, []>(`SELECT * FROM candidates ${where} ORDER BY id`).all();
  return rows.map(rowToCandidate);
}

export function getCandidate(db: Db, id: number): Candidate | null {
  const row = db.query<Record<string, unknown>, [number]>("SELECT * FROM candidates WHERE id = ?").get(id);
  return row ? rowToCandidate(row) : null;
}

export function createCandidate(db: Db, data: Omit<Candidate, "id" | "archived" | "created_at" | "updated_at" | "fit_score" | "screening_summary">): Candidate {
  const now = nowIso();
  db.run(
    `INSERT INTO candidates (engagement_id, full_name, current_title, current_company, location, email, linkedin_url, source, stage, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.engagement_id, data.full_name, data.current_title, data.current_company, data.location, data.email, data.linkedin_url, data.source, data.stage, data.notes, now, now],
  );
  const newId = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id);
  const created = getCandidate(db, newId);
  if (!created) throw new Error("Candidate vanished after insert");
  return created;
}

export function updateCandidate(db: Db, id: number, patch: Partial<Omit<Candidate, "id" | "engagement_id" | "stage" | "archived" | "created_at" | "updated_at" | "fit_score" | "screening_summary">> & { email?: string | null; linkedin_url?: string | null }): Candidate | null {
  const existing = getCandidate(db, id);
  if (!existing) return null;
  const full_name = patch.full_name ?? existing.full_name;
  const current_title = patch.current_title ?? existing.current_title;
  const current_company = patch.current_company ?? existing.current_company;
  const location = patch.location ?? existing.location;
  const email = patch.email !== undefined ? patch.email : existing.email;
  const linkedin_url = patch.linkedin_url !== undefined ? patch.linkedin_url : existing.linkedin_url;
  const source = patch.source ?? existing.source;
  const notes = patch.notes ?? existing.notes;
  db.run(
    `UPDATE candidates SET full_name=?, current_title=?, current_company=?, location=?, email=?, linkedin_url=?, source=?, notes=?, updated_at=? WHERE id=?`,
    [full_name, current_title, current_company, location, email, linkedin_url, source, notes, nowIso(), id],
  );
  return getCandidate(db, id);
}

export function setCandidateStage(db: Db, id: number, stage: CandidateStage): Candidate | null {
  const existing = getCandidate(db, id);
  if (!existing) return null;
  db.run("UPDATE candidates SET stage = ?, updated_at = ? WHERE id = ?", [stage, nowIso(), id]);
  return getCandidate(db, id);
}

export function archiveCandidate(db: Db, id: number): boolean {
  const result = db.run("UPDATE candidates SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0", [nowIso(), id]);
  return result.changes > 0;
}

// ── offers ─────────────────────────────────────────────────────────────────

export function listOffers(db: Db, filters: { candidate_id?: number; engagement_id?: number; status?: OfferStatus; includeArchived?: boolean } = {}): Offer[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (!filters.includeArchived) clauses.push("archived = 0");
  if (filters.candidate_id !== undefined) { clauses.push("candidate_id = ?"); params.push(filters.candidate_id); }
  if (filters.engagement_id !== undefined) { clauses.push("engagement_id = ?"); params.push(filters.engagement_id); }
  if (filters.status !== undefined) { clauses.push("status = ?"); params.push(filters.status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = params.length
    ? db.query<Record<string, unknown>, Array<string | number>>(`SELECT * FROM offers ${where} ORDER BY id`).all(...params)
    : db.query<Record<string, unknown>, []>(`SELECT * FROM offers ${where} ORDER BY id`).all();
  return rows.map(rowToOffer);
}

export function getOffer(db: Db, id: number): Offer | null {
  const row = db.query<Record<string, unknown>, [number]>("SELECT * FROM offers WHERE id = ?").get(id);
  return row ? rowToOffer(row) : null;
}

export function getOpenOfferForCandidate(db: Db, candidateId: number): Offer | null {
  const row = db.query<Record<string, unknown>, [number]>(
    `SELECT * FROM offers WHERE candidate_id = ? AND archived = 0 AND status IN ('draft','pending_approval','extended') ORDER BY id DESC LIMIT 1`,
  ).get(candidateId);
  return row ? rowToOffer(row) : null;
}

export function createOffer(db: Db, data: { candidate_id: number; engagement_id: number; comp_summary: string; note?: string | undefined }): Offer {
  const existing = getOpenOfferForCandidate(db, data.candidate_id);
  if (existing) throw new Error(`candidate ${data.candidate_id} already has an open offer (id ${existing.id})`);
  const now = nowIso();
  try {
    db.run(
      `INSERT INTO offers (candidate_id, engagement_id, status, comp_summary, note, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)`,
      [data.candidate_id, data.engagement_id, data.comp_summary, data.note ?? "", now, now],
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE") || msg.includes("unique")) throw new Error(`candidate ${data.candidate_id} already has an open offer`);
    throw e;
  }
  const newId = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id);
  const created = getOffer(db, newId);
  if (!created) throw new Error("Offer vanished after insert");
  return created;
}

export function updateOfferTerms(db: Db, id: number, patch: { comp_summary?: string | null; note?: string | null }): Offer | null {
  const existing = getOffer(db, id);
  if (!existing) return null;
  if (!["draft", "pending_approval"].includes(existing.status)) throw new Error(`Offer is ${existing.status}; terms are only editable while draft/pending_approval`);
  const comp_summary = patch.comp_summary !== undefined && patch.comp_summary !== null ? patch.comp_summary : existing.comp_summary;
  const note = patch.note !== undefined && patch.note !== null ? patch.note : existing.note;
  db.run("UPDATE offers SET comp_summary = ?, note = ?, updated_at = ? WHERE id = ?", [comp_summary, note, nowIso(), id]);
  return getOffer(db, id);
}

export function extendOffer(db: Db, id: number, opts: { expires_at?: string | null; expires_in_days?: number; note?: string | null }): Offer {
  const existing = getOffer(db, id);
  if (!existing) throw new Error("Offer not found");
  if (existing.status !== "draft" && existing.status !== "pending_approval") throw new Error(`Offer is ${existing.status}; only draft/pending_approval can be extended`);
  let expiresAt: string | null = null;
  if (opts.expires_at) {
    const parsed = new Date(opts.expires_at);
    if (Number.isNaN(parsed.getTime())) throw new Error(`expires_at is not an ISO timestamp: ${opts.expires_at}`);
    if (parsed.getTime() <= Date.now()) throw new Error("expires_at must be in the future");
    expiresAt = parsed.toISOString();
  } else {
    const days = opts.expires_in_days ?? 7;
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  const note = opts.note !== undefined && opts.note !== null ? opts.note : existing.note;
  db.run("UPDATE offers SET status = 'extended', expires_at = ?, extended_at = ?, note = ?, updated_at = ? WHERE id = ?", [expiresAt, nowIso(), note, nowIso(), id]);
  const updated = getOffer(db, id);
  if (!updated) throw new Error("Offer vanished");
  return updated;
}

export function decideOffer(db: Db, id: number, decision: OfferStatus, note?: string | null): Offer {
  const existing = getOffer(db, id);
  if (!existing) throw new Error("Offer not found");
  if (existing.status !== "extended") throw new Error(`Offer is ${existing.status}; only extended offers can be decided`);
  if (!["accepted", "declined", "expired", "rescinded"].includes(decision)) throw new Error(`Invalid decision status: ${decision}`);
  const finalNote = note !== undefined && note !== null ? note : existing.note;
  db.run("UPDATE offers SET status = ?, decided_at = ?, note = ?, updated_at = ? WHERE id = ?", [decision, nowIso(), finalNote, nowIso(), id]);
  const updated = getOffer(db, id);
  if (!updated) throw new Error("Offer vanished");
  // If accepted, place the candidate
  if (decision === "accepted") {
    db.run("UPDATE candidates SET stage = 'placed', updated_at = ? WHERE id = ?", [nowIso(), existing.candidate_id]);
  }
  return updated;
}

export function archiveOffer(db: Db, id: number): boolean {
  const result = db.run("UPDATE offers SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0", [nowIso(), id]);
  return result.changes > 0;
}

// ── validation helpers ─────────────────────────────────────────────────────

export function validateEngagementCreate(body: unknown): { ok: true; data: { role_title: string; department: string; status: EngagementStatus; location: string; comp_band: string; must_haves: string; description: string } } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid JSON" };
  const b = body as Record<string, unknown>;
  const role_title = b["role_title"];
  if (typeof role_title !== "string" || !role_title.trim()) return { ok: false, error: "role_title is required" };
  if (role_title.length > 200) return { ok: false, error: "role_title too long" };
  const status = (b["status"] as string) ?? "open";
  if (!ENGAGEMENT_STATUSES.includes(status as EngagementStatus)) return { ok: false, error: `Invalid status: ${status}` };
  return {
    ok: true,
    data: {
      role_title: role_title.trim(),
      department: typeof b["department"] === "string" ? b["department"] : "",
      status: status as EngagementStatus,
      location: typeof b["location"] === "string" ? b["location"] : "",
      comp_band: typeof b["comp_band"] === "string" ? b["comp_band"] : "",
      must_haves: typeof b["must_haves"] === "string" ? b["must_haves"] : "",
      description: typeof b["description"] === "string" ? b["description"] : "",
    },
  };
}

export function validateCandidateCreate(body: unknown): { ok: true; data: { engagement_id: number; full_name: string; current_title: string; current_company: string; location: string; email: string | null; linkedin_url: string | null; source: string; stage: CandidateStage; notes: string } } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid JSON" };
  const b = body as Record<string, unknown>;
  const engagement_id = b["engagement_id"];
  if (typeof engagement_id !== "number" || !Number.isInteger(engagement_id)) return { ok: false, error: "engagement_id is required" };
  const full_name = b["full_name"];
  if (typeof full_name !== "string" || !full_name.trim()) return { ok: false, error: "full_name is required" };
  if (full_name.length > 200) return { ok: false, error: "full_name too long" };
  const stage = (b["stage"] as string) ?? "lead";
  if (!CANDIDATE_STAGES.includes(stage as CandidateStage)) return { ok: false, error: `Invalid stage: ${stage}` };
  return {
    ok: true,
    data: {
      engagement_id,
      full_name: full_name.trim(),
      current_title: typeof b["current_title"] === "string" ? b["current_title"] : "",
      current_company: typeof b["current_company"] === "string" ? b["current_company"] : "",
      location: typeof b["location"] === "string" ? b["location"] : "",
      email: typeof b["email"] === "string" ? b["email"] : (b["email"] === null ? null : null),
      linkedin_url: typeof b["linkedin_url"] === "string" ? b["linkedin_url"] : (b["linkedin_url"] === null ? null : null),
      source: typeof b["source"] === "string" ? b["source"] : "",
      stage: stage as CandidateStage,
      notes: typeof b["notes"] === "string" ? b["notes"] : "",
    },
  };
}
