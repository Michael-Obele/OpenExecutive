/**
 * Departments + Goals — the org chart that the council and workflows read.
 *
 * Port of `departments/store.py` + `departments/models.py` + the HTTP layer in
 * `api/routes/departments.py`. One file owns the types, the store helpers, and
 * the validation so the route layer in `src/index.ts` stays thin.
 *
 * The upstream store is ~900 lines because it carries three incremental
 * migrations (specialist_key nullable, okrs→goals rename, channel columns) and
 * a Honcho mirror. Durbar's schema is fresh, so the DDL is declared together
 * in `src/schema.ts`; this file only needs the live shape.
 */

import type { Db } from "../../db.ts";

// ── types ──────────────────────────────────────────────────────────────────

export type AuthorityLevel = "auto_execute" | "propose_only" | "escalate";
export type GoalStatus = "on_track" | "at_risk" | "off_track";
export type PeriodType = "week" | "month" | "quarter" | "year" | "ongoing";

export const AUTHORITY_LEVELS: readonly AuthorityLevel[] = [
  "auto_execute",
  "propose_only",
  "escalate",
];
export const GOAL_STATUSES: readonly GoalStatus[] = [
  "on_track",
  "at_risk",
  "off_track",
];
export const PERIOD_TYPES: readonly PeriodType[] = [
  "week",
  "month",
  "quarter",
  "year",
  "ongoing",
];

export interface DepartmentCharter {
  mission: string;
  scope: string[];
  out_of_scope: string[];
}

export interface DepartmentConfig {
  slug: string;
  title: string;
  specialist_key: string | null;
  charter: DepartmentCharter;
  authority_level: AuthorityLevel;
  head_person_id: number | null;
  head_persona_slug: string | null;
  cadences: Record<string, string>;
  slack_channel_id: string | null;
  discord_channel_id: string | null;
  telegram_chat_id: string | null;
  watched_entities: string[];
}

export interface Goal {
  id: number;
  department_slug: string;
  period_type: PeriodType;
  period_value: string;
  key_result: string;
  target: string;
  current: string;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
  last_reviewed_at: string;
}

export interface DepartmentState {
  config: DepartmentConfig;
  goals: Goal[];
  headcount: number | null;
  budget_usd: number | null;
  member_person_ids: number[];
  updated_at: string;
}

// ── slug ───────────────────────────────────────────────────────────────────

const NON_SLUG = /[^a-z0-9]+/g;

export function slugify(title: string, fallback = "department"): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(NON_SLUG, "-")
    .replace(/^-|-$/g, "");
  return slug || fallback;
}

// ── validation ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateAuthorityLevel(
  value: unknown,
): { ok: true; value: AuthorityLevel } | { ok: false; error: string } {
  if (
    typeof value !== "string" ||
    !(AUTHORITY_LEVELS as readonly string[]).includes(value)
  ) {
    return {
      ok: false,
      error: `authority_level must be one of ${AUTHORITY_LEVELS.join(", ")}`,
    };
  }
  return { ok: true, value: value as AuthorityLevel };
}

export function validateGoalStatus(
  value: unknown,
): { ok: true; value: GoalStatus } | { ok: false; error: string } {
  if (
    typeof value !== "string" ||
    !(GOAL_STATUSES as readonly string[]).includes(value)
  ) {
    return {
      ok: false,
      error: `status must be one of ${GOAL_STATUSES.join(", ")}`,
    };
  }
  return { ok: true, value: value as GoalStatus };
}

export function validatePeriodType(
  value: unknown,
): { ok: true; value: PeriodType } | { ok: false; error: string } {
  if (
    typeof value !== "string" ||
    !(PERIOD_TYPES as readonly string[]).includes(value)
  ) {
    return {
      ok: false,
      error: `period_type must be one of ${PERIOD_TYPES.join(", ")}`,
    };
  }
  return { ok: true, value: value as PeriodType };
}

// ── row mapping ────────────────────────────────────────────────────────────

function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

