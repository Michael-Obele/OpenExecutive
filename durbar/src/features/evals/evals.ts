/**
 * Evals — scenario runner and run persistence.
 *
 * Port of `evals/persistence.py` + `evals/scenarios.py` + `api/routes/evals.py`.
 * Scenarios are YAML files under `evals/_scenarios/` (builtin) plus user-added
 * rows in `eval_scenarios`. Runs are persisted in `eval_runs`. The LLM
 * execution is stubbed: a run is created as `running` and immediately
 * completed with a synthetic result so the API contract is stable.
 */

import type { Db } from "../../db.ts";

export const EVAL_KINDS = ["chat", "workflow", "triage", "mcp"] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];

export interface EvalRun {
  run_id: string;
  kind: string;
  scenario_ids: string;
  status: string;
  results: string | null;
  passed: number | null;
  total: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createEvalRun(
  db: Db,
  runId: string,
  kind: string,
  scenarioIds: string[],
): EvalRun {
  const now = nowIso();
  db.run(
    "INSERT INTO eval_runs (run_id, kind, scenario_ids, status, results, passed, total, created_at, updated_at) VALUES (?, ?, ?, 'running', '[]', 0, ?, ?, ?)",
    [runId, kind, JSON.stringify(scenarioIds), scenarioIds.length, now, now],
  );
  const row = getEvalRun(db, runId);
  if (!row) throw new Error("Eval run vanished after insert");
  return row;
}

export function getEvalRun(db: Db, runId: string): EvalRun | null {
  const row = db
    .query<
      Record<string, unknown>,
      [string]
    >("SELECT * FROM eval_runs WHERE run_id = ?")
    .get(runId);
  if (!row) return null;
  return {
    run_id: row["run_id"] as string,
    kind: row["kind"] as string,
    scenario_ids: row["scenario_ids"] as string,
    status: row["status"] as string,
    results: (row["results"] as string | null) ?? null,
    passed: (row["passed"] as number | null) ?? null,
    total: (row["total"] as number | null) ?? null,
    error: (row["error"] as string | null) ?? null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

export function listEvalRuns(
  db: Db,
  kind?: string,
  limit = 100,
): Array<Record<string, unknown>> {
  let rows: Record<string, unknown>[];
  if (kind) {
    rows = db
      .query<
        Record<string, unknown>,
        [string, number]
      >("SELECT run_id, kind, status, passed, total, created_at, updated_at FROM eval_runs WHERE kind = ? ORDER BY updated_at DESC LIMIT ?")
      .all(kind, limit);
  } else {
    rows = db
      .query<
        Record<string, unknown>,
        [number]
      >("SELECT run_id, kind, status, passed, total, created_at, updated_at FROM eval_runs ORDER BY updated_at DESC LIMIT ?")
      .all(limit);
  }
  return rows;
}

export function completeEvalRun(db: Db, runId: string): void {
  db.run(
    "UPDATE eval_runs SET status = 'done', updated_at = ? WHERE run_id = ?",
    [nowIso(), runId],
  );
}

export function failEvalRun(db: Db, runId: string, error: string): void {
  db.run(
    "UPDATE eval_runs SET status = 'error', error = ?, updated_at = ? WHERE run_id = ?",
    [error, nowIso(), runId],
  );
}

export function cancelEvalRun(db: Db, runId: string): boolean {
  const result = db.run(
    "UPDATE eval_runs SET status = 'canceled', updated_at = ? WHERE run_id = ? AND status = 'running'",
    [nowIso(), runId],
  );
  return result.changes > 0;
}

export function deleteEvalRun(db: Db, runId: string): boolean {
  const result = db.run("DELETE FROM eval_runs WHERE run_id = ?", [runId]);
  return result.changes > 0;
}

export function appendScenarioResult(
  db: Db,
  runId: string,
  result: Record<string, unknown>,
  passedDelta: number,
): void {
  const row = db
    .query<
      Record<string, unknown>,
      [string]
    >("SELECT results, passed FROM eval_runs WHERE run_id = ?")
    .get(runId);
  if (!row) return;
  let results: unknown[] = [];
  try {
    results = JSON.parse((row["results"] as string) ?? "[]") as unknown[];
  } catch {
    results = [];
  }
  results.push(result);
  const passed = ((row["passed"] as number) ?? 0) + passedDelta;
  db.run(
    "UPDATE eval_runs SET results = ?, passed = ?, updated_at = ? WHERE run_id = ?",
    [JSON.stringify(results), passed, nowIso(), runId],
  );
}

// ── scenarios ──────────────────────────────────────────────────────────────

function builtinScenarioMeta(): Array<Record<string, unknown>> {
  // Built-in scenarios are YAML files under evals/_scenarios/ — read from filesystem.
  // Mirrors evals/scenarios.py _load_builtin_scenarios but without YAML parsing:
  // we extract id/domain/description via regex so no yaml dep is needed.
  try {
    const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const candidates = [
      new URL("../../../evals/_scenarios", import.meta.url).pathname,
      new URL("../../../../evals/_scenarios", import.meta.url).pathname,
    ];
    for (const dir of candidates) {
      try {
        const files = readdirSync(dir).filter((f: string) => f.endsWith(".yaml")).sort();
        if (files.length === 0) continue;
        return files.map((f: string) => {
          let text = "";
          try { text = readFileSync(join(dir, f), "utf8"); } catch { /* ignore */ }
          const idMatch = text.match(/^id:\s*(\S+)/m);
          const domainMatch = text.match(/^domain:\s*(\S+)/m);
          const descMatch = text.match(/^description:\s*["']?(.*?)["']?\s*$/m);
          const typeMatch = text.match(/^type:\s*(\S+)/m);
          const requiresMcp = text.includes("requires_mcp");
          // Derive kind like scenarios.py scenario_kind()
          let kind = "chat";
          if (domainMatch && domainMatch[1]!.trim() === "triage") kind = "triage";
          else if (typeMatch && typeMatch[1]!.trim() === "workflow") kind = "workflow";
          else if (requiresMcp) kind = "mcp";
          return {
            id: idMatch ? idMatch[1]!.trim() : f.replace(/\.yaml$/, ""),
            kind,
            domain: domainMatch ? domainMatch[1]!.trim() : "",
            description: descMatch ? descMatch[1]!.trim() : "",
            is_builtin: true,
          };
        });
      } catch { /* dir missing */ }
    }
  } catch { /* require failed */ }
  return [];
}

export function listScenarioMeta(_db: Db): Array<Record<string, unknown>> {
  const builtins = builtinScenarioMeta();
  let userRows: Array<Record<string, unknown>> = [];
  try {
    const rows = _db
      .query<
        Record<string, unknown>,
        []
      >("SELECT id, kind, created_at, updated_at FROM eval_scenarios ORDER BY created_at ASC")
      .all();
    userRows = rows.map((r) => ({
      id: r["id"],
      kind: r["kind"],
      is_builtin: false,
      created_at: r["created_at"],
      updated_at: r["updated_at"],
    }));
  } catch {
    /* table missing */
  }
  return [...builtins, ...userRows];
}

export function getUserScenario(
  db: Db,
  id: string,
): Record<string, unknown> | null {
  const row = db
    .query<
      Record<string, unknown>,
      [string]
    >("SELECT * FROM eval_scenarios WHERE id = ?")
    .get(id);
  return row ?? null;
}

export function createUserScenario(
  db: Db,
  id: string,
  kind: string,
  yaml: string,
): void {
  const now = nowIso();
  db.run(
    "INSERT INTO eval_scenarios (id, kind, yaml, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [id, kind, yaml, now, now],
  );
}

export function updateUserScenario(
  db: Db,
  id: string,
  kind: string,
  yaml: string,
): boolean {
  const result = db.run(
    "UPDATE eval_scenarios SET kind = ?, yaml = ?, updated_at = ? WHERE id = ?",
    [kind, yaml, nowIso(), id],
  );
  return result.changes > 0;
}

export function deleteUserScenario(db: Db, id: string): boolean {
  const result = db.run("DELETE FROM eval_scenarios WHERE id = ?", [id]);
  return result.changes > 0;
}

export function validateScenarioYaml(yaml: string): {
  id: string;
  kind: string;
} {
  // Require `id:` at the start of a line (not inside comments or nested values)
  const idMatch = yaml.match(/^id:\s*(\S+)/m);
  if (!idMatch) throw new Error("Scenario YAML must contain an `id` field");
  const kindMatch = yaml.match(/^kind:\s*(\S+)/m);
  const kind = kindMatch ? kindMatch[1]!.trim() : "chat";
  if (!EVAL_KINDS.includes(kind as EvalKind))
    throw new Error(`Invalid kind: ${kind}`);
  return { id: idMatch[1]!.trim(), kind };
}

export function scenarioKind(parsed: { kind: string }): string {
  return parsed.kind;
}
