/**
 * `oe_operations` — running the machine: the human-review queue, the audit
 * trail, and the workflow catalog.
 */

import * as v from "valibot";
import { backend, backendEvents } from "../backend.ts";
import { type ActionSpec, defineDomainTool, identifier, optionalFlag, optionalNumber, optionalText, text } from "./registry.ts";

const REVIEW_STATUSES = "One of: pending | approved | rejected | needs_revision.";
const AUDIT_WINDOW = "ISO8601 timestamp. `since` is an inclusive lower bound, `until` an inclusive upper bound.";

async function runWorkflow(input: Record<string, unknown>): Promise<unknown> {
  const name = String(input.name ?? "");
  if (!name) throw new Error("run_workflow: 'name' is required");
  if (name === "." || name === "..") throw new Error("run_workflow: 'name' must not be a dot segment");

  const inputs = (input.inputs ?? {}) as Record<string, unknown>;
  let runId: string | null = null;
  let title: string | null = null;
  let pausedOn: unknown = null;
  let streamError: string | null = null;
  const eventTypes: string[] = [];

  try {
    await backendEvents(`/workflows/${encodeURIComponent(name)}/runs`, inputs, (event) => {
      const type = String(event.type ?? "");
      eventTypes.push(type);
      if (type === "run_created") {
        runId = String(event.run_id ?? "");
        title = event.title === undefined ? null : String(event.title);
      } else if (type === "awaiting_human") {
        pausedOn = event;
      } else if (type === "error") {
        streamError = String(event.message ?? "unknown");
        return "keep-partial";
      }
    });
  } catch (err) {
    streamError = err instanceof Error ? err.message : String(err);
  }

  const started = runId;
  if (!started) {
    return {
      workflow: name,
      status: "unknown",
      note: "The run stream ended without a `run_created` frame, so no run id was issued. Check the backend log.",
      stream_error: streamError,
      stream_event_types: eventTypes,
    };
  }

  return {
    workflow: name,
    title,
    run_id: started,
    paused_on_human_gate: pausedOn,
    stream_error: streamError,
    stream_event_types: eventTypes,
    run: await backend<Record<string, unknown>>(`/workflows/runs/${encodeURIComponent(started)}`),
  };
}