interface DepartmentRow {
  slug: string;
  title: string;
  specialist_key: string | null;
  charter_mission: string;
  charter_scope_json: string;
  charter_out_of_scope_json: string;
  authority_level: string;
  head_person_id: number | null;
  head_persona_slug: string | null;
  cadences_json: string;
  headcount: number | null;
  budget_usd: number | null;
  updated_at: string;
  slack_channel_id?: string | null;
  discord_channel_id?: string | null;
  telegram_chat_id?: string | null;
  watched_entities_json?: string | null;
}

interface GoalRow {
  id: number;
  department_slug: string;
  period_type: string;
  period_value: string;
  key_result: string;
  target: string;
  current: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_reviewed_at: string | null;
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    department_slug: row.department_slug,
    period_type: (PERIOD_TYPES as readonly string[]).includes(row.period_type)
      ? (row.period_type as PeriodType)
      : "quarter",
    period_value: row.period_value,
    key_result: row.key_result,
    target: row.target,
    current: row.current,
    status: (GOAL_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as GoalStatus)
      : "on_track",
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_reviewed_at: row.last_reviewed_at ?? "",
  };
}

function rowToState(row: DepartmentRow, goals: Goal[]): DepartmentState {
  const authority: AuthorityLevel = (
    AUTHORITY_LEVELS as readonly string[]
  ).includes(row.authority_level)
    ? (row.authority_level as AuthorityLevel)
    : "propose_only";

  const watchedRaw = row.watched_entities_json ?? "[]";
  let watched: string[] = [];
  try {
    const parsed: unknown = JSON.parse(watchedRaw);
    watched = Array.isArray(parsed)
      ? (parsed as string[]).filter((s) => typeof s === "string")
      : [];
  } catch {
    watched = [];
  }

  return {
    config: {
      slug: row.slug,
      title: row.title,
      specialist_key: row.specialist_key,
      charter: {
        mission: row.charter_mission,
        scope: parseJsonArray(row.charter_scope_json),
        out_of_scope: parseJsonArray(row.charter_out_of_scope_json),
      },
      authority_level: authority,
      head_person_id: row.head_person_id,
      head_persona_slug: row.head_persona_slug,
      cadences: parseJsonRecord(row.cadences_json),
      slack_channel_id: row.slack_channel_id ?? null,
      discord_channel_id: row.discord_channel_id ?? null,
      telegram_chat_id: row.telegram_chat_id ?? null,
      watched_entities: watched,
    },
    goals,
    headcount: row.headcount,
    budget_usd: row.budget_usd,
    member_person_ids: [],
    updated_at: row.updated_at,
  };
}

// ── seed ───────────────────────────────────────────────────────────────────

const DEFAULT_CHECK_IN_CADENCE = "daily@09:00";

interface SeedEntry {
  slug: string;
  title: string;
  specialist_key: string;
  mission: string;
  scope: string[];
  out_of_scope: string[];
}

const FINANCE_SCOPE = [
  "monthly close",
  "FP&A modelling",
  "fundraising preparation",
  "vendor contracts >$10K",
  "board financials",
];
const FINANCE_OUT_OF_SCOPE = [
  "pricing strategy (Product)",
  "payroll mechanics (HR Ops)",
  "procurement <$10K (Operations)",
];

