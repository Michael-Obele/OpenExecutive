/**
 * Clients — multi-client slot management.
 *
 * Port of `clients/slots.py` + `clients/cockpit.py` + `api/routes/clients.py`.
 * Upstream uses filesystem slots (company/_client_slots/<slug>/); Durbar keeps
 * slot metadata in SQLite and stubs the filesystem copy/restore. The CRUD
 * surface and cockpit rollup are faithful; generate/save are stubbed with
 * proper validation.
 */

import type { Db } from "../../db.ts";

export interface ClientSlot {
  slug: string;
  display_name: string;
  status: string;
  role: string;
  engagement_start: string | null;
  renewal_date: string | null;
  retainer: string | null;
  hours_per_week: number | null;
  primary_contact: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToClient(row: Record<string, unknown>): ClientSlot {
  return {
    slug: row["slug"] as string,
    display_name: row["display_name"] as string,
    status: (row["status"] as string) ?? "active",
    role: (row["role"] as string) ?? "",
    engagement_start: (row["engagement_start"] as string | null) ?? null,
    renewal_date: (row["renewal_date"] as string | null) ?? null,
    retainer: (row["retainer"] as string | null) ?? null,
    hours_per_week: (row["hours_per_week"] as number | null) ?? null,
    primary_contact: (row["primary_contact"] as string | null) ?? null,
    notes: (row["notes"] as string) ?? "",
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

export function listClients(db: Db): ClientSlot[] {
  const rows = db
    .query<
      Record<string, unknown>,
      []
    >("SELECT * FROM clients ORDER BY updated_at DESC")
    .all();
  return rows.map(rowToClient);
}

export function getClient(db: Db, slug: string): ClientSlot | null {
  const row = db
    .query<
      Record<string, unknown>,
      [string]
    >("SELECT * FROM clients WHERE slug = ?")
    .get(slug);
  return row ? rowToClient(row) : null;
}

export function createClient(
  db: Db,
  data: { slug: string; display_name: string },
): ClientSlot {
  const now = nowIso();
  db.run(
    "INSERT INTO clients (slug, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [data.slug, data.display_name, now, now],
  );
  const created = getClient(db, data.slug);
  if (!created) throw new Error("Client vanished after insert");
  return created;
}

export function updateClientMeta(
  db: Db,
  slug: string,
  patch: Record<string, unknown>,
): ClientSlot | null {
  const existing = getClient(db, slug);
  if (!existing) return null;
  const allowed = [
    "role",
    "status",
    "engagement_start",
    "renewal_date",
    "retainer",
    "hours_per_week",
    "primary_contact",
    "notes",
  ] as const;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of allowed) {
    if (key in patch) {
      sets.push(`${key} = ?`);
      vals.push(patch[key]);
    }
  }
  if (sets.length === 0) return existing;
  vals.push(nowIso(), slug);
  db.run(
    `UPDATE clients SET ${sets.join(", ")}, updated_at = ? WHERE slug = ?`,
    vals as Array<string | number | null>,
  );
  return getClient(db, slug);
}

export function deleteClient(db: Db, slug: string): boolean {
  const result = db.run("DELETE FROM clients WHERE slug = ?", [slug]);
  return result.changes > 0;
}

export function deriveSlug(displayName: string): string {
  let slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) slug = "client";
  return slug.slice(0, 64);
}

export function cockpitCards(db: Db): Array<Record<string, unknown>> {
  const clients = listClients(db);
  return clients.map((c) => ({
    slug: c.slug,
    display_name: c.display_name,
    status: c.status,
    role: c.role,
    renewal_date: c.renewal_date,
    retainer: c.retainer,
    hours_per_week: c.hours_per_week,
    primary_contact: c.primary_contact,
  }));
}
