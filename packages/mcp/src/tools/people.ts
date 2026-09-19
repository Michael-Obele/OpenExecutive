/**
 * `oe_people` — the company roster.
 *
 * People are the routing layer of the whole system: authority scope decides who
 * can approve what, `preferred_channel` decides where a question is delivered,
 * and `response_sla_hours` decides when it escalates. Read before writing —
 * `list` then `update` keeps the roster coherent.
 */
import * as v from "valibot";
import {
  type ActionSpec,
  defineDomainTool,
  identifier,
  optionalFlag,
  optionalIdentifier,
  optionalList,
  optionalNumber,
  optionalText,
  text,
} from "./registry.js";

const AUTHORITY_SCOPES =
  "Authority scopes: spend_lt_2k | spend_lt_10k | spend_gt_10k | hiring_signoff | vendor_onboarding | customer_credit | legal_sign | board_comms | meeting_scheduling | wildcard.";

const PREFERRED_CHANNELS = "One of: email | slack | telegram | discord | any.";

const availabilityWindow = v.object({
  weekdays: v.pipe(
    v.array(v.number()),
    v.description("Weekdays this window covers, 0=Mon … 6=Sun."),
  ),
  start_local: text("Local start time, HH:MM (24h)."),
  end_local: text("Local end time, HH:MM (24h)."),
  timezone: optionalText("IANA timezone, e.g. Europe/London. Defaults to UTC."),
});

/** Shared by create and update — the backend models differ only in what is required. */
const personFields = {
  full_name: text("Person's full name."),
  role: optionalText("Job title, e.g. 'CFO'."),
  email: optionalText("Email address — used when preferred_channel is email."),
  slack_user_id: optionalText("Slack user id, e.g. U0123ABCD."),
  telegram_chat_id: optionalText("Telegram chat id."),
  discord_user_id: optionalText("Discord user id."),
  preferred_channel: optionalText(
    `Where the Executive should reach this person. ${PREFERRED_CHANNELS}`,
  ),
  response_sla_hours: optionalNumber(
    "Hours to wait for a reply before escalating (1–8760, default 24).",
  ),
  on_leave_until: optionalText(
    "Leave end date, ISO `YYYY-MM-DD`. While set, the person is treated as away.",
  ),
  reports_to_person_id: optionalIdentifier("Id of the person they report to."),
  department_slugs: optionalList("Department slugs this person belongs to."),
  authority_scope: optionalList(AUTHORITY_SCOPES),
  availability: v.optional(
    v.pipe(
      v.array(availabilityWindow),
      v.description(
        "Working-hours windows used when scheduling a question for this person.",
      ),
    ),
  ),
};

const PEOPLE_CREATE_FIELDS = [
  "full_name",
  "role",
  "is_principal",
  "department_slugs",
  "email",
  "slack_user_id",
  "telegram_chat_id",
  "discord_user_id",
  "preferred_channel",
  "response_sla_hours",
  "on_leave_until",
  "reports_to_person_id",
  "authority_scope",
  "availability",
];

const PEOPLE_UPDATE_FIELDS = [
  "full_name",
  "role",
  "email",
  "slack_user_id",
  "telegram_chat_id",
  "discord_user_id",
  "preferred_channel",
  "response_sla_hours",
  "on_leave_until",
  "clear_on_leave",
  "reports_to_person_id",
  "department_slugs",
  "authority_scope",
  "availability",
];

const actions: ActionSpec[] = [
  {
    name: "list",
    description:
      "List the roster. Archived people are excluded unless you ask for them.",
    method: "GET",
    path: "/people",
    fields: {
      include_archived: optionalFlag(
        "Include archived (offboarded) people. Default false.",
      ),
    },
    query: ["include_archived"],
  },
  {
    name: "list_by_scope",
    description:
      "List the people who hold a given authority scope — e.g. everyone who can sign off hiring. Use this to decide who to address before asking for an approval.",
    method: "GET",
    path: "/people/by-scope/:token",
    fields: {
      token: text(AUTHORITY_SCOPES),
    },
  },
  {
    name: "get",
    description:
      "Read one person in full — channels, authority scope, availability and reporting line.",
    method: "GET",
    path: "/people/:person_id",
    fields: { person_id: identifier("Person id.") },
  },
  {
    name: "create",
    description:
      "Add a person to the roster. Only `full_name` is required; everything else has a sensible default. Use `list_departments` first to get valid department slugs.",
    method: "POST",
    path: "/people",
    fields: {
      ...personFields,
      is_principal: optionalFlag(
        "True for the company principal (usually exactly one).",
      ),
    },
    bodyFrom: PEOPLE_CREATE_FIELDS,
  },
  {
    name: "update",
    description:
      "Update a person — send only the fields that changed. Pass `null` for a nullable field to clear it, or `clear_on_leave: true` to end an on-leave period early.",
    method: "PATCH",
    path: "/people/:person_id",
    fields: {
      person_id: identifier("Person id."),
      ...personFields,
      // Every person field is optional on update, including the name — an
      // update that only sets a phone channel must not have to resend it.
      full_name: optionalText("Person's full name."),
      clear_on_leave: optionalFlag(
        "True clears `on_leave_until` back to null (the person is no longer away).",
      ),
    },
    bodyFrom: PEOPLE_UPDATE_FIELDS,
  },
  {
    name: "archive",
    description:
      "⚠️ destructive — offboard a person. Reversible via `update` (archived people can be listed with `include_archived`), but they stop receiving questions immediately.",
    method: "POST",
    path: "/people/:person_id/archive",
    fields: { person_id: identifier("Person id.") },
  },
];

export function registerPeopleTools(
  server: Parameters<typeof defineDomainTool>[0],
) {
  defineDomainTool(server, {
    name: "oe_people",
    description:
      "The company roster: who exists, what each person can authorise, where to reach them, and their working hours. People are what approvals and escalations route to.",
    actions,
  });
}
