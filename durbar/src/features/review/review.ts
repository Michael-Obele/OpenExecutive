/**
 * Review queue — items awaiting human approval and their correction annotations.
 *
 * Port of `knowledge/review_store.py` + `api/routes/review.py`. The store is
 * ~400 lines upstream because it carries DB_PATH monkeypatching and a registry
 * cache; Durbar's DB is injected so helpers take `Db` directly.
 *
 * Statuses: pending → approved | rejected | needs_revision. `needs_revision`
 * is set when content is edited after approval/rejection. Priority is
 * orthogonal (high/normal/low) and used for queue ordering.
 */

import type { Db } from "../../db.ts";

// ── types ──────────────────────────────────────────────────────────────────

export type ReviewStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "needs_revision";
export type ContentType = "builtin" | "external";
export type Priority = "low" | "normal" | "high";

export const REVIEW_STATUSES: readonly ReviewStatus[] = [
  "pending",
  "approved",
  "rejected",
  "needs_revision",
];
export const CONTENT_TYPES: readonly ContentType[] = ["builtin", "external"];
export const PRIORITIES: readonly Priority[] = ["low", "normal", "high"];

export interface ReviewItem {
  item_id: string;
  content_type: ContentType;
  domain: string;
  filename: string;
  status: ReviewStatus;
  priority: Priority;
  reviewer_notes: string;
  reviewed_at: string | null;
  registered_at: string;
  last_modified_at: string;
}

export interface Annotation {
  annotation_id: string;
  item_id: string;
  domain: string;
  correction: string;
  is_active: boolean;
  created_at: string;
}

export interface ReviewStats {
  pending: number;
  approved: number;
  rejected: number;
  needs_revision: number;
  total: number;
}

// ── helpers ────────────────────────────────────────────────────────────────

function rowToItem(row: Record<string, unknown>): ReviewItem {
  return {
    item_id: row["item_id"] as string,
    content_type: row["content_type"] as ContentType,
    domain: row["domain"] as string,
    filename: row["filename"] as string,
    status: row["status"] as ReviewStatus,
    priority: row["priority"] as Priority,
    reviewer_notes: (row["reviewer_notes"] as string) ?? "",
    reviewed_at: (row["reviewed_at"] as string | null) ?? null,
    registered_at: row["registered_at"] as string,
    last_modified_at: row["last_modified_at"] as string,
  };
}

function rowToAnnotation(row: Record<string, unknown>): Annotation {
  return {
    annotation_id: row["annotation_id"] as string,
    item_id: row["item_id"] as string,
    domain: row["domain"] as string,
    correction: row["correction"] as string,
    is_active: Boolean(row["is_active"]),
    created_at: row["created_at"] as string,
  };
}

// ── store ──────────────────────────────────────────────────────────────────

