/**
 * `oe_company` — the company's own resource.
 *
 * Profile, onboarding interview lifecycle, today's briefing/activity,
 * episodic memory (decisions/initiatives/advice), and the Executive chat.
 */

import * as v from "valibot";
import { backendEvents } from "../backend.ts";
import {
  type ActionSpec,
  defineDomainTool,
  identifier,
  jsonObject,
  optionalFlag,
  optionalText,
  text,
} from "./registry.ts";

const MEMORY_KINDS = ["decisions", "initiatives", "advice"] as const;

const memoryKind = v.pipe(
  v.picklist(MEMORY_KINDS),
  v.description(
    "Which episodic memory: `decisions`, `initiatives`, or `advice`.",
  ),
);

async function ask(input: Record<string, unknown>): Promise<unknown> {
  const body: Record<string, unknown> = { message: input.message };
  if (input.session_id !== undefined) body.session_id = input.session_id;
  if (input.committee_review !== undefined)
    body.committee_review = input.committee_review;

  let reply = "";
  const actionsTaken: unknown[] = [];
  let sessionId: unknown = input.session_id;
  let streamError: string | null = null;

  try {
    await backendEvents("/chat", body, (event) => {
      if (event.session_id) sessionId = event.session_id;
      if (event.type === "chunk") reply += String(event.content ?? "");
      else if (event.type === "action_taken") actionsTaken.push(event);
      else if (event.type === "error") {
        streamError = String(event.message ?? "unknown");
        return "keep-partial";
      }
    });
  } catch (err) {
    if (!reply && actionsTaken.length === 0) throw err;
    streamError = err instanceof Error ? err.message : String(err);
  }

  return {
    session_id: sessionId ?? null,
    reply,
    actions_taken: actionsTaken,
    ...(streamError
      ? {
          incomplete: true,
          stream_error: streamError,
          note: reply
            ? "The turn errored after the text above was streamed. That text is persisted server-side, so pass session_id to continue."
            : "The turn errored before any text was produced, so nothing was persisted. Retry, or start a new session.",
        }
      : {}),
  };
}

