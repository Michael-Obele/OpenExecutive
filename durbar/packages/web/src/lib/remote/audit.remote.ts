/**
 * Audit remote functions.
 *
 * Event log + session timelines + usage rollups.
 */
import * as v from "valibot";
import { query } from "$app/server";
import { durbarJson } from "$lib/server/durbar.js";

export interface AuditEvent {
  id: number;
  ts: string;
  event_type: string;
  session_id: string | null;
  turn_id: string | null;
  actor: string | null;
  summary: string;
  details: Record<string, unknown> | null;
}

export interface AuditLogResult {
  items: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
  event_types: string[];
}

export const listAuditLogs = query(
  v.optional(
    v.object({
      event_type: v.optional(v.string()),
      session_id: v.optional(v.string()),
      actor: v.optional(v.string()),
      q: v.optional(v.string()),
      limit: v.optional(v.number()),
      offset: v.optional(v.number()),
    }),
    {},
  ),
  async (args): Promise<AuditLogResult> => {
    const q: Record<string, string> = {};
    if (args?.event_type) q.event_type = args.event_type;
    if (args?.session_id) q.session_id = args.session_id;
    if (args?.actor) q.actor = args.actor;
    if (args?.q) q.q = args.q;
    if (args?.limit !== undefined) q.limit = String(args.limit);
    if (args?.offset !== undefined) q.offset = String(args.offset);
    return durbarJson<AuditLogResult>("/audit/logs", { query: q });
  },
);

export const getAuditEvent = query(
  v.number(),
  async (id): Promise<AuditEvent> => {
    return durbarJson<AuditEvent>(`/audit/logs/${id}`);
  },
);

export interface UsageSummary {
  totals: Record<string, unknown>;
  by_day: unknown[];
  by_model: unknown[];
  by_source: unknown[];
}

export const getUsage = query(async (): Promise<UsageSummary> => {
  return durbarJson<UsageSummary>("/audit/usage");
});
