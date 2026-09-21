/**
 * Staff onboarding — templates, plans, tasks.
 *
 * Port of `staff_onboarding/store.py` + `staff_onboarding/models.py` +
 * `api/routes/staff_onboarding.py`. Templates are reusable blueprints;
 * plans are per-hire instances; tasks are checklist items.
 */

import type { Db } from "../../db.ts";

export type OnboardingStatus = "draft" | "active" | "completed" | "archived";
export const ONBOARDING_STATUSES: readonly OnboardingStatus[] = ["draft", "active", "completed", "archived"];
export type OnboardingPhase = "pre_start" | "week_1" | "day_30" | "day_60" | "day_90";
export const ONBOARDING_PHASES: readonly OnboardingPhase[] = ["pre_start", "week_1", "day_30", "day_60", "day_90"];
export type TaskStatus = "pending" | "in_progress" | "done" | "skipped";
export const TASK_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "done", "skipped"];

export interface OnboardingTemplate {
  name: string;
  title: string;
  description: string;
  department: string;
  ramp_days: number;
  checkin_cadence: string;
  task_specs: Array<{ title: string; category?: string; phase?: string; owner_role?: string; due_offset_days?: number }>;
  brief_sections: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OnboardingPlan {
  id: number;
  full_name: string;
  role: string;
  start_date: string;
  person_id: number | null;
  manager_person_id: number | null;
  buddy_person_id: number | null;
  template_name: string;
  status: OnboardingStatus;
  current_phase: OnboardingPhase;
  brief_artifact: string;
  reading_list: string[];
  ramp_segments: string[];
  ramp_next_index: number;
  engagement_id: number | null;
  candidate_id: number | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  completion_pct?: number;
}

export interface OnboardingTask {
  id: number;
  plan_id: number;
  phase: OnboardingPhase;
  title: string;
  category: string;
  owner_person_id: number | null;
  due_date: string | null;
  status: TaskStatus;
  completed_at: string | null;
  completed_by_person_id: number | null;
  notes: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function nowIso(): string { return new Date().toISOString(); }

function rowToTemplate(row: Record<string, unknown>): OnboardingTemplate {
  let specs: OnboardingTemplate["task_specs"] = [];
  try { specs = JSON.parse((row["task_specs_json"] as string) ?? "[]") as typeof specs; } catch { specs = []; }
  let brief: string[] = [];
  try { brief = JSON.parse((row["brief_sections_json"] as string) ?? "[]") as string[]; } catch { brief = []; }
  return {
    name: row["name"] as string,
    title: row["title"] as string,
    description: (row["description"] as string) ?? "",
    department: (row["department"] as string) ?? "",
    ramp_days: (row["ramp_days"] as number) ?? 0,
    checkin_cadence: (row["checkin_cadence"] as string) ?? "",
    task_specs: specs,
    brief_sections: brief,
    is_active: Boolean(row["is_active"]),
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

function rowToPlan(row: Record<string, unknown>): OnboardingPlan {
  let reading: string[] = [];
  try { reading = JSON.parse((row["reading_list_json"] as string) ?? "[]") as string[]; } catch { reading = []; }
  let ramp: string[] = [];
  try { ramp = JSON.parse((row["ramp_segments_json"] as string) ?? "[]") as string[]; } catch { ramp = []; }
  return {
    id: row["id"] as number,
    full_name: row["full_name"] as string,
    role: (row["role"] as string) ?? "",
    start_date: row["start_date"] as string,
    person_id: (row["person_id"] as number | null) ?? null,
    manager_person_id: (row["manager_person_id"] as number | null) ?? null,
    buddy_person_id: (row["buddy_person_id"] as number | null) ?? null,
    template_name: (row["template_name"] as string) ?? "",
    status: row["status"] as OnboardingStatus,
    current_phase: row["current_phase"] as OnboardingPhase,
    brief_artifact: (row["brief_artifact"] as string) ?? "",
    reading_list: reading,
    ramp_segments: ramp,
    ramp_next_index: (row["ramp_next_index"] as number) ?? 0,
    engagement_id: (row["engagement_id"] as number | null) ?? null,
    candidate_id: (row["candidate_id"] as number | null) ?? null,
    archived: Boolean(row["archived"]),
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

function rowToTask(row: Record<string, unknown>): OnboardingTask {
  return {
    id: row["id"] as number,
    plan_id: row["plan_id"] as number,
    phase: row["phase"] as OnboardingPhase,
    title: row["title"] as string,
    category: (row["category"] as string) ?? "general",
    owner_person_id: (row["owner_person_id"] as number | null) ?? null,
    due_date: (row["due_date"] as string | null) ?? null,
    status: row["status"] as TaskStatus,
    completed_at: (row["completed_at"] as string | null) ?? null,
    completed_by_person_id: (row["completed_by_person_id"] as number | null) ?? null,
    notes: (row["notes"] as string) ?? "",
    sort_order: (row["sort_order"] as number) ?? 0,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

// ── templates ──────────────────────────────────────────────────────────────

export function listTemplates(db: Db, activeOnly = true): OnboardingTemplate[] {
  const where = activeOnly ? "WHERE is_active = 1" : "";
  const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM onboarding_templates ${where} ORDER BY name`).all();
  return rows.map(rowToTemplate);
}

export function getTemplate(db: Db, name: string): OnboardingTemplate | null {
  const row = db.query<Record<string, unknown>, [string]>("SELECT * FROM onboarding_templates WHERE name = ?").get(name);
  return row ? rowToTemplate(row) : null;
}

export function upsertTemplate(db: Db, data: OnboardingTemplate): OnboardingTemplate {
  const now = nowIso();
  const existing = getTemplate(db, data.name);
  const createdAt = existing ? existing.created_at : now;
  db.run(
    `INSERT INTO onboarding_templates (name, title, description, department, ramp_days, checkin_cadence, task_specs_json, brief_sections_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET title=excluded.title, description=excluded.description, department=excluded.department, ramp_days=excluded.ramp_days, checkin_cadence=excluded.checkin_cadence, task_specs_json=excluded.task_specs_json, brief_sections_json=excluded.brief_sections_json, is_active=excluded.is_active, updated_at=excluded.updated_at`,
    [data.name, data.title, data.description, data.department, data.ramp_days, data.checkin_cadence, JSON.stringify(data.task_specs), JSON.stringify(data.brief_sections), data.is_active ? 1 : 0, createdAt, now],
  );
  const saved = getTemplate(db, data.name);
  if (!saved) throw new Error("Template vanished after save");
  return saved;
}

export function deleteTemplate(db: Db, name: string): boolean {
  const result = db.run("DELETE FROM onboarding_templates WHERE name = ?", [name]);
  return result.changes > 0;
}

// ── plans ──────────────────────────────────────────────────────────────────

export function listPlans(db: Db, filters: { status?: OnboardingStatus; includeArchived?: boolean } = {}): OnboardingPlan[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!filters.includeArchived) clauses.push("archived = 0");
  if (filters.status) { clauses.push("status = ?"); params.push(filters.status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = params.length
    ? db.query<Record<string, unknown>, Array<string | number>>(`SELECT * FROM onboarding_plans ${where} ORDER BY id`).all(...(params as Array<string | number>))
    : db.query<Record<string, unknown>, []>(`SELECT * FROM onboarding_plans ${where} ORDER BY id`).all();
  return rows.map(rowToPlan);
}

export function getPlan(db: Db, id: number): OnboardingPlan | null {
  const row = db.query<Record<string, unknown>, [number]>("SELECT * FROM onboarding_plans WHERE id = ?").get(id);
  return row ? rowToPlan(row) : null;
}

export function createPlan(db: Db, data: { full_name: string; start_date: string; role?: string; template_name?: string; person_id?: number | null; manager_person_id?: number | null; buddy_person_id?: number | null; engagement_id?: number | null; candidate_id?: number | null }): OnboardingPlan {
  const now = nowIso();
  db.run(
    `INSERT INTO onboarding_plans (full_name, role, start_date, person_id, manager_person_id, buddy_person_id, template_name, status, current_phase, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 'pre_start', ?, ?)`,
    [data.full_name, data.role ?? "", data.start_date, data.person_id ?? null, data.manager_person_id ?? null, data.buddy_person_id ?? null, data.template_name ?? "", now, now],
  );
  const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id);
  // Instantiate tasks from template if present
  if (data.template_name) {
    const tmpl = getTemplate(db, data.template_name);
    if (tmpl) {
      for (let i = 0; i < tmpl.task_specs.length; i++) {
        const spec = tmpl.task_specs[i]!;
        db.run(
          `INSERT INTO onboarding_tasks (plan_id, phase, title, category, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, spec.phase ?? "week_1", spec.title, spec.category ?? "general", i, now, now],
        );
      }
    }
  }
  const created = getPlan(db, id);
  if (!created) throw new Error("Plan vanished after insert");
  return created;
}

export function updatePlan(db: Db, id: number, patch: Partial<Pick<OnboardingPlan, "person_id" | "manager_person_id" | "buddy_person_id" | "status" | "current_phase">>): OnboardingPlan | null {
  const existing = getPlan(db, id);
  if (!existing) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if ("person_id" in patch) { sets.push("person_id = ?"); vals.push(patch.person_id ?? null); }
  if ("manager_person_id" in patch) { sets.push("manager_person_id = ?"); vals.push(patch.manager_person_id ?? null); }
  if ("buddy_person_id" in patch) { sets.push("buddy_person_id = ?"); vals.push(patch.buddy_person_id ?? null); }
  if ("status" in patch && patch.status) { sets.push("status = ?"); vals.push(patch.status); }
  if ("current_phase" in patch && patch.current_phase) { sets.push("current_phase = ?"); vals.push(patch.current_phase); }
  if (sets.length === 0) return existing;
  vals.push(nowIso(), id);
  db.run(`UPDATE onboarding_plans SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, vals as Array<string | number | null>);
  return getPlan(db, id);
}

const PHASE_ORDER: OnboardingPhase[] = ["pre_start", "week_1", "day_30", "day_60", "day_90"];

export function advancePhase(db: Db, id: number): OnboardingPlan | null {
  const existing = getPlan(db, id);
  if (!existing) return null;
  const idx = PHASE_ORDER.indexOf(existing.current_phase);
  const next = idx >= 0 && idx < PHASE_ORDER.length - 1 ? PHASE_ORDER[idx + 1]! : existing.current_phase;
  if (next !== existing.current_phase) {
    db.run("UPDATE onboarding_plans SET current_phase = ?, updated_at = ? WHERE id = ?", [next, nowIso(), id]);
  }
  return getPlan(db, id);
}

export function archivePlan(db: Db, id: number): boolean {
  const result = db.run("UPDATE onboarding_plans SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0", [nowIso(), id]);
  return result.changes > 0;
}

// ── tasks ──────────────────────────────────────────────────────────────────

export function listTasks(db: Db, planId?: number): OnboardingTask[] {
  if (planId !== undefined) {
    const rows = db.query<Record<string, unknown>, [number]>("SELECT * FROM onboarding_tasks WHERE plan_id = ? ORDER BY sort_order, id").all(planId);
    return rows.map(rowToTask);
  }
  const rows = db.query<Record<string, unknown>, []>("SELECT * FROM onboarding_tasks ORDER BY plan_id, sort_order, id").all();
  return rows.map(rowToTask);
}

export function getTask(db: Db, id: number): OnboardingTask | null {
  const row = db.query<Record<string, unknown>, [number]>("SELECT * FROM onboarding_tasks WHERE id = ?").get(id);
  return row ? rowToTask(row) : null;
}

export function addTask(db: Db, planId: number, data: { title: string; phase?: OnboardingPhase; category?: string; owner_person_id?: number | null; due_date?: string | null }): OnboardingTask {
  const now = nowIso();
  const maxOrder = db.query<{ m: number | null }, [number]>("SELECT MAX(sort_order) as m FROM onboarding_tasks WHERE plan_id = ?").get(planId)?.m ?? -1;
  db.run(
    `INSERT INTO onboarding_tasks (plan_id, phase, title, category, owner_person_id, due_date, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [planId, data.phase ?? "week_1", data.title, data.category ?? "general", data.owner_person_id ?? null, data.due_date ?? null, (maxOrder ?? -1) + 1, now, now],
  );
  const id = Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id);
  const created = getTask(db, id);
  if (!created) throw new Error("Task vanished after insert");
  return created;
}

export function setTaskStatus(db: Db, id: number, status: TaskStatus, completedBy?: number | null): OnboardingTask | null {
  const existing = getTask(db, id);
  if (!existing) return null;
  const completedAt = status === "done" ? nowIso() : null;
  db.run("UPDATE onboarding_tasks SET status = ?, completed_at = ?, completed_by_person_id = ?, updated_at = ? WHERE id = ?", [status, completedAt, completedBy ?? null, nowIso(), id]);
  return getTask(db, id);
}

export function deleteTask(db: Db, id: number): boolean {
  const result = db.run("DELETE FROM onboarding_tasks WHERE id = ?", [id]);
  return result.changes > 0;
}

export function activatePlan(db: Db, id: number): OnboardingPlan | null {
  const existing = getPlan(db, id);
  if (!existing) return null;
  db.run("UPDATE onboarding_plans SET status = 'active', updated_at = ? WHERE id = ?", [nowIso(), id]);
  return getPlan(db, id);
}

export function archiveTask(db: Db, id: number): boolean {
  return deleteTask(db, id);
}
