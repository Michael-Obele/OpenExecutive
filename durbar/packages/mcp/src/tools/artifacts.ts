/**
 * `oe_artifacts` — durable outputs the system produced.
 */

import { type ActionSpec, defineDomainTool, optionalFlag, optionalNumber, text } from "./registry.ts";

const COMPOSITE_ID = "Artifact id in the form `alert:<int>` or `run:<hex>` (as returned by `list`).";

const actions: ActionSpec[] = [
  {
    name: "list",
    description: "List stored artifacts, newest first. Archived artifacts are excluded unless `archived` is true — so this is also how you ask 'what did we archive?'.",
    method: "GET",
    path: "/artifacts",
    fields: { limit: optionalNumber("Maximum artifacts to return (default 200)."), archived: optionalFlag("List archived artifacts instead of live ones. Default false.") },
    query: ["limit", "archived"],
  },
  {
    name: "get",
    description: "Read one artifact in full — body plus the rationale recorded at the time it was produced. Use this before quoting an artifact to a user.",
    method: "GET",
    path: "/artifacts/:composite_id",
    fields: { composite_id: text(COMPOSITE_ID) },
  },
  {
    name: "archive",
    description: "Archive an artifact: hides it from the default list while keeping it recoverable with `restore`.",
    method: "POST",
    path: "/artifacts/:composite_id/archive",
    fields: { composite_id: text(COMPOSITE_ID) },
  },
  {
    name: "restore",
    description: "Restore a previously archived artifact to the live list.",
    method: "POST",
    path: "/artifacts/:composite_id/restore",
    fields: { composite_id: text(COMPOSITE_ID) },
  },
  {
    name: "delete",
    description: "⚠️ destructive — permanently delete an artifact. Not recoverable; prefer `archive` unless the content must actually be erased.",
    method: "DELETE",
    path: "/artifacts/:composite_id",
    fields: { composite_id: text(COMPOSITE_ID) },
  },
];

export function registerArtifactTools(server: Parameters<typeof defineDomainTool>[0]): void {
  defineDomainTool(server, { name: "oe_artifacts", description: "Stored outputs: alert reply drafts and workflow-run artifacts, with the rationale recorded when they were produced. Archive to hide, delete to erase.", actions });
}
