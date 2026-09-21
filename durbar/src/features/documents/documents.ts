/**
 * Documents — company document CRUD.
 *
 * Port of `api/routes/documents.py`. Upstream stores files on disk under
 * `company/docs/` and indexes them into ChromaDB's company collection. Durbar
 * stores them in SQLite (`company_documents`) so the whole state is one file
 * to back up, and retrieval is via FTS5 rather than embeddings.
 *
 * The file identity is the bare filename — not a temp path — so re-uploads
 * upsert and DELETE can find the row. Domain validation prevents a typo from
 * silently indexing a document where no specialist can retrieve it.
 */

import type { Db } from "../../db.ts";

// ── constants ────────────────────────────────────────────────────────────

export const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".doc", ".md", ".txt"]);
export const UPLOAD_DOMAINS = new Set([
  "strategy",
  "finance",
  "hr",
  "legal",
  "operations",
  "marketing",
  "board",
  "product",
  "general",
]);

// ── types ────────────────────────────────────────────────────────────────

export interface DocumentMeta {
  readonly filename: string;
  readonly domain: string;
  readonly size_bytes: number;
  readonly created_at: string;
}

export interface DocumentContent {
  readonly filename: string;
  readonly content: string;
}

// ── validation ───────────────────────────────────────────────────────────

export function validateFilename(filename: string): string | null {
  if (!filename || filename.startsWith(".") || filename.includes("/") || filename.includes("\\")) {
    return "Invalid filename";
  }
  // Must be a bare filename, not a path.
  const base = filename.split("/").pop() ?? "";
  if (base !== filename) return "Invalid filename";
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return `Unsupported file type: ${ext}. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`;
  }
  return null;
}

export function validateDomain(domain: string): string | null {
  if (!UPLOAD_DOMAINS.has(domain)) {
    return `Unknown domain: ${domain}. Allowed: ${[...UPLOAD_DOMAINS].sort().join(", ")}`;
  }
  return null;
}

// ── store ────────────────────────────────────────────────────────────────

export function listDocuments(db: Db): DocumentMeta[] {
  try {
    return db
      .query<DocumentMeta, []>(
        "SELECT filename, domain, size_bytes, created_at FROM company_documents ORDER BY created_at DESC",
      )
      .all();
  } catch {
    return [];
  }
}

export function getDocument(db: Db, filename: string): DocumentContent | null {
  try {
    const row = db
      .query<{ filename: string; content: string }, [string]>(
        "SELECT filename, content FROM company_documents WHERE filename = ?",
      )
      .get(filename);
    if (!row) return null;
    return { filename: row.filename, content: row.content };
  } catch {
    return null;
  }
}

export function upsertDocument(
  db: Db,
  filename: string,
  domain: string,
  content: string,
): DocumentMeta {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO company_documents (filename, domain, content, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(filename) DO UPDATE SET domain = excluded.domain, content = excluded.content, size_bytes = excluded.size_bytes, created_at = excluded.created_at`,
    [filename, domain, content, sizeBytes, now],
  );
  return { filename, domain, size_bytes: sizeBytes, created_at: now };
}

export function deleteDocument(db: Db, filename: string): boolean {
  try {
    const result = db.run("DELETE FROM company_documents WHERE filename = ?", [filename]);
    return result.changes > 0;
  } catch {
    return false;
  }
}
