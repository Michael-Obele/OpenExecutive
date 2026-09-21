/**
 * People — the roster that gates approvals, briefings, and scheduling.
 *
 * Port of `people/store.py` + `people/models.py` + `api/routes/people.py`.
 * One file owns the types, store helpers, and validation so the route layer
 * in `src/index.ts` stays thin.
 *
 * The upstream store is ~500 lines because it carries DB_PATH monkeypatching,
 * a registry cache, and per-channel finders. Durbar's DB is injected, so the
 * helpers take `Db` directly and have no global state.
 *
 * Principal protection: archiving the last non-archived principal is rejected
 * (409) — without a principal the scheduler has no one to brief and the
 * authority gate has no fallback approver. Upstream's store does not enforce
 * this; the plan requires it.
 */

import type { Db } from "../../db.ts";

// ── types ──────────────────────────────────────────────────────────────────

export type AuthorityScope =
  | "spend_lt_2k"
  | "spend_lt_10k"
  | "spend_gt_10k"
  | "hiring_signoff"
  | "vendor_onboarding"
  | "customer_credit"
  | "legal_sign"
  | "board_comms"
  | "meeting_scheduling"
  | "wildcard";

export const AUTHORITY_SCOPES: readonly AuthorityScope[] = [
  "spend_lt_2k",
  "spend_lt_10k",
  "spend_gt_10k",
  "hiring_signoff",
  "vendor_onboarding",
  "customer_credit",
  "legal_sign",
  "board_comms",
  "meeting_scheduling",
  "wildcard",
];

export type PreferredChannel = "email" | "slack" | "telegram" | "discord" | "any";

export const PREFERRED_CHANNELS: readonly PreferredChannel[] = [
  "email",
  "slack",
  "telegram",
  "discord",
  "any",
];

export interface AvailabilityWindow {
  weekdays: number[];
  start_local: string;
  end_local: string;
  timezone: string;
}

export interface Person {
  id: number;
  full_name: string;
  role: string;
  is_principal: boolean;
  department_slugs: string[];
  email: string | null;
  slack_user_id: string | null;
  telegram_chat_id: string | null;
  discord_user_id: string | null;
  preferred_channel: PreferredChannel;
  response_sla_hours: number;
  on_leave_until: string | null;
  reports_to_person_id: number | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  authority_scope: AuthorityScope[];
  availability: AvailabilityWindow[];
}

// ── validation helpers ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HH_MM = /^\d{2}:\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validateAuthorityScope(
  value: unknown,
): { ok: true; value: AuthorityScope } | { ok: false; error: string } {
  if (
    typeof value !== "string" ||
    !(AUTHORITY_SCOPES as readonly string[]).includes(value)
  ) {
    return {
      ok: false,
      error: `authority_scope token must be one of ${AUTHORITY_SCOPES.join(", ")}`,
    };
  }
  return { ok: true, value: value as AuthorityScope };
}

export function validatePreferredChannel(
  value: unknown,
): { ok: true; value: PreferredChannel } | { ok: false; error: string } {
  if (
    typeof value !== "string" ||
    !(PREFERRED_CHANNELS as readonly string[]).includes(value)
  ) {
    return {
      ok: false,
      error: `preferred_channel must be one of ${PREFERRED_CHANNELS.join(", ")}`,
    };
  }
  return { ok: true, value: value as PreferredChannel };
}

function validateAvailabilityWindow(
  raw: unknown,
): { ok: true; value: AvailabilityWindow } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "availability entry must be an object" };
  const weekdays = raw["weekdays"];
  if (!Array.isArray(weekdays))
    return { ok: false, error: "availability.weekdays must be an array" };
  for (const w of weekdays) {
    if (typeof w !== "number" || !Number.isInteger(w) || w < 0 || w > 6)
      return { ok: false, error: "availability.weekdays must be integers 0-6" };
  }
  const start = raw["start_local"];
  const end = raw["end_local"];
  if (typeof start !== "string" || !HH_MM.test(start))
    return { ok: false, error: "availability.start_local must be HH:MM" };
  if (typeof end !== "string" || !HH_MM.test(end))
    return { ok: false, error: "availability.end_local must be HH:MM" };
  const tz = raw["timezone"];
  if (tz !== undefined && typeof tz !== "string")
    return { ok: false, error: "availability.timezone must be a string" };
  return {
    ok: true,
    value: {
      weekdays: weekdays as number[],
      start_local: start,
      end_local: end,
      timezone: typeof tz === "string" ? tz : "UTC",
    },
  };
}

