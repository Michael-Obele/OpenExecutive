/**
 * `oe_company` — the company's own resource.
 *
 * Profile, the onboarding interview lifecycle, today's briefing/activity,
 * episodic memory (decisions / initiatives / advice), and the Executive chat
 * itself. Reads are read-only; `patch_profile`, `onboard_commit`,
 * `update_memory` and `delete_memory` mutate durable state.
 */
import * as v from "valibot";
import { backendEvents, backendForm } from "../backend.js";
import {
  type ActionSpec,
  defineDomainTool,
  identifier,
  jsonObject,
  optionalFlag,
  optionalText,
  text,
} from "./registry.js";

const MEMORY_KINDS = ["decisions", "initiatives", "advice"] as const;

const memoryKind = v.pipe(
  v.picklist(MEMORY_KINDS),
  v.description(
    "Which episodic memory: `decisions`, `initiatives`, or `advice`.",
  ),
);

/**
 * `POST /onboard/interview/start` is multipart/form-data (Form + File), so it
 * cannot go through the JSON path — send the same FormData the UI sends.
 */
async function onboardStart(input: Record<string, unknown>): Promise<unknown> {
  const form = new FormData();
  form.set("description", String(input.description ?? ""));
  return backendForm("/onboard/interview/start", form);
}

/**
 * `POST /chat` streams SSE; MCP results are text, so the stream is consumed to
 * completion and returned as one object. `thinking` frames are dropped (they
 * carry no content) but `action_taken` frames are kept — they are how the
 * agent knows a specialist was consulted or a tool ran on its behalf.
 */
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
        // The backend emits this *after* it has written the partial turn
        // (a timeout, say) and keeps the session. Throwing here would discard
        // the text already assembled as well as the session_id needed to
        // resume, so keep the partial and flag it.
        streamError = String(event.message ?? "unknown");
        return "keep-partial";
      }
    });
  } catch (err) {
    // Same reasoning for a stream-level failure (reset, deadline, byte cap):
    // a reply that was already assembled is still useful, and the caller needs
    // the session id to continue. Nothing collected means nothing to keep.
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
          // Only claim the turn was persisted when there is text to persist —
          // the backend skips persistence entirely for a turn that produced
          // no content.
          note: reply
            ? "The turn errored after the text above was streamed. That text is persisted server-side, so pass session_id to continue the conversation."
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
    // The route takes the profile object as the body itself — wrapping it
    // (`bodyFrom: ["profile"]`) is silently ignored by Pydantic, which answers
    // 200 with nothing changed.
    bodyIs: "profile",
  },
  {
    name: "onboard_start",
    description:
      "Start a new onboarding interview. Pass any free-text description of the company; an empty string returns the opening question without a model call. Returns `session_id` plus the first question, or a draft when the description was already sufficient.",
    fields: {
      description: text(
        "Free-text company description — one line or a full one-pager (up to 20k chars). Empty string returns the opening prompt instantly.",
      ),
    },
    custom: onboardStart,
  },
  {
    name: "onboard_message",
    description:
      "Answer the current onboarding question with free text. Returns the next question, or a draft once enough has been collected.",
    method: "POST",
    path: "/onboard/interview/message",
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
    path: "/onboard/interview/draft",
    fields: {
      session_id: text("Interview session id."),
    },
    bodyFrom: ["session_id"],
  },
  {
    name: "onboard_commit",
    description:
      "⚠️ destructive — saves the reviewed draft: creates the company profile, seeds people and departments, and fires post-onboarding research. Requires a session in draft phase. Fails with 422 when the draft is inconsistent (e.g. no principal, duplicate names); the session is left untouched so you can fix and retry.",
    method: "POST",
    path: "/onboard/interview/commit",
    fields: {
      session_id: text("Interview session id in draft phase."),
      profile: jsonObject(
        "Company profile patch — same shape as `PATCH /company-profile`. All fields optional; merged onto a fresh profile.",
      ),
      people: v.optional(
        v.pipe(
          v.array(
            v.object({
              full_name: text("Person's full name."),
              role: optionalText("Job title."),
              is_principal: optionalFlag("True for the company principal."),
            }),
          ),
          v.description("People to seed. Defaults to the draft's people."),
        ),
      ),
      departments: v.optional(
        v.pipe(
          v.array(
            v.object({
              title: text("Department title."),
              mission: optionalText("One-line mission."),
              head_person_name: optionalText(
                "Name of the department head (must match a person).",
              ),
              authority_level: optionalText(
                "One of: auto_execute | propose_only | escalate.",
              ),
            }),
          ),
          v.description(
            "Departments to seed. Defaults to the draft's departments.",
          ),
        ),
      ),
    },
    bodyFrom: ["session_id", "profile", "people", "departments"],
  },
  {
    name: "get_onboarding_session",
    description:
      "Fetch an in-flight onboarding session: transcript, current question or draft, and whether it was already saved. Use to resume after a refresh.",
    method: "GET",
    path: "/onboard/interview/:session_id",
    fields: {
      session_id: text("Interview session id."),
    },
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
      "Debug view of the most recent chat turn: the collected SSE events and turn metadata (chunks, duration, timeout/disconnect flags).",
    method: "GET",
    path: "/debug/last-turn",
  },
  {
    name: "list_memories",
    description:
      "List episodic memory entries of one kind — what the company has decided, is running, or was advised.",
    method: "GET",
    path: "/memories/:kind",
    fields: { kind: memoryKind },
  },
  // One action per memory kind rather than a single `update_memory` with a
  // `kind` discriminator: the three backend models share no fields, so a
  // combined row would offer the model — and silently drop — four keys that do
  // nothing for the kind it passed (Pydantic ignores extras there, so there is
  // no 422 to catch it either).
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
      "Ask the Executive a question and get its full reply. This is a real chat turn: it routes to specialists, retrieves knowledge, records episodic memory, and is billed against the Anthropic API. Pass `session_id` from a previous call to continue the same conversation. If the turn errors part-way the result is still returned, flagged `incomplete`.",
    fields: {
      message: text("The question or instruction for the Executive."),
      session_id: optionalText(
        "Continue an existing chat session; omit to start a new one.",
      ),
      committee_review: optionalFlag(
        "Run the committee review pass (multi-specialist critique) before answering. Slower, more thorough.",
      ),
    },
    custom: ask,
  },
];

export function registerCompanyTools(
  server: Parameters<typeof defineDomainTool>[0],
) {
  defineDomainTool(server, {
    name: "oe_company",
    description:
      "The company's own resource: profile, onboarding interview lifecycle, today's briefing and activity, episodic memory (decisions/initiatives/advice), and the Executive chat. Start here if you do not know the company yet.",
    actions,
  });
}
