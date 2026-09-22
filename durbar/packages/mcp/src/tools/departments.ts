/**
 * `oe_departments` — departments, their charters, and their goals.
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
} from "./registry.ts";

const AUTHORITY_LEVELS = "One of: auto_execute | propose_only | escalate.";
const GOAL_STATUSES = "One of: on_track | at_risk | off_track.";
const PERIOD_TYPES = "One of: week | month | quarter | year | ongoing.";

const charter = v.pipe(
  v.object({
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
      "Update a department — send only what changed. `head_person_id` must reference an existing person. Only `head_person_id` and the channel ids are cleared by passing `null`.",
    method: "PATCH",
    path: "/departments/:slug",
    fields: {
      slug: text("Department slug."),
      title: optionalText("New title."),
      charter: v.optional(charter),
      authority_level: optionalText(
        `How much this department may do unattended. ${AUTHORITY_LEVELS}`,
      ),
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
      "Add a goal (OKR row) to a department. `period_value`, `key_result` and `target` are required.",
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
    fields: { slug: text("Department slug."), goal_id: identifier("Goal id.") },
  },
];

export function registerDepartmentTools(
  server: Parameters<typeof defineDomainTool>[0],
): void {
  defineDomainTool(server, {
    name: "oe_departments",
    description:
      "Departments: charters, authority levels, cadences, budget, watched entities, and their goals. The unit of delegation — its authority level decides what runs unattended.",
    actions,
  });
}