// ── row mapping ────────────────────────────────────────────────────────────

interface PersonRow {
  id: number;
  full_name: string;
  role: string;
  is_principal: number;
  department_slugs_json: string;
  email: string | null;
  slack_user_id: string | null;
  telegram_chat_id: string | null;
  discord_user_id: string | null;
  preferred_channel: string;
  response_sla_hours: number;
  on_leave_until: string | null;
  reports_to_person_id: number | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

function loadScope(db: Db, personId: number): AuthorityScope[] {
  const rows = db
    .query<{ scope_token: string }, [number]>(
      "SELECT scope_token FROM person_authority_scope WHERE person_id = ?",
    )
    .all(personId);
  const scopes: AuthorityScope[] = [];
  for (const row of rows) {
    if ((AUTHORITY_SCOPES as readonly string[]).includes(row.scope_token)) {
      scopes.push(row.scope_token as AuthorityScope);
    }
  }
  return scopes;
}

function loadAvailability(db: Db, personId: number): AvailabilityWindow[] {
  const rows = db
    .query<
      { weekdays_json: string; start_local: string; end_local: string; timezone: string },
      [number]
    >(
      "SELECT weekdays_json, start_local, end_local, timezone FROM person_availability WHERE person_id = ? ORDER BY id",
    )
    .all(personId);
  const windows: AvailabilityWindow[] = [];
  for (const row of rows) {
    try {
      const weekdays: unknown = JSON.parse(row.weekdays_json);
      windows.push({
        weekdays: Array.isArray(weekdays) ? (weekdays as number[]) : [],
        start_local: row.start_local,
        end_local: row.end_local,
        timezone: row.timezone,
      });
    } catch {
      // Malformed row — skip rather than crash the whole listing.
    }
  }
  return windows;
}

function rowToPerson(db: Db, row: PersonRow): Person {
  let deptSlugs: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.department_slugs_json);
    deptSlugs = Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    deptSlugs = [];
  }

  const preferred: PreferredChannel = (
    PREFERRED_CHANNELS as readonly string[]
  ).includes(row.preferred_channel)
    ? (row.preferred_channel as PreferredChannel)
    : "any";

  return {
    id: row.id,
    full_name: row.full_name,
    role: row.role,
    is_principal: Boolean(row.is_principal),
    department_slugs: deptSlugs,
    email: row.email,
    slack_user_id: row.slack_user_id,
    telegram_chat_id: row.telegram_chat_id,
    discord_user_id: row.discord_user_id,
    preferred_channel: preferred,
    response_sla_hours: row.response_sla_hours,
    on_leave_until: row.on_leave_until,
    reports_to_person_id: row.reports_to_person_id,
    archived: Boolean(row.archived),
    created_at: row.created_at,
    updated_at: row.updated_at,
    authority_scope: loadScope(db, row.id),
    availability: loadAvailability(db, row.id),
  };
}

// ── store ──────────────────────────────────────────────────────────────────

export function listPeople(db: Db, includeArchived = false): Person[] {
  const rows = includeArchived
    ? db.query<PersonRow, []>("SELECT * FROM people ORDER BY is_principal DESC, id ASC").all()
    : db
        .query<PersonRow, []>("SELECT * FROM people WHERE archived = 0 ORDER BY is_principal DESC, id ASC")
        .all();
  return rows.map((row) => rowToPerson(db, row));
}

export function getPerson(db: Db, id: number): Person | null {
  const row = db.query<PersonRow, [number]>("SELECT * FROM people WHERE id = ?").get(id);
  return row ? rowToPerson(db, row) : null;
}

export function findPrincipal(db: Db): Person | null {
  const row = db
    .query<PersonRow, []>("SELECT * FROM people WHERE is_principal = 1 AND archived = 0 ORDER BY id LIMIT 1")
    .get();
  return row ? rowToPerson(db, row) : null;
}