const DEFAULT_DEPARTMENTS: readonly SeedEntry[] = [
  {
    slug: "strategy",
    title: "Strategy",
    specialist_key: "cso",
    mission:
      "Set company direction: competitive positioning, market entry, scenario planning, and long-range OKRs.",
    scope: [],
    out_of_scope: [],
  },
  {
    slug: "finance",
    title: "Finance",
    specialist_key: "cfo",
    mission:
      "Own the company's capital position, unit economics, financial planning, and investor reporting.",
    scope: FINANCE_SCOPE,
    out_of_scope: FINANCE_OUT_OF_SCOPE,
  },
  {
    slug: "hr",
    title: "People & Talent",
    specialist_key: "chro",
    mission:
      "Run the people function: hiring, compensation, performance, culture, and org design.",
    scope: [],
    out_of_scope: [],
  },
  {
    slug: "legal",
    title: "Legal",
    specialist_key: "gc",
    mission:
      "Manage legal exposure: contracts, IP, employment basics, and compliance (with appropriate disclaimers).",
    scope: [],
    out_of_scope: [],
  },
  {
    slug: "operations",
    title: "Operations",
    specialist_key: "coo",
    mission:
      "Run the operating layer: process design, vendor management, operational scaling, and metrics.",
    scope: [],
    out_of_scope: [],
  },
  {
    slug: "marketing",
    title: "Marketing",
    specialist_key: "cmo",
    mission:
      "Own GTM strategy, brand, messaging, PR, and crisis communications.",
    scope: [],
    out_of_scope: [],
  },
  {
    slug: "product",
    title: "Product",
    specialist_key: "cpo",
    mission:
      "Own the product roadmap, prioritization frameworks, and product strategy.",
    scope: [],
    out_of_scope: [],
  },
  {
    slug: "board_comms",
    title: "Board & Investor Comms",
    specialist_key: "board_comms",
    mission:
      "Prepare board decks, investor updates, and governance communications.",
    scope: [],
    out_of_scope: [],
  },
];

const SEEDED_META_KEY = "default_departments_seeded";

