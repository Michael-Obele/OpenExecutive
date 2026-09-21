/**
 * Artifacts — the Executive's deliverables.
 *
 * Port of `api/routes/artifacts.py` + `alerts/store.py` (list_artifact_alerts)
 * + `workflows/persistence.py` (list_artifact_runs). One file owns the types
 * and store helpers so the route layer stays thin.
 *
 * Artifacts are a unified view over two backing stores:
 *   1. `alerts` rows with source='artifact' (draft_artifact tool)
 *   2. `workflow_runs` rows with a non-empty artifact
 *
 * Addressed by composite id "{kind}:{native_id}" — alert:<int> / run:<hex>.
 * Archive is a reversible soft-hide (archived_at column); delete is permanent.
 */

import type { Db } from "../../db.ts";
import { getAlert, listArtifactAlerts } from "../alerts/alerts.ts";

// ── types ──────────────────────────────────────────────────────────────────

export interface ArtifactSummary {
  id: string;
  kind: "draft" | "workflow";
  title: string;
  source_label: string;
  created_at: string;
  preview: string | null;
  status: string;
  severity: string | null;
  archived_at: string | null;
}

export interface ArtifactDetail extends ArtifactSummary {
  body: string;
  rationale: string | null;
}

const DRAFT_SOURCE_LABEL = "Drafted by Executive";
const PREVIEW_CHARS = 200;

function preview(markdown: string, n = PREVIEW_CHARS): string {
  let text = (markdown ?? "").trimStart();
  if (text.startsWith("#")) {
    const br = text.indexOf("\n");
    if (br !== -1) text = text.slice(br + 1).trimStart();
  }
  return text.replace(/\s+/g, " ").slice(0, n);
}

function parseCompositeId(compositeId: string): { kind: "alert" | "run"; nativeId: string } | null {
  const sep = compositeId.indexOf(":");
  if (sep === -1) return null;
  const kind = compositeId.slice(0, sep);
  const nativeId = compositeId.slice(sep + 1);
  if ((kind !== "alert" && kind !== "run") || !nativeId) return null;
  return { kind, nativeId };
}

// ── store ──────────────────────────────────────────────────────────────────

export function listArtifacts(db: Db, limit = 200, archived = false): ArtifactSummary[] {
  const items: ArtifactSummary[] = [];

  for (const alert of listArtifactAlerts(db, limit, archived)) {
    items.push({
      id: `alert:${alert.id}`,
      kind: "draft",
      title: alert.headline,
      source_label: DRAFT_SOURCE_LABEL,
      created_at: alert.created_at,
      preview: preview(alert.body) || null,
      status: alert.status,
      severity: alert.severity,
      archived_at: alert.archived_at,
    });
  }

  const archivedClause = archived ? "AND archived_at IS NOT NULL" : "AND archived_at IS NULL";
  const runs = db
    .query<Record<string, unknown>, [number]>(
      `SELECT run_id, workflow_name, title, created_at, archived_at FROM workflow_runs
       WHERE artifact IS NOT NULL AND artifact != '' AND status = 'done' ${archivedClause}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit);

  for (const run of runs) {
    items.push({
      id: `run:${run["run_id"] as string}`,
      kind: "workflow",
      title: run["title"] as string,
      source_label: run["workflow_name"] as string,
      created_at: run["created_at"] as string,
      preview: null,
      status: "done",
      severity: null,
      archived_at: (run["archived_at"] as string | null) ?? null,
    });
  }

  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return items.slice(0, limit);
}

export function getArtifact(db: Db, compositeId: string): ArtifactDetail | null {
  const parsed = parseCompositeId(compositeId);
  if (!parsed) return null;

  if (parsed.kind === "alert") {
    const id = Number(parsed.nativeId);
    if (!Number.isInteger(id)) return null;
    const alert = getAlert(db, id);
    if (!alert || alert.source !== "artifact") return null;
    return {
      id: `alert:${alert.id}`,
      kind: "draft",
      title: alert.headline,
      source_label: DRAFT_SOURCE_LABEL,
      created_at: alert.created_at,
      preview: preview(alert.body) || null,
      status: alert.status,
      severity: alert.severity,
      archived_at: alert.archived_at,
      body: alert.body,
      rationale: alert.suggested_action || null,
    };
  }

  const row = db
    .query<Record<string, unknown>, [string]>("SELECT * FROM workflow_runs WHERE run_id = ?")
    .get(parsed.nativeId);
  if (!row || !row["artifact"]) return null;
  return {
    id: `run:${row["run_id"] as string}`,
    kind: "workflow",
    title: row["title"] as string,
    source_label: row["workflow_name"] as string,
    created_at: row["created_at"] as string,
    preview: null,
    status: "done",
    severity: null,
    archived_at: (row["archived_at"] as string | null) ?? null,
    body: row["artifact"] as string,
    rationale: null,
  };
}

export function setArtifactArchived(db: Db, compositeId: string, archived: boolean): boolean {
  const parsed = parseCompositeId(compositeId);
  if (!parsed) return false;

  if (parsed.kind === "alert") {
    const id = Number(parsed.nativeId);
    if (!Number.isInteger(id)) return false;
    const alert = getAlert(db, id);
    if (!alert || alert.source !== "artifact") return false;
    const result = db.run("UPDATE alerts SET archived_at = ? WHERE id = ?", [archived ? new Date().toISOString() : null, id]);
    return result.changes > 0;
  }

  const row = db.query<Record<string, unknown>, [string]>("SELECT run_id, artifact FROM workflow_runs WHERE run_id = ?").get(parsed.nativeId);
  if (!row || !row["artifact"]) return false;
  const result = db.run("UPDATE workflow_runs SET archived_at = ? WHERE run_id = ?", [
    archived ? new Date().toISOString() : null,
    parsed.nativeId,
  ]);
  return result.changes > 0;
}

export function deleteArtifact(db: Db, compositeId: string): boolean {
  const parsed = parseCompositeId(compositeId);
  if (!parsed) return false;

  if (parsed.kind === "alert") {
    const id = Number(parsed.nativeId);
    if (!Number.isInteger(id)) return false;
    const alert = getAlert(db, id);
    if (!alert || alert.source !== "artifact") return false;
    const result = db.run("DELETE FROM alerts WHERE id = ?", [id]);
    return result.changes > 0;
  }

  const row = db.query<Record<string, unknown>, [string]>("SELECT run_id, artifact FROM workflow_runs WHERE run_id = ?").get(parsed.nativeId);
  if (!row || !row["artifact"]) return false;
  const result = db.run("DELETE FROM workflow_runs WHERE run_id = ?", [parsed.nativeId]);
  return result.changes > 0;
}

export function isValidCompositeId(compositeId: string): boolean {
  return parseCompositeId(compositeId) !== null;
}