export function findApprovers(db: Db, scope: AuthorityScope): Person[] {
  const rows = db
    .query<PersonRow, [string, string]>(
      `SELECT DISTINCT p.* FROM people p
       JOIN person_authority_scope pas ON pas.person_id = p.id
       WHERE p.archived = 0 AND pas.scope_token IN (?, ?)
       ORDER BY p.is_principal ASC, p.response_sla_hours ASC, p.id ASC`,
    )
    .all(scope, "wildcard");
  return rows.map((row) => rowToPerson(db, row));
}

function setAuthorityScope(db: Db, personId: number, scopes: AuthorityScope[]): void {
  db.run("DELETE FROM person_authority_scope WHERE person_id = ?", [personId]);
  for (const scope of scopes) {
    db.run("INSERT OR IGNORE INTO person_authority_scope (person_id, scope_token) VALUES (?, ?)", [
      personId,
      scope,
    ]);
  }
}

function setAvailability(db: Db, personId: number, windows: AvailabilityWindow[]): void {
  db.run("DELETE FROM person_availability WHERE person_id = ?", [personId]);
  for (const win of windows) {
    db.run(
      "INSERT INTO person_availability (person_id, weekdays_json, start_local, end_local, timezone) VALUES (?, ?, ?, ?, ?)",
      [personId, JSON.stringify(win.weekdays), win.start_local, win.end_local, win.timezone],
    );
  }
}

export interface PersonCreate {
  full_name: string;
  role?: string;
  is_principal?: boolean;
  department_slugs?: string[];
  email?: string | null;
  slack_user_id?: string | null;
  telegram_chat_id?: string | null;
  discord_user_id?: string | null;
  preferred_channel?: PreferredChannel;
  response_sla_hours?: number;
  on_leave_until?: string | null;
  reports_to_person_id?: number | null;
  authority_scope?: AuthorityScope[];
  availability?: AvailabilityWindow[];
}