export function listReviewItems(
  db: Db,
  opts: {
    status?: ReviewStatus | null;
    domain?: string | null;
    contentType?: ContentType | null;
    limit?: number;
    offset?: number;
  } = {},
): ReviewItem[] {
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = opts.offset ?? 0;
  const clauses: string[] = [];
  const params: (string | number | null)[] = [];
  if (opts.status) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  if (opts.domain) {
    clauses.push("domain = ?");
    params.push(opts.domain);
  }
  if (opts.contentType) {
    clauses.push("content_type = ?");
    params.push(opts.contentType);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  // Priority ordering: high first, then normal, then low — matches PRIORITY_ORDER.
  const sql = `SELECT * FROM review_items ${where} ORDER BY
    CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
    registered_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return db
    .query<Record<string, unknown>, (string | number | null)[]>(sql)
    .all(...(params as (string | number | null)[]))
    .map(rowToItem);
}

export function getReviewItem(db: Db, itemId: string): ReviewItem | null {
  const row = db
    .query<
      Record<string, unknown>,
      [string]
    >("SELECT * FROM review_items WHERE item_id = ?")
    .get(itemId);
  return row ? rowToItem(row) : null;
}

export function countByStatus(db: Db): ReviewStats {
  const rows = db
    .query<
      { status: string; n: number },
      []
    >("SELECT status, COUNT(*) as n FROM review_items GROUP BY status")
    .all();
  const byStatus = new Map(rows.map((r) => [r.status, r.n]));
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  return {
    pending: byStatus.get("pending") ?? 0,
    approved: byStatus.get("approved") ?? 0,
    rejected: byStatus.get("rejected") ?? 0,
    needs_revision: byStatus.get("needs_revision") ?? 0,
    total,
  };
}

export function setReviewStatus(
  db: Db,
  itemId: string,
  status: ReviewStatus,
  notes?: string,
): ReviewItem | null {
  const now = new Date().toISOString();
  const existing = getReviewItem(db, itemId);
  if (!existing) return null;
  const reviewerNotes = notes !== undefined ? notes : existing.reviewer_notes;
  db.run(
    "UPDATE review_items SET status = ?, reviewer_notes = ?, reviewed_at = ? WHERE item_id = ?",
    [status, reviewerNotes, now, itemId],
  );
  return getReviewItem(db, itemId);
}

export function updateReviewNotes(
  db: Db,
  itemId: string,
  notes: string,
): ReviewItem | null {
  db.run("UPDATE review_items SET reviewer_notes = ? WHERE item_id = ?", [
    notes,
    itemId,
  ]);
  return getReviewItem(db, itemId);
}

export function setReviewPriority(
  db: Db,
  itemId: string,
  priority: Priority,
): ReviewItem | null {
  db.run("UPDATE review_items SET priority = ? WHERE item_id = ?", [
    priority,
    itemId,
  ]);
  return getReviewItem(db, itemId);
}

export function setReviewStatusAndPriority(
  db: Db,
  itemId: string,
  status: ReviewStatus,
  priority: Priority,
  notes?: string,
): ReviewItem | null {
  const now = new Date().toISOString();
  const existing = getReviewItem(db, itemId);
  if (!existing) return null;
  const reviewerNotes = notes !== undefined ? notes : existing.reviewer_notes;
  const tx = db.transaction(() => {
    db.run(
      "UPDATE review_items SET status = ?, reviewer_notes = ?, reviewed_at = ? WHERE item_id = ?",
      [status, reviewerNotes, now, itemId],
    );
    db.run("UPDATE review_items SET priority = ? WHERE item_id = ?", [
      priority,
      itemId,
    ]);
  });
  tx();
  return getReviewItem(db, itemId);
}

export function bulkApprove(db: Db, domain?: string | null): number {
  if (domain) {
    const result = db.run(
      "UPDATE review_items SET status = 'approved', reviewed_at = ? WHERE status = 'pending' AND domain = ?",
      [new Date().toISOString(), domain],
    );
    return result.changes;
  }
  const result = db.run(
    "UPDATE review_items SET status = 'approved', reviewed_at = ? WHERE status = 'pending'",
    [new Date().toISOString()],
  );
  return result.changes;
}

// ── annotations ────────────────────────────────────────────────────────────

export function listAnnotations(
  db: Db,
  opts: { itemId?: string | null; activeOnly?: boolean } = {},
): Annotation[] {
  const clauses: string[] = [];
  const params: (string | number | null)[] = [];
  if (opts.itemId) {
    clauses.push("item_id = ?");
    params.push(opts.itemId);
  }
  if (opts.activeOnly) {
    clauses.push("is_active = 1");
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .query<Record<string, unknown>, (string | number | null)[]>(
      `SELECT * FROM review_annotations ${where} ORDER BY created_at DESC`,
    )
    .all(...(params as (string | number | null)[]))
    .map(rowToAnnotation);
}

export function addAnnotation(
  db: Db,
  itemId: string,
  domain: string,
  correction: string,
): Annotation {
  const id = `annot_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO review_annotations (annotation_id, item_id, domain, correction, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
    [id, itemId, domain, correction, now],
  );
  const row = db
    .query<
      Record<string, unknown>,
      [string]
    >("SELECT * FROM review_annotations WHERE annotation_id = ?")
    .get(id);
  return rowToAnnotation(row as Record<string, unknown>);
}

export function updateAnnotation(
  db: Db,
  annotationId: string,
  correction: string,
): void {
  db.run(
    "UPDATE review_annotations SET correction = ? WHERE annotation_id = ?",
    [correction, annotationId],
  );
}

export function toggleAnnotation(
  db: Db,
  annotationId: string,
  isActive: boolean,
): void {
  db.run(
    "UPDATE review_annotations SET is_active = ? WHERE annotation_id = ?",
    [isActive ? 1 : 0, annotationId],
  );
}

export function deleteAnnotation(db: Db, annotationId: string): void {
  db.run("DELETE FROM review_annotations WHERE annotation_id = ?", [
    annotationId,
  ]);
}
