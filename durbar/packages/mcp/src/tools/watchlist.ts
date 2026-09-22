/**
 * `oe_watchlist` — what the monitoring pipeline watches, and its signals.
 */

import * as v from "valibot";
import {
  type ActionSpec,
  defineDomainTool,
  nullableJsonObject,
  nullableText,
  optionalFlag,
  optionalNumber,
  optionalText,
  text,
} from "./registry.ts";

const CADENCES = "One of: real_time | 15min | hourly | daily | weekly.";
const SEVERITIES = "One of: low | medium | high | urgent (the AlertSeverity ladder).";
const MODES = "One of: active | dry_run. dry_run produces suggestions that need approval before going live.";
const DECLINE_REASONS =
  "One of: not_relevant (blacklist the entity) | wrong_source (blacklist only this target) | too_noisy (keep the source live but only surface high-severity signals).";

const actions: ActionSpec[] = [
  {
    name: "list",
    description: "List watchlist items. Filter by enabled state or signal type to answer 'what are we monitoring, and what is switched off?'.",
    method: "GET",
    path: "/watchlist",
    fields: { enabled_only: optionalFlag("Only items that are enabled. Default false."), signal_type: optionalText("Filter to one signal type, e.g. 'news' or 'filing'.") },
    query: ["enabled_only", "signal_type"],
  },
  {
    name: "get",
    description: "Read one watchlist item: trigger, config, cadence, severity floor/ceiling, mode and origin.",
    method: "GET",
    path: "/watchlist/:slug",
    fields: { slug: text("Watchlist slug.") },
  },
  {
    name: "signals",
    description: "Recent signals collected by one item — what the watch actually found. Use this to judge whether a watch is too noisy before retuning it.",
    method: "GET",
    path: "/watchlist/:slug/signals",
    fields: { slug: text("Watchlist slug."), limit: optionalNumber("Maximum signals to return (1–200, default 50).") },
    query: ["limit"],
  },
  {
    name: "create",
    description: "Create a watch. `slug`, `signal_type` and `target` are required. Fails with 409 on a duplicate slug and 400 on an unrecognised cadence, mode, severity or signal type.",
    method: "POST",
    path: "/watchlist",
    fields: {
      slug: text("Unique slug for the watch (1–64 chars)."),
      signal_type: text("What to watch for, e.g. 'news', 'filing', 'pricing_change'."),
      target: text("What to watch — an entity, company, domain or market (up to 500 chars)."),
      trigger: v.optional(v.pipe(v.record(v.string(), v.unknown()), v.description("Matching rules for the signal type, e.g. keywords or thresholds."))),
      config: v.optional(v.pipe(v.record(v.string(), v.unknown()), v.description("Per-source configuration."))),
      cadence: optionalText(`How often to poll. ${CADENCES} Defaults to '15min'.`),
      severity_floor: optionalText(`Lowest severity worth surfacing. ${SEVERITIES} Default 'low'.`),
      severity_ceiling: optionalText(`Highest severity this watch may raise. ${SEVERITIES} Default 'urgent'.`),
      mode: optionalText(`Defaults to 'active'. ${MODES}`),
      route_to_specialist: optionalText("Specialist key to route findings to, e.g. 'finance'."),
      notes: optionalText("Why this watch exists (up to 500 chars)."),
      display_label: optionalText("Human-facing label, if it should differ from the slug."),
    },
    bodyFrom: [
      "slug", "signal_type", "target", "trigger", "config", "cadence", "severity_floor",
      "severity_ceiling", "mode", "route_to_specialist", "notes", "display_label",
    ],
  },
  {
    name: "update",
    description: "Retune a watch — send at least one of the tunable fields or the backend returns 400. Pass `null` to clear `trigger` or `notes`.",
    method: "PATCH",
    path: "/watchlist/:slug",
    fields: {
      slug: text("Watchlist slug."),
      enabled: optionalFlag("Turn the watch on or off."),
      mode: optionalText(MODES),
      cadence: optionalText(CADENCES),
      severity_floor: nullableText(`Lowest severity worth surfacing. ${SEVERITIES}`),
      severity_ceiling: nullableText(`Highest severity this watch may raise. ${SEVERITIES}`),
      trigger: nullableJsonObject("Replacement matching rules; null clears them."),
      notes: nullableText("Replacement notes; null clears them."),
    },
    bodyFrom: ["enabled", "mode", "cadence", "severity_floor", "severity_ceiling", "trigger", "notes"],
  },
  {
    name: "delete",
    description: "⚠️ destructive — permanently delete a watch and its signal history. To stop watching something temporarily, prefer `update` with `enabled: false`.",
    method: "DELETE",
    path: "/watchlist/:slug",
    fields: { slug: text("Watchlist slug."), reason: optionalText("Audit reason recorded with the deletion (must be a value the backend recognises).") },
    query: ["reason"],
  },
  {
    name: "approve",
    description: "Approve a pending research suggestion, turning it into a live watch (origin=research). 409 if the item is not a pending suggestion.",
    method: "POST",
    path: "/watchlist/:slug/approve",
    fields: { slug: text("Watchlist slug of the pending suggestion.") },
  },
  {
    name: "decline",
    description:
      "⚠️ destructive — decline a pending research suggestion. The reason picks the remedy: `not_relevant` blacklists the entity and `wrong_source` blacklists the target (both delete the suggestion), while `too_noisy` keeps the source live but only surfaces high-severity signals. 409 if the item is not a pending suggestion.",
    method: "POST",
    path: "/watchlist/:slug/decline",
    fields: {
      slug: text("Watchlist slug of the pending suggestion."),
      reason: optionalText(`${DECLINE_REASONS} Defaults to 'not_relevant' — say which remedy you intend.`),
    },
    bodyFrom: ["reason"],
  },
];

export function registerWatchlistTools(server: Parameters<typeof defineDomainTool>[0]): void {
  defineDomainTool(server, {
    name: "oe_watchlist",
    description: "Monitored entities and the signals they produced: targets, signal types, cadences, severity floors/ceilings, plus the approve/decline queue for research suggestions.",
    actions,
  });
}