export function createPerson(db: Db, input: PersonCreate): Person {
  const now = new Date().toISOString();
  const result = db.run(
    `INSERT INTO people
       (full_name, role, is_principal, department_slugs_json, email, slack_user_id, telegram_chat_id, discord_user_id,
        preferred_channel, response_sla_hours, on_leave_until, reports_to_person_id, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      input.full_name,
      input.role ?? "",
      input.is_principal ? 1 : 0,
      JSON.stringify(input.department_slugs ?? []),
      input.email ?? null,
      input.slack_user_id ?? null,
      input.telegram_chat_id ?? null,
      input.discord_user_id ?? null,
      input.preferred_channel ?? "any",
      input.response_sla_hours ?? 24,
      input.on_leave_until ?? null,
      input.reports_to_person_id ?? null,
      now,
      now,
    ],
  );
  const id = Number(result.lastInsertRowid);
  if (input.authority_scope && input.authority_scope.length > 0) {
    setAuthorityScope(db, id, input.authority_scope);
  }
  if (input.availability && input.availability.length > 0) {
    setAvailability(db, id, input.availability);
  }
  const created = getPerson(db, id);
  if (!created) throw new Error("Person vanished after insert");
  return created;
}

export interface PersonPatch {
  full_name?: string;
  role?: string;
  is_principal?: boolean;
  department_slugs?: string[];
  email?: string | null;
  slack_user_id?: string | null;
  telegram_chat_id?: string | null;
  discord_user_id?: string | null;
  preferred_channel?: PreferredChannel;
  response_sla_hours?: number;
  on_leave_until?: string | null;
  clear_on_leave?: boolean;
  reports_to_person_id?: number | null;
  authority_scope?: AuthorityScope[];
  availability?: AvailabilityWindow[];
}

export function updatePerson(db: Db, id: number, patch: PersonPatch): Person | null {
  const existing = getPerson(db, id);
  if (!existing) return null;

  const fields: Array<[string, unknown]> = [];
  if (patch.full_name !== undefined) fields.push(["full_name", patch.full_name]);
  if (patch.role !== undefined) fields.push(["role", patch.role]);
  if (patch.is_principal !== undefined) fields.push(["is_principal", patch.is_principal ? 1 : 0]);
  if (patch.department_slugs !== undefined)
    fields.push(["department_slugs_json", JSON.stringify(patch.department_slugs)]);
  if (patch.email !== undefined) fields.push(["email", patch.email]);
  if (patch.slack_user_id !== undefined) fields.push(["slack_user_id", patch.slack_user_id]);
  if (patch.telegram_chat_id !== undefined) fields.push(["telegram_chat_id", patch.telegram_chat_id]);
  if (patch.discord_user_id !== undefined) fields.push(["discord_user_id", patch.discord_user_id]);
  if (patch.preferred_channel !== undefined) fields.push(["preferred_channel", patch.preferred_channel]);
  if (patch.response_sla_hours !== undefined) fields.push(["response_sla_hours", patch.response_sla_hours]);
  if (patch.clear_on_leave) {
    fields.push(["on_leave_until", null]);
  } else if (patch.on_leave_until !== undefined) {
    fields.push(["on_leave_until", patch.on_leave_until]);
  }
  if (patch.reports_to_person_id !== undefined)
    fields.push(["reports_to_person_id", patch.reports_to_person_id]);

  if (fields.length > 0) {
    fields.push(["updated_at", new Date().toISOString()]);
    const setClause = fields.map(([name]) => `${name} = ?`).join(", ");
    const values = [...fields.map(([, v]) => v), id];
    db.run(`UPDATE people SET ${setClause} WHERE id = ?`, values as never[]);
  }

  if (patch.authority_scope !== undefined) {
    setAuthorityScope(db, id, patch.authority_scope);
  }
  if (patch.availability !== undefined) {
    setAvailability(db, id, patch.availability);
  }

  return getPerson(db, id);
}

export function archivePerson(db: Db, id: number): boolean {
  const person = getPerson(db, id);
  if (!person) return false;
  if (person.archived) return false;

  // Principal protection: refuse to archive the last non-archived principal.
  if (person.is_principal) {
    const otherPrincipals = db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM people WHERE is_principal = 1 AND archived = 0 AND id != ?",
      )
      .get(id);
    if ((otherPrincipals?.n ?? 0) === 0) {
      throw new Error("Cannot archive the last principal — assign a replacement principal first");
    }
  }

  const result = db.run("UPDATE people SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0", [
    new Date().toISOString(),
    id,
  ]);
  return result.changes > 0;
}

// ── validation for route layer ─────────────────────────────────────────────

export function validatePersonCreate(
  body: unknown,
): { ok: true; data: PersonCreate } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };

  const fullName = body["full_name"];
  if (typeof fullName !== "string" || fullName.trim() === "")
    return { ok: false, error: "full_name is required and must not be blank" };
  if (fullName.trim().length > 200)
    return { ok: false, error: "full_name must be at most 200 characters" };

  const role = body["role"];
  if (role !== undefined && typeof role !== "string")
    return { ok: false, error: "role must be a string" };
  if (typeof role === "string" && role.length > 200)
    return { ok: false, error: "role must be at most 200 characters" };

  if ("is_principal" in body && body["is_principal"] !== undefined && typeof body["is_principal"] !== "boolean")
    return { ok: false, error: "is_principal must be a boolean" };

  if ("department_slugs" in body && body["department_slugs"] !== undefined) {
    if (!Array.isArray(body["department_slugs"]))
      return { ok: false, error: "department_slugs must be an array" };
    for (const s of body["department_slugs"] as unknown[]) {
      if (typeof s !== "string") return { ok: false, error: "department_slugs must be strings" };
    }
  }

  for (const field of ["email", "slack_user_id", "telegram_chat_id", "discord_user_id"] as const) {
    if (field in body && body[field] !== undefined && body[field] !== null && typeof body[field] !== "string")
      return { ok: false, error: `${field} must be a string or null` };
  }

  if ("preferred_channel" in body && body["preferred_channel"] !== undefined) {
    const parsed = validatePreferredChannel(body["preferred_channel"]);
    if (!parsed.ok) return { ok: false, error: parsed.error };
  }

  if ("response_sla_hours" in body && body["response_sla_hours"] !== undefined) {
    const v = body["response_sla_hours"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 8760)
      return { ok: false, error: "response_sla_hours must be an integer 1-8760" };
  }

  if ("on_leave_until" in body && body["on_leave_until"] !== undefined && body["on_leave_until"] !== null) {
    if (typeof body["on_leave_until"] !== "string" || !isValidDateString(body["on_leave_until"] as string))
      return { ok: false, error: "on_leave_until must be YYYY-MM-DD or null" };
  }

  if ("reports_to_person_id" in body && body["reports_to_person_id"] !== undefined && body["reports_to_person_id"] !== null) {
    const v = body["reports_to_person_id"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
      return { ok: false, error: "reports_to_person_id must be a positive integer or null" };
  }

  if ("authority_scope" in body && body["authority_scope"] !== undefined) {
    if (!Array.isArray(body["authority_scope"]))
      return { ok: false, error: "authority_scope must be an array" };
    for (const token of body["authority_scope"] as unknown[]) {
      const parsed = validateAuthorityScope(token);
      if (!parsed.ok) return { ok: false, error: parsed.error };
    }
  }

  if ("availability" in body && body["availability"] !== undefined) {
    if (!Array.isArray(body["availability"]))
      return { ok: false, error: "availability must be an array" };
    for (const entry of body["availability"] as unknown[]) {
      const parsed = validateAvailabilityWindow(entry);
      if (!parsed.ok) return { ok: false, error: parsed.error };
    }
  }

  const data: PersonCreate = {
    full_name: (fullName as string).trim(),
    ...(typeof role === "string" ? { role } : {}),
    ...(typeof body["is_principal"] === "boolean" ? { is_principal: body["is_principal"] as boolean } : {}),
    ...(Array.isArray(body["department_slugs"])
      ? { department_slugs: (body["department_slugs"] as string[]) }
      : {}),
    ...("email" in body ? { email: (body["email"] as string | null) } : {}),
    ...("slack_user_id" in body ? { slack_user_id: (body["slack_user_id"] as string | null) } : {}),
    ...("telegram_chat_id" in body ? { telegram_chat_id: (body["telegram_chat_id"] as string | null) } : {}),
    ...("discord_user_id" in body ? { discord_user_id: (body["discord_user_id"] as string | null) } : {}),
    ...("preferred_channel" in body && typeof body["preferred_channel"] === "string"
      ? { preferred_channel: body["preferred_channel"] as PreferredChannel }
      : {}),
    ...(typeof body["response_sla_hours"] === "number"
      ? { response_sla_hours: body["response_sla_hours"] as number }
      : {}),
    ...("on_leave_until" in body
      ? { on_leave_until: (body["on_leave_until"] as string | null) }
      : {}),
    ...("reports_to_person_id" in body
      ? { reports_to_person_id: (body["reports_to_person_id"] as number | null) }
      : {}),
    ...(Array.isArray(body["authority_scope"])
      ? { authority_scope: (body["authority_scope"] as AuthorityScope[]) }
      : {}),
    ...(Array.isArray(body["availability"])
      ? {
          availability: (body["availability"] as unknown[]).map((raw) => {
            const parsed = validateAvailabilityWindow(raw);
            // Already validated above, so this cannot fail.
            return (parsed as { ok: true; value: AvailabilityWindow }).value;
          }),
        }
      : {}),
  };

  return { ok: true, data };
}

export function validatePersonPatch(
  body: unknown,
): { ok: true; data: PersonPatch } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  if (Object.keys(body).length === 0) return { ok: true, data: {} };

  if ("full_name" in body && body["full_name"] !== undefined) {
    if (typeof body["full_name"] !== "string" || (body["full_name"] as string).trim() === "")
      return { ok: false, error: "full_name must not be blank" };
    if ((body["full_name"] as string).trim().length > 200)
      return { ok: false, error: "full_name must be at most 200 characters" };
  }

  if ("role" in body && body["role"] !== undefined) {
    if (typeof body["role"] !== "string") return { ok: false, error: "role must be a string" };
    if ((body["role"] as string).length > 200)
      return { ok: false, error: "role must be at most 200 characters" };
  }

  if ("is_principal" in body && body["is_principal"] !== undefined && typeof body["is_principal"] !== "boolean")
    return { ok: false, error: "is_principal must be a boolean" };

  if ("department_slugs" in body && body["department_slugs"] !== undefined && body["department_slugs"] !== null) {
    if (!Array.isArray(body["department_slugs"]))
      return { ok: false, error: "department_slugs must be an array" };
    for (const s of body["department_slugs"] as unknown[]) {
      if (typeof s !== "string") return { ok: false, error: "department_slugs must be strings" };
    }
  }

  for (const field of ["email", "slack_user_id", "telegram_chat_id", "discord_user_id"] as const) {
    if (field in body && body[field] !== undefined && body[field] !== null && typeof body[field] !== "string")
      return { ok: false, error: `${field} must be a string or null` };
  }

  if ("preferred_channel" in body && body["preferred_channel"] !== undefined && body["preferred_channel"] !== null) {
    const parsed = validatePreferredChannel(body["preferred_channel"]);
    if (!parsed.ok) return { ok: false, error: parsed.error };
  }

  if ("response_sla_hours" in body && body["response_sla_hours"] !== undefined && body["response_sla_hours"] !== null) {
    const v = body["response_sla_hours"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 8760)
      return { ok: false, error: "response_sla_hours must be an integer 1-8760" };
  }

  if ("on_leave_until" in body && body["on_leave_until"] !== undefined && body["on_leave_until"] !== null) {
    if (typeof body["on_leave_until"] !== "string" || !isValidDateString(body["on_leave_until"] as string))
      return { ok: false, error: "on_leave_until must be YYYY-MM-DD or null" };
  }

  if ("clear_on_leave" in body && body["clear_on_leave"] !== undefined && typeof body["clear_on_leave"] !== "boolean")
    return { ok: false, error: "clear_on_leave must be a boolean" };

  if ("reports_to_person_id" in body && body["reports_to_person_id"] !== undefined && body["reports_to_person_id"] !== null) {
    const v = body["reports_to_person_id"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
      return { ok: false, error: "reports_to_person_id must be a positive integer or null" };
  }

  if ("authority_scope" in body && body["authority_scope"] !== undefined && body["authority_scope"] !== null) {
    if (!Array.isArray(body["authority_scope"]))
      return { ok: false, error: "authority_scope must be an array" };
    for (const token of body["authority_scope"] as unknown[]) {
      const parsed = validateAuthorityScope(token);
      if (!parsed.ok) return { ok: false, error: parsed.error };
    }
  }

  if ("availability" in body && body["availability"] !== undefined && body["availability"] !== null) {
    if (!Array.isArray(body["availability"]))
      return { ok: false, error: "availability must be an array" };
    for (const entry of body["availability"] as unknown[]) {
      const parsed = validateAvailabilityWindow(entry);
      if (!parsed.ok) return { ok: false, error: parsed.error };
    }
  }

  const data: PersonPatch = {};
  if ("full_name" in body && body["full_name"] !== undefined)
    data.full_name = (body["full_name"] as string).trim();
  if ("role" in body && body["role"] !== undefined) data.role = body["role"] as string;
  if ("is_principal" in body && body["is_principal"] !== undefined)
    data.is_principal = body["is_principal"] as boolean;
  if ("department_slugs" in body && body["department_slugs"] !== undefined && body["department_slugs"] !== null)
    data.department_slugs = body["department_slugs"] as string[];
  if ("email" in body) data.email = body["email"] as string | null;
  if ("slack_user_id" in body) data.slack_user_id = body["slack_user_id"] as string | null;
  if ("telegram_chat_id" in body) data.telegram_chat_id = body["telegram_chat_id"] as string | null;
  if ("discord_user_id" in body) data.discord_user_id = body["discord_user_id"] as string | null;
  if ("preferred_channel" in body && body["preferred_channel"] !== undefined && body["preferred_channel"] !== null)
    data.preferred_channel = body["preferred_channel"] as PreferredChannel;
  if ("response_sla_hours" in body && body["response_sla_hours"] !== undefined && body["response_sla_hours"] !== null)
    data.response_sla_hours = body["response_sla_hours"] as number;
  if ("on_leave_until" in body) data.on_leave_until = body["on_leave_until"] as string | null;
  if ("clear_on_leave" in body && body["clear_on_leave"] !== undefined)
    data.clear_on_leave = body["clear_on_leave"] as boolean;
  if ("reports_to_person_id" in body) data.reports_to_person_id = body["reports_to_person_id"] as number | null;
  if ("authority_scope" in body && body["authority_scope"] !== undefined)
    data.authority_scope = (body["authority_scope"] as AuthorityScope[] | null) ?? [];
  if ("availability" in body && body["availability"] !== undefined) {
    if (body["availability"] === null) {
      data.availability = [];
    } else {
      data.availability = (body["availability"] as unknown[]).map((raw) => {
        const parsed = validateAvailabilityWindow(raw);
        return (parsed as { ok: true; value: AvailabilityWindow }).value;
      });
    }
  }

  return { ok: true, data };
}