const actions: ActionSpec[] = [
  {
    name: "list_review",
    description: "List items awaiting human review — the drafts and decisions the system would not action on its own. Filter by status to see what is still pending.",
    method: "GET",
    path: "/review/items",
    fields: {
      status: optionalText(`Filter by review status. ${REVIEW_STATUSES}`),
      domain: optionalText("Filter by domain, e.g. 'finance'."),
      content_type: optionalText("Filter by content type, e.g. 'draft'."),
      limit: optionalNumber("Maximum items to return (default 100, max 500)."),
      offset: optionalNumber("Pagination offset."),
    },
    query: ["status", "domain", "content_type", "limit", "offset"],
  },
  {
    name: "get_review",
    description: "Read one review item with its annotations — the corrections previously recorded against it.",
    method: "GET",
    path: "/review/items/:item_id",
    fields: { item_id: text("Review item id.") },
  },
  {
    name: "update_review",
    description: "Record a review decision on one item: set its status, amend the reviewer notes, or reprioritise it. `reviewed_at` is only stamped when the status changes.",
    method: "PATCH",
    path: "/review/items/:item_id",
    fields: {
      item_id: text("Review item id."),
      status: optionalText(`New status. ${REVIEW_STATUSES}`),
      reviewer_notes: optionalText("Your notes explaining the decision."),
      priority: optionalText("New priority."),
    },
    bodyFrom: ["status", "reviewer_notes", "priority"],
  },
  {
    name: "bulk_approve",
    description: "⚠️ destructive — approve every pending item in a domain at once (or every domain when `domain` is omitted). This is irreversible in bulk, so echo back how many were approved.",
    method: "POST",
    path: "/review/bulk-approve",
    fields: { domain: optionalText("Only approve items in this domain. Omit to approve across all domains.") },
    bodyFrom: ["domain"],
  },
  { name: "review_stats", description: "Counts by review status — the quickest read on how much is waiting for a human.", method: "GET", path: "/review/stats" },
  {
    name: "list_annotations",
    description: "List correction annotations — the durable 'what we got wrong and what it should have been' record that feeds future prompts.",
    method: "GET",
    path: "/review/annotations",
    fields: { active_only: optionalFlag("Only currently-active annotations. Default true.") },
    query: ["active_only"],
  },
  {
    name: "add_annotation",
    description: "Record a correction against a review item. This is how a reviewer's judgement becomes training signal for later turns.",
    method: "POST",
    path: "/review/items/:item_id/annotations",
    fields: { item_id: text("Review item id."), correction: text("What was wrong and what it should have been (required, non-empty).") },
    bodyFrom: ["correction"],
  },
  {
    name: "update_annotation",
    description: "Amend an annotation's text, or deactivate it (kept for history rather than deleted).",
    method: "PATCH",
    path: "/review/annotations/:annotation_id",
    fields: {
      annotation_id: text("Annotation id."),
      correction: optionalText("Replacement correction text."),
      is_active: optionalFlag("False deactivates the annotation without deleting it."),
    },
    bodyFrom: ["correction", "is_active"],
  },
  {
    name: "delete_annotation",
    description: "⚠️ destructive — permanently delete an annotation. Prefer `update_annotation` with `is_active: false` to keep the history.",
    method: "DELETE",
    path: "/review/annotations/:annotation_id",
    fields: { annotation_id: text("Annotation id.") },
  },
  {
    name: "list_audit",
    description: "Query the audit log. Every agent turn, tool call, integration message and scheduled run lands here, so this is the ground truth for 'what actually happened'. Filter by event type, actor, session, free text, or a time window.",
    method: "GET",
    path: "/audit/logs",
    fields: {
      event_type: optionalText("Exact event type, e.g. 'chat_turn' or 'peer_memory'."),
      session_id: optionalText("Only events from one session."),
      actor: optionalText("Only events from one actor."),
      q: optionalText("Substring search over the event summary."),
      since: optionalText(`Inclusive lower time bound. ${AUDIT_WINDOW}`),
      until: optionalText(`Inclusive upper time bound. ${AUDIT_WINDOW}`),
      limit: optionalNumber("Maximum events to return (1–1000, default 100)."),
      offset: optionalNumber("Pagination offset."),
    },
    query: ["event_type", "session_id", "actor", "q", "since", "until", "limit", "offset"],
  },
  {
    name: "get_audit",
    description: "Read one audit event with its full `details_json` payload.",
    method: "GET",
    path: "/audit/logs/:event_id",
    fields: { event_id: identifier("Audit event id.") },
  },
  {
    name: "audit_session",
    description: "The full timeline, derived graph, cost summary and degradations for one session. Use this to reconstruct precisely how a single agent session went.",
    method: "GET",
    path: "/audit/sessions/:session_id",
    fields: { session_id: text("Session id (matched exactly against the indexed column).") },
  },
  {
    name: "audit_usage",
    description: "Aggregate token usage and cost across all sessions, with per-day and per-model breakdowns. This is the spend report — use it before claiming what something cost.",
    method: "GET",
    path: "/audit/usage",
    fields: { since: optionalText(`Inclusive lower time bound. ${AUDIT_WINDOW}`), until: optionalText(`Inclusive upper time bound. ${AUDIT_WINDOW}`) },
    query: ["since", "until"],
  },
  { name: "list_workflows", description: "The workflow catalog: every runnable workflow with its metadata and the steps it will take.", method: "GET", path: "/workflows" },
  {
    name: "get_workflow",
    description: "Read one workflow's metadata and **input schema**. Call this before `run_workflow` — it tells you exactly which keys `inputs` must contain.",
    method: "GET",
    path: "/workflows/:name",
    fields: { name: text("Workflow name, e.g. 'annual_plan'.") },
  },
  {
    name: "get_workflow_sample",
    description: "Realistic sample inputs for a workflow, for trying a run without composing inputs yourself.",
    method: "GET",
    path: "/workflows/:name/sample",
    fields: { name: text("Workflow name.") },
  },
  {
    name: "run_workflow",
    description:
      "Run a workflow and wait for it to finish. Long-running and billed against the provider — call `get_workflow` first to get the required `inputs`. Returns the full run record; if the run stops at an approval gate the result reports `paused_on_human_gate` and the run waits for a human to resolve it.",
    fields: {
      name: text("Workflow name from `list_workflows`."),
      inputs: v.pipe(v.optional(v.record(v.string(), v.unknown()), {}), v.description("Workflow inputs, matching the schema from `get_workflow`. Defaults to an empty object.")),
    },
    custom: runWorkflow,
  },
  {
    name: "list_runs",
    description: "Recent workflow runs across every workflow, newest first, optionally filtered to one workflow.",
    method: "GET",
    path: "/workflows/runs",
    fields: { workflow: optionalText("Only runs of this workflow."), limit: optionalNumber("Maximum runs to return (default 100).") },
    query: ["workflow", "limit"],
  },
  {
    name: "get_run",
    description: "Read one run in full, including its artifact when complete.",
    method: "GET",
    path: "/workflows/runs/:run_id",
    fields: { run_id: text("Run id from `run_workflow` or `list_runs`.") },
  },
  {
    name: "delete_run",
    description: "⚠️ destructive — permanently delete a workflow run record and its artifact.",
    method: "DELETE",
    path: "/workflows/runs/:run_id",
    fields: { run_id: text("Run id.") },
  },
];

export function registerOperationsTools(server: Parameters<typeof defineDomainTool>[0]): void {
  defineDomainTool(server, {
    name: "oe_operations",
    description:
      "Running the machine: the human-review queue (items, decisions, correction annotations), the audit trail (events, session timelines, token/cost usage), and the workflow catalog (run, poll, list runs).",
    actions,
  });
}
