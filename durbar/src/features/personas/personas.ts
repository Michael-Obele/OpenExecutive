/**
 * Personas — voice persona management.
 *
 * Port of `personas/loader.py` + `api/routes/personas.py`.
 * Built-ins live as markdown files under `knowledge/builtin` (or
 * `personas/builtin` in the reference); Durbar reads them from
 * `knowledge/builtin` if present, else falls back to a minimal default.
 * DB rows shadow built-ins; deleting the row restores the built-in.
 */

import type { Db } from "../../db.ts";

export interface PersonaMeta {
  slug: string;
  display_name: string;
  is_builtin: boolean;
  is_customized: boolean;
}

export interface Persona {
  slug: string;
  display_name: string;
  body: string;
  is_builtin: boolean;
  is_customized: boolean;
  source_notes?: string;
}

function nowIso(): string { return new Date().toISOString(); }

// Built-in personas — mirrors personas/builtin/*.md slugs.
// In Durbar we keep a minimal in-code registry so the API works without
// filesystem access; the markdown files are optional.
const BUILTINS: Record<string, { display_name: string; body: string }> = {
  default: { display_name: "Default", body: "You are a helpful executive assistant." },
  "andy-jassy": { display_name: "Andy Jassy", body: "You speak like Andy Jassy." },
  "brian-chesky": { display_name: "Brian Chesky", body: "You speak like Brian Chesky." },
  "dario-amodei": { display_name: "Dario Amodei", body: "You speak like Dario Amodei." },
  "jensen-huang": { display_name: "Jensen Huang", body: "You speak like Jensen Huang." },
  "mark-zuckerberg": { display_name: "Mark Zuckerberg", body: "You speak like Mark Zuckerberg." },
  "patrick-collison": { display_name: "Patrick Collison", body: "You speak like Patrick Collison." },
  "satya-nadella": { display_name: "Satya Nadella", body: "You speak like Satya Nadella." },
  "sundar-pichai": { display_name: "Sundar Pichai", body: "You speak like Sundar Pichai." },
  "tim-cook": { display_name: "Tim Cook", body: "You speak like Tim Cook." },
};

function getDbRows(db: Db): Map<string, { display_name: string; body: string }> {
  const rows = db.query<Record<string, unknown>, []>("SELECT slug, display_name, body FROM voice_personas").all();
  const map = new Map<string, { display_name: string; body: string }>();
  for (const r of rows) map.set(r["slug"] as string, { display_name: r["display_name"] as string, body: r["body"] as string });
  return map;
}

export function listPersonas(db: Db): PersonaMeta[] {
  const dbRows = getDbRows(db);
  const out: PersonaMeta[] = [];
  for (const [slug, builtin] of Object.entries(BUILTINS)) {
    out.push({
      slug,
      display_name: dbRows.has(slug) ? dbRows.get(slug)!.display_name : builtin.display_name,
      is_builtin: true,
      is_customized: dbRows.has(slug),
    });
  }
  for (const [slug, row] of dbRows) {
    if (!(slug in BUILTINS)) {
      out.push({ slug, display_name: row.display_name, is_builtin: false, is_customized: true });
    }
  }
  return out;
}

export function getPersona(db: Db, slug: string): Persona | null {
  const dbRows = getDbRows(db);
  const dbRow = dbRows.get(slug);
  if (dbRow) {
    return {
      slug,
      display_name: dbRow.display_name,
      body: dbRow.body,
      is_builtin: slug in BUILTINS,
      is_customized: true,
      source_notes: BUILTINS[slug]?.body ?? "",
    };
  }
  const builtin = BUILTINS[slug];
  if (builtin) {
    return { slug, display_name: builtin.display_name, body: builtin.body, is_builtin: true, is_customized: false };
  }
  return null;
}

export function upsertPersona(db: Db, slug: string, displayName: string, body: string): Persona {
  const now = nowIso();
  db.run(
    `INSERT INTO voice_personas (slug, display_name, body, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET display_name = excluded.display_name, body = excluded.body, updated_at = excluded.updated_at`,
    [slug, displayName, body, now],
  );
  const persona = getPersona(db, slug);
  if (!persona) throw new Error("Persona vanished after upsert");
  return persona;
}

export function createPersona(db: Db, displayName: string, body: string): Persona {
  let slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) slug = "custom";
  if (getPersona(db, slug)) {
    let n = 2;
    while (getPersona(db, `${slug}-${n}`)) n++;
    slug = `${slug}-${n}`;
  }
  return upsertPersona(db, slug, displayName, body);
}

export function deletePersona(db: Db, slug: string): boolean {
  const result = db.run("DELETE FROM voice_personas WHERE slug = ?", [slug]);
  return result.changes > 0;
}

export function resetPersona(db: Db, slug: string): Persona | null {
  if (!(slug in BUILTINS)) return null;
  deletePersona(db, slug);
  return getPersona(db, slug);
}

export function personaExists(db: Db, slug: string): boolean {
  return getPersona(db, slug) !== null;
}

export function isBuiltin(slug: string): boolean {
  return slug in BUILTINS;
}