const actions: ActionSpec[] = [
  {
    name: "get_profile",
    description:
      "Read the saved company profile. A 404 means onboarding has not been committed yet — use `onboard_start`.",
    method: "GET",
    path: "/company-profile",
  },
  {
    name: "patch_profile",
    description:
      "Update the saved company profile — send only the keys that changed. Fails with 404 when no profile exists yet.",
    method: "PATCH",
    path: "/company-profile",
    fields: {
      profile: jsonObject(
        "Partial company profile (same shape as `get_profile`'s response). Only the keys you send are updated.",
      ),
    },
    bodyIs: "profile",
  },
  {
    name: "onboard_start",
    description:
      "Start a new onboarding interview. Returns `session_id` plus the first question, or a draft when description was sufficient.",
    fields: {
      description: optionalText(
        "Free-text company description (up to 20k chars). Empty returns the opening prompt instantly.",
      ),
    },
    // Durbar's /onboard/start takes no body and creates a session; description is ignored but accepted for compat
    method: "POST",
    path: "/onboard/start",
    bodyFrom: [],
  },
  {
    name: "onboard_message",
    description:
      "Answer the current onboarding question with free text. Returns the next question, or a draft once enough has been collected.",
    method: "POST",
    path: "/onboard/message",
    fields: {
      session_id: text("Interview session id from `onboard_start`."),
      message: text("Free-text answer to the current question."),
    },
    bodyFrom: ["session_id", "message"],
  },
  {
    name: "onboard_draft",
    description:
      "Force a profile draft now, however much is still unknown. Use to preview what would be saved before committing.",
    method: "POST",
    path: "/onboard/draft",
    fields: { session_id: text("Interview session id.") },
    bodyFrom: ["session_id"],
  },
  {
    name: "onboard_commit",
    description:
      "⚠️ destructive — saves the reviewed draft: creates the company profile, seeds people and departments. Requires a session in draft phase.",
    method: "POST",
    path: "/onboard/commit",
    fields: {
      session_id: text("Interview session id in draft phase."),
      profile: v.optional(
        v.pipe(
          v.record(v.string(), v.unknown()),
          v.description(
            "Company profile patch. All fields optional; merged onto a fresh profile.",
          ),
        ),
      ),
    },
    bodyFrom: ["session_id", "profile"],
  },
  {
    name: "get_onboarding_session",
    description:
      "Fetch an in-flight onboarding session: transcript, current question or draft, and whether it was already saved.",
    method: "GET",
    path: "/onboard/session/:session_id",
    fields: { session_id: text("Interview session id.") },
  },
  {
    name: "get_today",
    description:
      "Today's briefing: the Executive's narrative, proposals awaiting a decision, overnight activity, and at-risk items.",
    method: "GET",
    path: "/today",
  },
  {
    name: "get_activity",
    description:
      "The activity feed behind the briefing — recent events across agents, integrations and the scheduler.",
    method: "GET",
    path: "/today/activity",
  },
  {
    name: "get_last_turn",
    description:
      "Debug view of the most recent chat turn: the collected SSE events and turn metadata.",
    method: "GET",
    path: "/sessions",
    fields: {
      limit: v.optional(
        v.pipe(
          v.number(),
          v.description("How many sessions to list (default 10)."),
        ),
      ),
    },
    query: ["limit"],
  },
  {
    name: "list_memories",
    description:
      "List episodic memory entries of one kind — what the company has decided, is running, or was advised.",
    method: "GET",
    path: "/memories/:kind",
    fields: { kind: memoryKind },
  },
  {
    name: "update_decision",
    description:
      "Edit one recorded decision — correct its outcome, rationale, summary, domain or tags.",
    method: "PATCH",
    path: "/memories/decisions/:memory_id",
    fields: {
      memory_id: identifier("Decision id."),
      domain: optionalText("Domain the decision belongs to."),
      summary: optionalText("What was decided."),
      rationale: optionalText("Why the call was made."),
      outcome: optionalText("What happened as a result."),
      tags: optionalText("Comma-separated tags."),
    },
    bodyFrom: ["domain", "summary", "rationale", "outcome", "tags"],
  },
  {
    name: "update_initiative",
    description:
      "Edit one tracked initiative — retitle it, change its status, or rewrite the summary.",
    method: "PATCH",
    path: "/memories/initiatives/:memory_id",
    fields: {
      memory_id: identifier("Initiative id."),
      title: optionalText("The initiative title."),
      status: optionalText("Current status."),
      summary: optionalText("Summary of the initiative."),
    },
    bodyFrom: ["title", "status", "summary"],
  },
  {
    name: "update_advice",
    description:
      "Edit one recorded piece of advice — amend the question asked, the advice given, or its domain.",
    method: "PATCH",
    path: "/memories/advice/:memory_id",
    fields: {
      memory_id: identifier("Advice entry id."),
      domain: optionalText("Domain the advice belongs to."),
      query_summary: optionalText("The question that was asked."),
      advice_summary: optionalText("The advice that was given."),
    },
    bodyFrom: ["domain", "query_summary", "advice_summary"],
  },
  {
    name: "delete_memory",
    description:
      "⚠️ destructive — permanently delete one episodic memory entry.",
    method: "DELETE",
    path: "/memories/:kind/:memory_id",
    fields: {
      kind: memoryKind,
      memory_id: identifier("Memory entry id."),
    },
  },
  {
    name: "ask",
    description:
      "Ask the Executive a question and get its full reply. This is a real chat turn: it routes to specialists, retrieves knowledge, records episodic memory, and is billed against the provider. Pass `session_id` to continue a conversation.",
    fields: {
      message: text("The question or instruction for the Executive."),
      session_id: optionalText(
        "Continue an existing chat session; omit to start a new one.",
      ),
      committee_review: optionalFlag(
        "Run the committee review pass before answering. Slower, more thorough.",
      ),
    },
    custom: ask,
  },
];

export function registerCompanyTools(
  server: Parameters<typeof defineDomainTool>[0],
): void {
  defineDomainTool(server, {
    name: "oe_company",
    description:
      "The company's own resource: profile, onboarding interview lifecycle, today's briefing and activity, episodic memory (decisions/initiatives/advice), and the Executive chat. Start here if you do not know the company yet.",
    actions,
  });
}
