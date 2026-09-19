/**
 * `oe_departments` — departments, their charters, and their goals.
 *
 * A department is the unit of delegation: its `authority_level` decides whether
 * work under it runs automatically, is proposed, or escalates, and its
 * `watched_entities` drive the monitoring pipeline. Goals are the OKR rows
 * rendered on the department page.
 */
import * as v from "valibot";
import {
  type ActionSpec,
  defineDomainTool,
  identifier,
  nullableIdentifier,
  nullableText,
  optionalJsonObject,
  optionalList,
  optionalNumber,
  optionalText,
  text,
} from "./registry.js";

const AUTHORITY_LEVELS = "One of: auto_execute | propose_only | escalate.";
const GOAL_STATUSES = "One of: on_track | at_risk | off_track.";
const PERIOD_TYPES = "One of: week | month | quarter | year | ongoing.";

const charter = v.pipe(
  v.object({
    // `mission` is required by DepartmentCharter, and a charter replaces the
    // stored one wholesale — omitting it is a 422, not a no-op.
    mission: text("What the department is for."),
    scope: v.optional(
      v.pipe(v.array(v.string()), v.description("What it owns.")),
    ),
    out_of_scope: v.optional(
      v.pipe(
        v.array(v.string()),
        v.description("What it explicitly does not own."),
      ),
    ),
  }),
  v.description(
    "Department charter: mission + scope + out_of_scope. Replaces the stored charter.",
  ),
);

const GOAL_CREATE_FIELDS = [
  "period_type",
  "period_value",
  "key_result",
  "target",
  "current",
  "status",
];

const actions: ActionSpec[] = [
  {
    name: "list",
    description:
      "List every department with its config, goals, headcount and budget.",
    method: "GET",
    path: "/departments",
  },
  {
    name: "get",
    description:
      "Read one department by slug: charter, authority level, cadences, goals, members.",
    method: "GET",
    path: "/departments/:slug",
    fields: { slug: text("Department slug, e.g. 'finance'.") },
  },
  {
    name: "create",
    description:
      "Create a department. Only `title` is required; add the charter and authority level afterwards with `update`.",
    method: "POST",
    path: "/departments",
    fields: {
      title: text(
        "Department title, e.g. 'Finance' (1–128 chars, must be unique).",
      ),
      mission: optionalText("One-line mission (up to 1024 chars)."),
    },
    bodyFrom: ["title", "mission"],
  },
  {
    name: "update",
    description:
      "Update a department — send only what changed. `head_person_id` must reference an existing person (see `oe_people`). Only `head_person_id` and the channel ids are cleared by passing `null`; the rest are replaced by sending a new value.",
    method: "PATCH",
    path: "/departments/:slug",
    fields: {
      slug: text("Department slug."),
      title: optionalText("New title."),
      // Optional: `charter` replaces the stored one wholesale, so a call that
      // is only changing the budget must not be forced to resend it.
      charter: v.optional(charter),
      authority_level: optionalText(
        `How much this department may do unattended. ${AUTHORITY_LEVELS}`,
      ),
      // Only `head_person_id` and the three channel ids are cleared by sending
      // an explicit null: `departments/store.py` treats None as "omit" for
      // every other field, so a nullable type there would promise a capability
      // the backend does not have (and the call would report 200 unchanged).
      head_person_id: nullableIdentifier(
        "Person id of the department head. Pass null to clear it.",
      ),
      head_persona_slug: optionalText(
        "Persona slug used for the department's voice.",
      ),
      cadences: optionalJsonObject(
        'Cadence overrides, e.g. {"weekly_review": "mon 09:00"}. Replaces the stored set.',
      ),
      headcount: optionalNumber("Planned headcount."),
      budget_usd: optionalNumber("Annual budget in USD."),
      slack_channel_id: nullableText(
        "Slack channel id for this department. Pass null to clear it.",
      ),
      discord_channel_id: nullableText(
        "Discord channel id. Pass null to clear it.",
      ),
      telegram_chat_id: nullableText(
        "Telegram chat id. Pass null to clear it.",
      ),
      watched_entities: optionalList(
        "Entities the monitoring pipeline watches for this department (max 50). Replaces the stored list.",
      ),
    },
    // Explicit list: the body must contain exactly these fields, never the
    // path param, so a PATCH that changes one field cannot leak `slug` into a
    // model that ignores or rejects unknown keys.
    bodyFrom: [
      "title",
      "charter",
      "authority_level",
      "head_person_id",
      "head_persona_slug",
      "cadences",
      "headcount",
      "budget_usd",
      "slack_channel_id",
      "discord_channel_id",
      "telegram_chat_id",
      "watched_entities",
    ],
  },
  {
    name: "delete",
    description:
      "⚠️ destructive — permanently delete a department and its goals. Prefer clearing the head and disabling its cadences if you only want to deactivate it.",
    method: "DELETE",
    path: "/departments/:slug",
    fields: { slug: text("Department slug.") },
  },
  {
    name: "add_goal",
    description:
      "Add a goal (OKR row) to a department. `period_value`, `key_result` and `target` are required — e.g. period_value '2026-Q3', key_result 'Close the Series A', target '$12M raised'.",
    method: "POST",
    path: "/departments/:slug/goals",
    fields: {
      slug: text("Department slug."),
      period_type: optionalText(`Defaults to 'quarter'. ${PERIOD_TYPES}`),
      period_value: text("The period this goal belongs to, e.g. '2026-Q3'."),
      key_result: text("The measurable outcome."),
      target: text("The target value or statement."),
      current: optionalText("Current progress against the target."),
      status: optionalText(`Defaults to 'on_track'. ${GOAL_STATUSES}`),
    },
    bodyFrom: GOAL_CREATE_FIELDS,
  },
  {
    name: "update_goal",
    description:
      "Update a goal — typically `current` and `status` as progress is reported.",
    method: "PATCH",
    path: "/departments/:slug/goals/:goal_id",
    fields: {
      slug: text("Department slug."),
      goal_id: identifier("Goal id."),
      period_type: optionalText(PERIOD_TYPES),
      period_value: optionalText("The period this goal belongs to."),
      key_result: optionalText("The measurable outcome."),
      target: optionalText("The target value or statement."),
      current: optionalText("Current progress against the target."),
      status: optionalText(GOAL_STATUSES),
    },
    bodyFrom: GOAL_CREATE_FIELDS,
  },
  {
    name: "delete_goal",
    description:
      "⚠️ destructive — permanently delete one goal from a department.",
    method: "DELETE",
    path: "/departments/:slug/goals/:goal_id",
    fields: {
      slug: text("Department slug."),
      goal_id: identifier("Goal id."),
    },
  },
];

export function registerDepartmentTools(
  server: Parameters<typeof defineDomainTool>[0],
) {
  defineDomainTool(server, {
    name: "oe_departments",
    description:
      "Departments: charters, authority levels, cadences, budget, watched entities, and their goals. The unit of delegation — its authority level decides what runs unattended.",
    actions,
  });
}