export function seedDefaultDepartments(db: Db): number {
  const seeded = db
    .query<{ value: string }, [string]>(
      "SELECT value FROM departments_meta WHERE key = ?",
    )
    .get(SEEDED_META_KEY);
  if (seeded) return 0;

  const countRow = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM departments")
    .get();
  if (countRow && countRow.n > 0) {
    const now = new Date().toISOString();
    db.run(
      "INSERT OR IGNORE INTO departments_meta (key, value) VALUES (?, ?)",
      [SEEDED_META_KEY, now],
    );
    return 0;
  }

  const now = new Date().toISOString();
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const entry of DEFAULT_DEPARTMENTS) {
      const result = db.run(
        `INSERT OR IGNORE INTO departments
           (slug, title, specialist_key, charter_mission, charter_scope_json, charter_out_of_scope_json,
            authority_level, cadences_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.slug,
          entry.title,
          entry.specialist_key,
          entry.mission,
          JSON.stringify(entry.scope),
          JSON.stringify(entry.out_of_scope),
          "propose_only",
          JSON.stringify({ check_in: DEFAULT_CHECK_IN_CADENCE }),
          now,
        ],
      );
      if (result.changes > 0) inserted += 1;
    }
    db.run(
      "INSERT OR IGNORE INTO departments_meta (key, value) VALUES (?, ?)",
      [SEEDED_META_KEY, now],
    );
  });
  tx();
  return inserted;
}

// ── departments CRUD ───────────────────────────────────────────────────────

export function listDepartments(db: Db): DepartmentState[] {
  const deptRows = db
    .query<DepartmentRow, []>("SELECT * FROM departments ORDER BY slug")
    .all();
  const goalRows = db
    .query<GoalRow, []>("SELECT * FROM department_goals ORDER BY id")
    .all();
  const bySlug = new Map<string, Goal[]>();
  for (const row of goalRows) {
    const list = bySlug.get(row.department_slug) ?? [];
    list.push(rowToGoal(row));
    bySlug.set(row.department_slug, list);
  }
  return deptRows.map((row) => rowToState(row, bySlug.get(row.slug) ?? []));
}

export function getDepartment(db: Db, slug: string): DepartmentState | null {
  const row = db
    .query<DepartmentRow, [string]>("SELECT * FROM departments WHERE slug = ?")
    .get(slug);
  if (!row) return null;
  const goals = db
    .query<GoalRow, [string]>(
      "SELECT * FROM department_goals WHERE department_slug = ? ORDER BY id",
    )
    .all(slug)
    .map(rowToGoal);
  return rowToState(row, goals);
}

export function createDepartment(
  db: Db,
  title: string,
  mission = "",
): DepartmentState {
  const trimmed = title.trim();
  if (trimmed === "") throw new Error("Department title must not be blank");
  if (trimmed.length > 128)
    throw new Error("Department title must be at most 128 characters");
  if (mission.length > 1024)
    throw new Error("mission must be at most 1024 characters");

  const baseSlug = slugify(trimmed);
  let slug = baseSlug;
  let suffix = 2;
  while (
    db
      .query<{ slug: string }, [string]>(
        "SELECT slug FROM departments WHERE slug = ?",
      )
      .get(slug)
  ) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  const now = new Date().toISOString();
  db.run(
    `INSERT INTO departments
       (slug, title, specialist_key, charter_mission, charter_scope_json, charter_out_of_scope_json,
        authority_level, cadences_json, updated_at)
     VALUES (?, ?, NULL, ?, '[]', '[]', ?, ?, ?)`,
    [
      slug,
      trimmed,
      mission,
      "propose_only",
      JSON.stringify({ check_in: DEFAULT_CHECK_IN_CADENCE }),
      now,
    ],
  );

  const created = getDepartment(db, slug);
  if (!created) throw new Error(`Department ${slug} vanished after insert`);
  return created;
}

export function deleteDepartment(db: Db, slug: string): boolean {
  // Delete goals first so FK semantics are explicit even without ON DELETE CASCADE.
  db.run("DELETE FROM department_goals WHERE department_slug = ?", [slug]);
  const result = db.run("DELETE FROM departments WHERE slug = ?", [slug]);
  return result.changes > 0;
}

export interface DepartmentPatch {
  title?: string;
  charter?: DepartmentCharter;
  authority_level?: AuthorityLevel;
  head_person_id?: number | null;
  head_persona_slug?: string | null;
  cadences?: Record<string, string>;
  headcount?: number | null;
  budget_usd?: number | null;
  slack_channel_id?: string | null;
  discord_channel_id?: string | null;
  telegram_chat_id?: string | null;
  watched_entities?: string[];
  /** When true, the caller explicitly set the field to null to clear it. */
  _clear_head_person_id?: boolean;
  _clear_slack?: boolean;
  _clear_discord?: boolean;
  _clear_telegram?: boolean;
}

export function updateDepartment(
  db: Db,
  slug: string,
  patch: DepartmentPatch,
): boolean {
  const fields: Array<[string, unknown]> = [];

  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (t === "") throw new Error("title must not be blank");
    fields.push(["title", t]);
  }
  if (patch.charter !== undefined) {
    fields.push(["charter_mission", patch.charter.mission]);
    fields.push(["charter_scope_json", JSON.stringify(patch.charter.scope)]);
    fields.push([
      "charter_out_of_scope_json",
      JSON.stringify(patch.charter.out_of_scope),
    ]);
  }
  if (patch.authority_level !== undefined) {
    fields.push(["authority_level", patch.authority_level]);
  }
  if (patch._clear_head_person_id || patch.head_person_id !== undefined) {
    fields.push(["head_person_id", patch.head_person_id ?? null]);
  }
  if (patch.head_persona_slug !== undefined) {
    fields.push(["head_persona_slug", patch.head_persona_slug]);
  }
  if (patch.cadences !== undefined) {
    fields.push(["cadences_json", JSON.stringify(patch.cadences)]);
  }
  if (patch.headcount !== undefined) {
    fields.push(["headcount", patch.headcount]);
  }
  if (patch.budget_usd !== undefined) {
    fields.push(["budget_usd", patch.budget_usd]);
  }
  if (patch._clear_slack || patch.slack_channel_id !== undefined) {
    fields.push(["slack_channel_id", patch.slack_channel_id ?? null]);
  }
  if (patch._clear_discord || patch.discord_channel_id !== undefined) {
    fields.push(["discord_channel_id", patch.discord_channel_id ?? null]);
  }
  if (patch._clear_telegram || patch.telegram_chat_id !== undefined) {
    fields.push(["telegram_chat_id", patch.telegram_chat_id ?? null]);
  }
  if (patch.watched_entities !== undefined) {
    fields.push([
      "watched_entities_json",
      JSON.stringify(patch.watched_entities),
    ]);
  }

  if (fields.length === 0) return getDepartment(db, slug) !== null;

  fields.push(["updated_at", new Date().toISOString()]);
  const setClause = fields.map(([name]) => `${name} = ?`).join(", ");
  const values = [...fields.map(([, v]) => v), slug];
  const result = db.run(
    `UPDATE departments SET ${setClause} WHERE slug = ?`,
    values as never[],
  );
  return result.changes > 0;
}

// ── goals ──────────────────────────────────────────────────────────────────

export function getGoal(db: Db, id: number): Goal | null {
  const row = db
    .query<GoalRow, [number]>("SELECT * FROM department_goals WHERE id = ?")
    .get(id);
  return row ? rowToGoal(row) : null;
}

export function listGoals(db: Db, departmentSlug: string): Goal[] {
  return db
    .query<GoalRow, [string]>(
      "SELECT * FROM department_goals WHERE department_slug = ? ORDER BY id",
    )
    .all(departmentSlug)
    .map(rowToGoal);
}

export interface GoalCreate {
  period_type?: PeriodType;
  period_value: string;
  key_result: string;
  target: string;
  current?: string;
  status?: GoalStatus;
}

export function insertGoal(
  db: Db,
  departmentSlug: string,
  input: GoalCreate,
): number {
  const now = new Date().toISOString();
  const result = db.run(
    `INSERT INTO department_goals
       (department_slug, period_type, period_value, key_result, target, current, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      departmentSlug,
      input.period_type ?? "quarter",
      input.period_value,
      input.key_result,
      input.target,
      input.current ?? "",
      input.status ?? "on_track",
      now,
      now,
    ],
  );
  return Number(result.lastInsertRowid);
}

