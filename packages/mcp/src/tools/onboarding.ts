/**
 * Onboarding tools for the Open Executive TMCP server.
 *
 * Goal: make `/onboard` AI-editable for any input — another AI agent can
 * describe the company in free text, answer follow-ups, review the draft,
 * and commit, all without touching the browser.
 *
 * The interview backend already handles any input: free-text description,
 * optional file attachments, and a bounded transcript. These tools are thin
 * wrappers that let an MCP client drive that lifecycle, plus direct reads
 * and patches of the already-saved profile.
 *
 * Every read is annotated readOnlyHint; every write is annotated
 * destructiveHint/openWorldHint and returns the full resulting state so the
 * agent can verify what changed.
 */
import type { McpServer } from "tmcp";
import * as v from "valibot";
import { backend, errorResult, textResult } from "../backend.js";

// The server is constructed with ValibotJsonSchemaAdapter, so its StandardSchema
// generic is the Valibot schema type. Using `any` here avoids threading the
// adapter type through every tool file while still getting runtime validation.
export function registerOnboardingTools(server: McpServer<any>) {
  // ── reads ──────────────────────────────────────────────────────────

  server.tool(
    {
      name: "get_company_profile",
      description:
        "Read the current company profile. Returns the full profile JSON. " +
        "Fails with 404 when onboarding has not been completed yet — the agent should then use onboard_start.",
      title: "Get company profile",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const profile = await backend<unknown>("/company-profile");
        return textResult(profile);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    {
      name: "get_onboarding_session",
      description:
        "Fetch an in-flight onboarding session by id: transcript, current question or draft, and whether it was already saved. " +
        "Useful to resume after a page refresh or to inspect what the interview has produced so far.",
      title: "Get onboarding session",
      schema: v.object({
        session_id: v.pipe(
          v.string(),
          v.description(
            "Interview session id from onboard_start / onboard_message.",
          ),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ session_id }) => {
      try {
        const session = await backend<unknown>(
          `/onboard/interview/${encodeURIComponent(session_id)}`,
        );
        return textResult(session);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── interview lifecycle ────────────────────────────────────────────

  server.tool(
    {
      name: "onboard_start",
      description:
        "Start a new onboarding interview. " +
        "Pass any free-text description of the company (one line or a full one-pager) — the interviewer will ask follow-ups until it has enough to draft a profile. " +
        "Pass an empty string to get the opening question without a model call. " +
        "Returns session_id + the first question or an immediate draft when the description was already sufficient.",
      title: "Start onboarding interview",
      schema: v.object({
        description: v.pipe(
          v.string(),
          v.description(
            "Free-text company description. Any length up to 20k chars; empty string returns the opening prompt instantly.",
          ),
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ description }) => {
      try {
        // The backend's /onboard/interview/start is multipart/form-data (Form + File).
        // Send it as FormData so we hit the same code path the UI does.
        const form = new FormData();
        form.set("description", description);
        const BACKEND_BASE_URL =
          process.env.BACKEND_BASE_URL ?? "http://localhost:8000";
        const BACKEND_SHARED_SECRET = process.env.BACKEND_SHARED_SECRET ?? "";
        const headers: Record<string, string> = {};
        if (BACKEND_SHARED_SECRET) headers["x-api-key"] = BACKEND_SHARED_SECRET;
        const res = await fetch(`${BACKEND_BASE_URL}/onboard/interview/start`, {
          method: "POST",
          headers,
          body: form,
        });
        if (!res.ok) {
          let detail = res.statusText;
          try {
            const data = (await res.json()) as { detail?: string };
            if (data?.detail) detail = data.detail;
          } catch {
            // non-JSON
          }
          throw new Error(
            `Backend POST /onboard/interview/start failed (${res.status}): ${detail}`,
          );
        }
        const turn = await res.json();
        return textResult(turn);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    {
      name: "onboard_message",
      description:
        "Answer the current onboarding question. " +
        "Any free text is accepted — the interviewer handles clarification, validation, and follow-ups. " +
        "Returns the next question or a draft when enough has been collected.",
      title: "Answer onboarding question",
      schema: v.object({
        session_id: v.pipe(v.string(), v.description("Interview session id.")),
        message: v.pipe(
          v.string(),
          v.description("Free-text answer to the current question."),
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ session_id, message }) => {
      try {
        const turn = await backend<unknown>("/onboard/interview/message", {
          method: "POST",
          body: { session_id, message },
        });
        return textResult(turn);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    {
      name: "onboard_draft",
      description:
        "Force a draft now, however much is still unknown. " +
        "Use when the transcript is long or the agent wants to review what would be saved.",
      title: "Force onboarding draft",
      schema: v.object({
        session_id: v.pipe(v.string(), v.description("Interview session id.")),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ session_id }) => {
      try {
        const turn = await backend<unknown>("/onboard/interview/draft", {
          method: "POST",
          body: { session_id },
        });
        return textResult(turn);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    {
      name: "onboard_commit",
      description:
        "Save the reviewed draft. This is the single write in the onboarding flow — it creates the company profile, seeds people and departments, and fires post-onboarding research. " +
        "The draft must have been produced by the interview (phase=draft); the agent may edit profile/people/departments before committing. " +
        "Fails with 422 when the draft is inconsistent (e.g. no principal, duplicate names) — fix and retry, the session is left untouched.",
      title: "Commit onboarding draft",
      schema: v.object({
        session_id: v.pipe(
          v.string(),
          v.description("Interview session id in draft phase."),
        ),
        profile: v.pipe(
          v.record(v.string(), v.unknown()),
          v.description(
            "Company profile patch — same shape as PATCH /company-profile. All fields optional; merged onto a fresh profile.",
          ),
        ),
        people: v.optional(
          v.array(
            v.object({
              full_name: v.string(),
              role: v.optional(v.string()),
              is_principal: v.optional(v.boolean()),
            }),
          ),
          [],
        ),
        departments: v.optional(
          v.array(
            v.object({
              title: v.string(),
              mission: v.optional(v.string()),
              head_person_name: v.optional(v.string()),
              authority_level: v.optional(v.string()),
            }),
          ),
          [],
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ session_id, profile, people, departments }) => {
      try {
        const saved = await backend<unknown>("/onboard/interview/commit", {
          method: "POST",
          body: { session_id, profile, people, departments },
        });
        return textResult(saved);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── direct profile patch (post-onboarding updates) ─────────────────

  server.tool(
    {
      name: "patch_company_profile",
      description:
        "Patch the already-saved company profile. " +
        "Any subset of fields may be sent; unspecified fields are left as-is. " +
        "Use after onboarding to keep the profile current as things change. " +
        "Fails with 404 when no profile exists yet — run the onboarding flow first.",
      title: "Patch company profile",
      schema: v.object({
        profile: v.pipe(
          v.record(v.string(), v.unknown()),
          v.description(
            "Partial company profile — same shape as PATCH /company-profile. Only sent fields are updated.",
          ),
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ profile }) => {
      try {
        const updated = await backend<unknown>("/company-profile", {
          method: "PATCH",
          body: profile,
        });
        return textResult(updated);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
