/**
 * `oe_talent` — hiring pipeline: engagements, candidates, and offers.
 */

import {
  type ActionSpec,
  defineDomainTool,
  identifier,
  optionalFlag,
  optionalIdentifier,
  optionalNumber,
  optionalText,
  text,
} from "./registry.ts";

const ENGAGEMENT_STATUSES = "One of: open | on_hold | filled | cancelled.";
const CANDIDATE_STAGES =
  "One of: lead | screened | interviewed | offer | placed | rejected.";
const OFFER_STATUSES =
  "One of: draft | pending_approval | extended | accepted | declined | expired | rescinded.";

const ENGAGEMENT_FIELDS = [
  "role_title",
  "department",
  "status",
  "location",
  "comp_band",
  "must_haves",
  "description",
];
const CANDIDATE_FIELDS = [
  "full_name",
  "current_title",
  "current_company",
  "location",
  "email",
  "linkedin_url",
  "source",
  "notes",
];

const actions: ActionSpec[] = [
  {
    name: "list_engagements",
    description:
      "List hiring engagements (open roles). Archived ones are excluded unless asked for.",
    method: "GET",
    path: "/engagements",
    fields: {
      include_archived: optionalFlag(
        "Include archived engagements. Default false.",
      ),
    },
    query: ["include_archived"],
  },
  {
    name: "get_engagement",
    description:
      "Read one engagement: role, comp band, must-haves, status and description.",
    method: "GET",
    path: "/engagements/:engagement_id",
    fields: { engagement_id: identifier("Engagement id.") },
  },
  {
    name: "create_engagement",
    description:
      "Open a role. Only `role_title` is required; fill in comp band, location and must-haves before sourcing.",
    method: "POST",
    path: "/engagements",
    fields: {
      role_title: text("Role title, e.g. 'Head of Finance' (1–200 chars)."),
      department: optionalText("Owning department slug."),
      status: optionalText(`Defaults to 'open'. ${ENGAGEMENT_STATUSES}`),
      location: optionalText("Location or 'Remote'."),
      comp_band: optionalText(
        "Compensation range, e.g. '£120k–£150k + equity'.",
      ),
      must_haves: optionalText("Non-negotiables for screening."),
      description: optionalText("Full role description (up to 8000 chars)."),
    },
    bodyFrom: ENGAGEMENT_FIELDS,
  },
  {
    name: "update_engagement",
    description:
      "Update an engagement — send only what changed (status transitions included).",
    method: "PATCH",
    path: "/engagements/:engagement_id",
    fields: {
      engagement_id: identifier("Engagement id."),
      role_title: optionalText("Role title."),
      department: optionalText("Owning department slug."),
      status: optionalText(ENGAGEMENT_STATUSES),
      location: optionalText("Location."),
      comp_band: optionalText("Compensation range."),
      must_haves: optionalText("Non-negotiables for screening."),
      description: optionalText("Full role description."),
    },
    bodyFrom: ENGAGEMENT_FIELDS,
  },
  {
    name: "archive_engagement",
    description:
      "⚠️ destructive — archive a closed engagement. Archived engagements are hidden from the default list but can still be listed with `include_archived`.",
    method: "POST",
    path: "/engagements/:engagement_id/archive",
    fields: { engagement_id: identifier("Engagement id.") },
  },
  {
    name: "match_candidates",
    description:
      "Rank existing candidates against an engagement. Cheaper than sourcing: check this before looking outside the pipeline.",
    method: "GET",
    path: "/engagements/:engagement_id/matches",
    fields: {
      engagement_id: identifier("Engagement id."),
      limit: optionalNumber("Maximum matches to return (default 10)."),
    },
    query: ["limit"],
  },
  {
    name: "list_candidates",
    description: "List candidates, optionally filtered by engagement or stage.",
    method: "GET",
    path: "/candidates",
    fields: {
      engagement_id: optionalIdentifier("Only candidates for this engagement."),
      stage: optionalText(`Only candidates at this stage. ${CANDIDATE_STAGES}`),
      include_archived: optionalFlag(
        "Include archived candidates. Default false.",
      ),
    },
    query: ["engagement_id", "stage", "include_archived"],
  },
  {
    name: "get_candidate",
    description:
      "Read one candidate: profile, stage, fit score and screening summary.",
    method: "GET",
    path: "/candidates/:candidate_id",
    fields: { candidate_id: identifier("Candidate id.") },
  },
  {
    name: "create_candidate",
    description:
      "Add a candidate to an engagement. 404 if the engagement does not exist. `stage` defaults to `lead`.",
    method: "POST",
    path: "/candidates",
    fields: {
      engagement_id: identifier(
        "Engagement this candidate is being considered for.",
      ),
      full_name: text("Candidate's full name (1–200 chars)."),
      current_title: optionalText("Current job title."),
      current_company: optionalText("Current employer."),
      location: optionalText("Location."),
      email: optionalText("Email address."),
      linkedin_url: optionalText("LinkedIn profile URL."),
      source: optionalText(
        "Where they came from, e.g. 'referral', 'outbound'.",
      ),
      stage: optionalText(`Defaults to 'lead'. ${CANDIDATE_STAGES}`),
      notes: optionalText("Free-form notes (up to 8000 chars)."),
    },
    bodyFrom: ["engagement_id", ...CANDIDATE_FIELDS],
  },
  {
    name: "update_candidate",
    description:
      "Update a candidate's details. The `stage` field is NOT patchable here — use `advance_candidate` so the stage transition stays audited.",
    method: "PATCH",
    path: "/candidates/:candidate_id",
    fields: {
      candidate_id: identifier("Candidate id."),
      full_name: optionalText("Candidate's full name."),
      current_title: optionalText("Current job title."),
      current_company: optionalText("Current employer."),
      location: optionalText("Location."),
      email: optionalText("Email address."),
      linkedin_url: optionalText("LinkedIn profile URL."),
      source: optionalText("Where they came from."),
      notes: optionalText("Free-form notes."),
    },
    bodyFrom: CANDIDATE_FIELDS,
  },
  {
    name: "advance_candidate",
    description: `Move a candidate to a new stage. ${CANDIDATE_STAGES}`,
    method: "POST",
    path: "/candidates/:candidate_id/stage",
    fields: {
      candidate_id: identifier("Candidate id."),
      stage: text(CANDIDATE_STAGES),
    },
    bodyFrom: ["stage"],
  },
  {
    name: "archive_candidate",
    description:
      "⚠️ destructive — archive a candidate, removing them from the active pipeline.",
    method: "POST",
    path: "/candidates/:candidate_id/archive",
    fields: { candidate_id: identifier("Candidate id.") },
  },
  {
    name: "similar_candidates",
    description:
      "Find candidates similar to one already in the pipeline — useful for 'who else is like this?'.",
    method: "GET",
    path: "/candidates/:candidate_id/similar",
    fields: {
      candidate_id: identifier("Candidate id."),
      limit: optionalNumber("Maximum matches to return (default 5)."),
    },
    query: ["limit"],
  },
  {
    name: "list_offers",
    description: "List offers, filterable by candidate, engagement or status.",
    method: "GET",
    path: "/offers",
    fields: {
      candidate_id: optionalIdentifier("Only offers to this candidate."),
      engagement_id: optionalIdentifier("Only offers for this engagement."),
      status: optionalText(`Only offers in this status. ${OFFER_STATUSES}`),
      include_archived: optionalFlag("Include archived offers. Default false."),
    },
    query: ["candidate_id", "engagement_id", "status", "include_archived"],
  },
  {
    name: "get_offer",
    description: "Read one offer: terms, status, expiry and approval state.",
    method: "GET",
    path: "/offers/:offer_id",
    fields: { offer_id: identifier("Offer id.") },
  },
  {
    name: "create_offer",
    description:
      "Create a draft offer for a candidate. 404 if the candidate is unknown, 409 if they already have an open offer (one open offer per candidate).",
    method: "POST",
    path: "/offers",
    fields: {
      candidate_id: identifier("Candidate the offer is for."),
      comp_summary: text(
        "The offer terms as a single summary string (required, non-empty).",
      ),
      note: optionalText("Internal note about the offer."),
    },
    bodyFrom: ["candidate_id", "comp_summary", "note"],
  },
  {
    name: "update_offer",
    description:
      "Change an offer's terms. 409 unless the offer is `draft` or `pending_approval` — once extended, terms are frozen.",
    method: "PATCH",
    path: "/offers/:offer_id",
    fields: {
      offer_id: identifier("Offer id."),
      comp_summary: optionalText("Replacement terms summary."),
      note: optionalText("Replacement note."),
    },
    bodyFrom: ["comp_summary", "note"],
  },
  {
    name: "extend_offer",
    description:
      "Extend the offer to the candidate — the only path to status `extended`, and never an automatic side effect of an approval. Sets the expiry (default 7 days, max 60).",
    method: "POST",
    path: "/offers/:offer_id/extend",
    fields: {
      offer_id: identifier("Offer id."),
      expires_at: optionalText(
        "Absolute expiry, ISO8601. Takes precedence over `expires_in_days`.",
      ),
      expires_in_days: optionalNumber("Days until expiry (1–60, default 7)."),
      note: optionalText("Note recorded with the extension."),
    },
    bodyFrom: ["expires_at", "expires_in_days", "note"],
  },
  {
    name: "decide_offer",
    description:
      "Record the candidate's decision on an extended offer. Returns the offer plus side effects — scheduled follow-up nudges, cancelled nudges, warnings.",
    method: "POST",
    path: "/offers/:offer_id/decision",
    fields: {
      offer_id: identifier("Offer id."),
      decision: text(
        "The terminal status: accepted | declined | expired | rescinded.",
      ),
      note: optionalText("Note recorded with the decision."),
    },
    bodyFrom: ["decision", "note"],
  },
  {
    name: "archive_offer",
    description:
      "⚠️ destructive — archive an offer, removing it from the default list.",
    method: "POST",
    path: "/offers/:offer_id/archive",
    fields: { offer_id: identifier("Offer id.") },
  },
  {
    name: "reindex",
    description:
      "Rebuild the talent knowledge graph from the engagement/candidate records. Run after a bulk import so matching and similarity see the new rows.",
    method: "POST",
    path: "/talent/reindex",
  },
];

export function registerTalentTools(
  server: Parameters<typeof defineDomainTool>[0],
): void {
  defineDomainTool(server, {
    name: "oe_talent",
    description:
      "The hiring funnel: engagements (open roles), candidates (with stages, fit scores and matching), and offers (with their approval/extend/decision state machine).",
    actions,
  });
}