export interface GoalPatch {
  period_type?: PeriodType;
  period_value?: string;
  key_result?: string;
  target?: string;
  current?: string;
  status?: GoalStatus;
}

export function updateGoal(db: Db, id: number, patch: GoalPatch): boolean {
  const fields: Array<[string, unknown]> = [];
  if (patch.period_type !== undefined)
    fields.push(["period_type", patch.period_type]);
  if (patch.period_value !== undefined)
    fields.push(["period_value", patch.period_value]);
  if (patch.key_result !== undefined)
    fields.push(["key_result", patch.key_result]);
  if (patch.target !== undefined) fields.push(["target", patch.target]);
  if (patch.current !== undefined) fields.push(["current", patch.current]);
  if (patch.status !== undefined) fields.push(["status", patch.status]);

  if (fields.length === 0) return getGoal(db, id) !== null;

  fields.push(["updated_at", new Date().toISOString()]);
  const setClause = fields.map(([name]) => `${name} = ?`).join(", ");
  const values = [...fields.map(([, v]) => v), id];
  const result = db.run(
    `UPDATE department_goals SET ${setClause} WHERE id = ?`,
    values as never[],
  );
  return result.changes > 0;
}

export function deleteGoal(db: Db, id: number): boolean {
  const result = db.run("DELETE FROM department_goals WHERE id = ?", [id]);
  return result.changes > 0;
}

// ── validation helpers for route layer ─────────────────────────────────────

export function validateDepartmentCreate(
  body: unknown,
): { ok: true; title: string; mission: string } | { ok: false; error: string } {
  if (!isRecord(body))
    return { ok: false, error: "body must be a JSON object" };
  const title = body["title"];
  if (typeof title !== "string" || title.trim() === "")
    return { ok: false, error: "title is required and must not be blank" };
  if (title.trim().length > 128)
    return { ok: false, error: "title must be at most 128 characters" };
  const mission = body["mission"];
  if (mission !== undefined && typeof mission !== "string")
    return { ok: false, error: "mission must be a string" };
  if (typeof mission === "string" && mission.length > 1024)
    return { ok: false, error: "mission must be at most 1024 characters" };
  return {
    ok: true,
    title: title.trim(),
    mission: typeof mission === "string" ? mission : "",
  };
}

export function validateGoalCreate(
  body: unknown,
): { ok: true; data: GoalCreate } | { ok: false; error: string } {
  if (!isRecord(body))
    return { ok: false, error: "body must be a JSON object" };

  // Legacy `quarter` alias: map to period_value/period_type if period_value absent.
  const raw: Record<string, unknown> = { ...body };
  if ("quarter" in raw && !("period_value" in raw)) {
    raw["period_value"] = raw["quarter"];
    if (!("period_type" in raw)) raw["period_type"] = "quarter";
  }

  const period_value = raw["period_value"];
  if (typeof period_value !== "string" || period_value.trim() === "")
    return {
      ok: false,
      error: "period_value is required and must not be blank",
    };
  if ((period_value as string).length > 64)
    return { ok: false, error: "period_value must be at most 64 characters" };

  const key_result = raw["key_result"];
  if (typeof key_result !== "string" || key_result.trim() === "")
    return { ok: false, error: "key_result is required and must not be blank" };
  if ((key_result as string).length > 512)
    return { ok: false, error: "key_result must be at most 512 characters" };

  const target = raw["target"];
  if (typeof target !== "string" || target.trim() === "")
    return { ok: false, error: "target is required and must not be blank" };
  if ((target as string).length > 512)
    return { ok: false, error: "target must be at most 512 characters" };

  let period_type: PeriodType | undefined;
  if ("period_type" in raw && raw["period_type"] !== undefined) {
    const parsed = validatePeriodType(raw["period_type"]);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    period_type = parsed.value;
  }

  let status: GoalStatus | undefined;
  if ("status" in raw && raw["status"] !== undefined) {
    const parsed = validateGoalStatus(raw["status"]);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    status = parsed.value;
  }

  const current = raw["current"];
  if (current !== undefined && typeof current !== "string")
    return { ok: false, error: "current must be a string" };
  if (typeof current === "string" && current.length > 512)
    return { ok: false, error: "current must be at most 512 characters" };

  return {
    ok: true,
    data: {
      ...(period_type ? { period_type } : {}),
      period_value: period_value as string,
      key_result: key_result as string,
      target: target as string,
      ...(current !== undefined ? { current: current as string } : {}),
      ...(status ? { status } : {}),
    },
  };
}

export function validateGoalPatch(
  body: unknown,
): { ok: true; data: GoalPatch } | { ok: false; error: string } {
  if (!isRecord(body))
    return { ok: false, error: "body must be a JSON object" };
  const raw: Record<string, unknown> = { ...body };
  if ("quarter" in raw && !("period_value" in raw)) {
    raw["period_value"] = raw["quarter"];
    if (!("period_type" in raw)) raw["period_type"] = "quarter";
  }

  const patch: GoalPatch = {};

  if ("period_type" in raw && raw["period_type"] !== undefined) {
    const parsed = validatePeriodType(raw["period_type"]);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    patch.period_type = parsed.value;
  }
  if ("period_value" in raw && raw["period_value"] !== undefined) {
    if (typeof raw["period_value"] !== "string")
      return { ok: false, error: "period_value must be a string" };
    if ((raw["period_value"] as string).length > 64)
      return { ok: false, error: "period_value must be at most 64 characters" };
    patch.period_value = raw["period_value"] as string;
  }
  if ("key_result" in raw && raw["key_result"] !== undefined) {
    if (typeof raw["key_result"] !== "string")
      return { ok: false, error: "key_result must be a string" };
    if ((raw["key_result"] as string).length > 512)
      return { ok: false, error: "key_result must be at most 512 characters" };
    patch.key_result = raw["key_result"] as string;
  }
  if ("target" in raw && raw["target"] !== undefined) {
    if (typeof raw["target"] !== "string")
      return { ok: false, error: "target must be a string" };
    if ((raw["target"] as string).length > 512)
      return { ok: false, error: "target must be at most 512 characters" };
    patch.target = raw["target"] as string;
  }
  if ("current" in raw && raw["current"] !== undefined) {
    if (typeof raw["current"] !== "string")
      return { ok: false, error: "current must be a string" };
    if ((raw["current"] as string).length > 512)
      return { ok: false, error: "current must be at most 512 characters" };
    patch.current = raw["current"] as string;
  }
  if ("status" in raw && raw["status"] !== undefined) {
    const parsed = validateGoalStatus(raw["status"]);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    patch.status = parsed.value;
  }

  return { ok: true, data: patch };
}
