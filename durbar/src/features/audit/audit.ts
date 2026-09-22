/**
 * Audit log — query, session timeline, usage, and reliability.
 *
 * Port of `audit/logger.py` + `api/routes/audit.py`. The table already exists
 * via migration 1; additive columns (full_json, department) are added by
 * migration 8. This module owns the typed helpers so the route layer stays thin.
 *
 * Session graph derivation mirrors the Python `_build_session_graph` — nodes
 * from events plus edges inferred from turn_id and inbound linkage.
 */

import type { Db } from "../../db.ts";

// ── types ──────────────────────────────────────────────────────────────────

export const EVENT_TYPES = [
  "integration_inbound",
  "chat_turn",
  "specialist_consult",
  "tool_invocation",
  "knowledge_retrieval",
  "cache_event",
  "memory_snapshot",
  "committee_review",
  "scheduled_action",
  "alert",
  "peer_memory",
  "auth_login",
  "auth_logout",
] as const;

export interface AuditEvent {
  id: number;
  ts: string;
  event_type: string;
  session_id: string | null;
  turn_id: string | null;
  actor: string | null;
  summary: string;
  details: Record<string, unknown> | null;
  full: Record<string, unknown> | null;
  department: string | null;
}

export interface AuditGraphNode {
  id: string;
  event_id: number;
  event_type: string;
  kind: string;
  label: string;
  actor: string | null;
  turn_id: string | null;
  ts: string;
}

export interface AuditGraphEdge {
  source: string;
  target: string;
  relation: string;
}

export interface AuditGraph {
  nodes: AuditGraphNode[];
  edges: AuditGraphEdge[];
}

export interface CostSummary {
  calls: number;
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  web_search_requests: number;
  per_turn: Array<{
    turn_id: string | null;
    calls: number;
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
    web_search_requests: number;
  }>;
}

export interface Degradation {
  kind: string;
  reason: string;
  count: number;
  turn_ids: string[];
  detail: string | null;
}

// ── helpers ────────────────────────────────────────────────────────────────

const SESSION_ID_RE = /^[A-Za-z0-9_:@\-.\+/=]{1,256}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

const KIND_BY_EVENT_TYPE: Record<string, string> = {
  integration_inbound: "inbound",
  chat_turn: "response",
  specialist_consult: "specialist",
  tool_invocation: "tool",
  knowledge_retrieval: "knowledge",
  cache_event: "cache",
  memory_snapshot: "memory",
  committee_review: "committee",
  scheduled_action: "scheduled",
  alert: "alert",
};

function nodeLabel(
  eventType: string,
  summary: string,
  details: Record<string, unknown>,
): string {
  if (eventType === "specialist_consult") {
    const actor = (details["specialist"] as string) ?? "";
    return (actor || summary).slice(0, 60);
  }
  if (eventType === "tool_invocation") {
    const tool = details["tool"] as string | undefined;
    if (tool) return tool.slice(0, 60);
    return summary.slice(0, 60);
  }
  if (eventType === "knowledge_retrieval") {
    const n =
      ((details["builtin_count"] as number) ?? 0) +
      ((details["company_count"] as number) ?? 0);
    let domain: string = "*";
    const df = details["domain_filter"];
    if (Array.isArray(df)) domain = (df as string[]).join(",") || "*";
    else if (typeof df === "string") domain = df;
    return `RAG[${domain}] · ${n} chunks`.slice(0, 60);
  }
  if (eventType === "cache_event") {
    const cr = (details["cache_read_input_tokens"] as number) ?? 0;
    const cc = (details["cache_creation_input_tokens"] as number) ?? 0;
    const out = (details["output_tokens"] as number) ?? 0;
    return `cache r=${cr} w=${cc} out=${out}`.slice(0, 60);
  }
  if (eventType === "memory_snapshot") {
    const ep = (details["episodic_chars"] as number) ?? 0;
    const rag = (details["retrieved_chars"] as number) ?? 0;
    return `memory · ep=${ep}c rag=${rag}c`.slice(0, 60);
  }
  if (eventType === "integration_inbound") {
    const idx = summary.indexOf(": ");
    return (idx !== -1 ? summary.slice(idx + 2) : summary).slice(0, 60);
  }
  if (eventType === "committee_review") return "committee revision";
  return summary.slice(0, 60);
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed } as Record<string, unknown>;
  } catch {
    return { raw } as Record<string, unknown>;
  }
}

function rowToEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: row["id"] as number,
    ts: row["ts"] as string,
    event_type: row["event_type"] as string,
    session_id: (row["session_id"] as string | null) ?? null,
    turn_id: (row["turn_id"] as string | null) ?? null,
    actor: (row["actor"] as string | null) ?? null,
    summary: row["summary"] as string,
    details: parseJson(row["details_json"] as string | null),
    full: parseJson(row["full_json"] as string | null),
    department: (row["department"] as string | null) ?? null,
  };
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ── store ──────────────────────────────────────────────────────────────────

export function getAuditEvent(db: Db, id: number): AuditEvent | null {
  const row = db
    .query<
      Record<string, unknown>,
      [number]
    >("SELECT id, ts, event_type, session_id, turn_id, actor, summary, details_json, full_json, department FROM audit_log WHERE id = ?")
    .get(id);
  return row ? rowToEvent(row) : null;
}

export function queryAudit(
  db: Db,
  opts: {
    eventType?: string | null;
    sessionId?: string | null;
    actor?: string | null;
    q?: string | null;
    since?: string | null;
    until?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): AuditEvent[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const offset = Math.max(0, opts.offset ?? 0);
  const clauses: string[] = [];
  const params: (string | number | null)[] = [];
  if (opts.eventType) {
    clauses.push("event_type = ?");
    params.push(opts.eventType);
  }
  if (opts.sessionId) {
    clauses.push("session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts.actor) {
    clauses.push("actor = ?");
    params.push(opts.actor);
  }
  if (opts.since) {
    clauses.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    clauses.push("ts <= ?");
    params.push(opts.until);
  }
  if (opts.q) {
    clauses.push("summary LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(opts.q)}%`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT id, ts, event_type, session_id, turn_id, actor, summary, details_json, full_json, department FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return db
    .query<Record<string, unknown>, (string | number | null)[]>(sql)
    .all(...(params as (string | number | null)[]))
    .map(rowToEvent);
}

export function countAudit(
  db: Db,
  opts: {
    eventType?: string | null;
    sessionId?: string | null;
    actor?: string | null;
    q?: string | null;
    since?: string | null;
    until?: string | null;
  } = {},
): number {
  const clauses: string[] = [];
  const params: (string | number | null)[] = [];
  if (opts.eventType) {
    clauses.push("event_type = ?");
    params.push(opts.eventType);
  }
  if (opts.sessionId) {
    clauses.push("session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts.actor) {
    clauses.push("actor = ?");
    params.push(opts.actor);
  }
  if (opts.since) {
    clauses.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    clauses.push("ts <= ?");
    params.push(opts.until);
  }
  if (opts.q) {
    clauses.push("summary LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(opts.q)}%`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = db
    .query<
      { n: number },
      (string | number | null)[]
    >(`SELECT COUNT(*) as n FROM audit_log ${where}`)
    .get(...(params as (string | number | null)[]));
  return row?.n ?? 0;
}

export function buildSessionGraph(events: AuditEvent[]): {
  graph: AuditGraph;
  channel: string | null;
} {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const nodes: AuditGraphNode[] = [];
  const edges: AuditGraphEdge[] = [];
  let channel: string | null = null;
  const turnAnchor = new Map<string, string>();
  const lastSpecialistInTurn = new Map<string, string>();
  let inboundNodeId: string | null = null;
  let inboundConsumed = false;

  for (const evt of ordered) {
    const kind = KIND_BY_EVENT_TYPE[evt.event_type] ?? evt.event_type;
    const nodeId = `n${evt.id}`;
    const details = evt.details ?? {};
    const label = nodeLabel(evt.event_type, evt.summary ?? "", details);
    nodes.push({
      id: nodeId,
      event_id: evt.id,
      event_type: evt.event_type,
      kind,
      label,
      actor: evt.actor,
      turn_id: evt.turn_id,
      ts: evt.ts,
    });

    if (evt.event_type === "integration_inbound") {
      const ch = (details["channel"] as string) ?? null;
      if (typeof ch === "string" && ch) channel = ch;
      inboundNodeId = nodeId;
      inboundConsumed = false;
    }

    const tid = evt.turn_id;
    if (evt.event_type === "memory_snapshot" && tid) {
      turnAnchor.set(tid, nodeId);
      if (inboundNodeId && !inboundConsumed) {
        edges.push({
          source: inboundNodeId,
          target: nodeId,
          relation: "cause",
        });
        inboundConsumed = true;
      }
    } else if (
      (evt.event_type === "knowledge_retrieval" ||
        evt.event_type === "specialist_consult" ||
        evt.event_type === "tool_invocation" ||
        evt.event_type === "cache_event" ||
        evt.event_type === "committee_review") &&
      tid
    ) {
      const anchor = turnAnchor.get(tid);
      if (anchor)
        edges.push({ source: anchor, target: nodeId, relation: "order" });
      if (evt.event_type === "tool_invocation") {
        const prev = lastSpecialistInTurn.get(tid);
        if (prev)
          edges.push({ source: prev, target: nodeId, relation: "cause" });
      }
      if (evt.event_type === "specialist_consult" && tid) {
        lastSpecialistInTurn.set(tid, nodeId);
      }
    } else if (evt.event_type === "chat_turn") {
      if (tid && turnAnchor.has(tid)) {
        edges.push({
          source: turnAnchor.get(tid) as string,
          target: nodeId,
          relation: "cause",
        });
      } else if (inboundNodeId && !inboundConsumed) {
        edges.push({
          source: inboundNodeId,
          target: nodeId,
          relation: "cause",
        });
        inboundConsumed = true;
      }
      if (tid) {
        if (!turnAnchor.has(tid)) turnAnchor.set(tid, nodeId);
      }
    }
  }

  return { graph: { nodes, edges }, channel };
}

export function computeCostSummary(events: AuditEvent[]): CostSummary | null {
  const rows = events.filter((e) => e.event_type === "cache_event");
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const fields = [
    "input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "web_search_requests",
  ] as const;
  const toInt = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  };
  const perTurnAcc = new Map<string | null, Record<string, number>>();
  const order: Array<string | null> = [];
  for (const e of sorted) {
    if (!perTurnAcc.has(e.turn_id)) {
      perTurnAcc.set(e.turn_id, {
        calls: 0,
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        web_search_requests: 0,
      });
      order.push(e.turn_id);
    }
    const acc = perTurnAcc.get(e.turn_id) as Record<string, number>;
    acc["calls"] = (acc["calls"] ?? 0) + 1;
    const details = e.details ?? {};
    for (const f of fields) acc[f] = (acc[f] ?? 0) + toInt(details[f]);
  }
  const perTurn = order.map((tid) => {
    const acc = perTurnAcc.get(tid) as Record<string, number>;
    return {
      turn_id: tid,
      calls: acc["calls"] ?? 0,
      input_tokens: acc["input_tokens"] ?? 0,
      cache_read_input_tokens: acc["cache_read_input_tokens"] ?? 0,
      cache_creation_input_tokens: acc["cache_creation_input_tokens"] ?? 0,
      output_tokens: acc["output_tokens"] ?? 0,
      web_search_requests: acc["web_search_requests"] ?? 0,
    };
  });
  const totals = {
    calls: 0,
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    web_search_requests: 0,
  };
  for (const acc of perTurnAcc.values()) {
    for (const k of Object.keys(totals) as Array<keyof typeof totals>)
      totals[k] += acc[k] ?? 0;
  }
  return { ...totals, per_turn: perTurn };
}

export function computeDegradations(events: AuditEvent[]): Degradation[] {
  const degradedOutcomes = new Set(["timeout", "error"]);
  const acc = new Map<
    string,
    { count: number; turn_ids: string[]; detail: string | null }
  >();
  const order: string[] = [];
  for (const e of events) {
    if (e.event_type !== "peer_memory") continue;
    const outcome = (e.details?.["outcome"] as string) ?? "";
    if (!degradedOutcomes.has(outcome)) continue;
    const key = `memory:${outcome}`;
    if (!acc.has(key)) {
      acc.set(key, { count: 0, turn_ids: [], detail: null });
      order.push(key);
    }
    const entry = acc.get(key) as {
      count: number;
      turn_ids: string[];
      detail: string | null;
    };
    entry.count += 1;
    if (e.turn_id && !entry.turn_ids.includes(e.turn_id))
      entry.turn_ids.push(e.turn_id);
    if (entry.detail === null && e.details?.["error_type"])
      entry.detail = String(e.details["error_type"]);
  }
  return order.map((key) => {
    const [kind, reason] = key.split(":");
    const entry = acc.get(key) as {
      count: number;
      turn_ids: string[];
      detail: string | null;
    };
    return {
      kind: kind ?? "memory",
      reason: reason ?? "",
      count: entry.count,
      turn_ids: entry.turn_ids,
      detail: entry.detail,
    };
  });
}

export function usageSummary(
  db: Db,
  since?: string | null,
  until?: string | null,
): {
  totals: {
    calls: number;
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
    web_search_requests: number;
    cost_usd: number;
  };
  by_day: Array<{
    day: string;
    calls: number;
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
    web_search_requests: number;
    cost_usd: number;
  }>;
  by_model: Array<{
    model: string;
    calls: number;
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
    web_search_requests: number;
    cost_usd: number;
  }>;
  by_source: Array<{
    source: string;
    calls: number;
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
    web_search_requests: number;
    cost_usd: number;
  }>;
} {
  // Filter cache_event rows by ts window, then aggregate.
  const clauses: string[] = ["event_type = 'cache_event'"];
  const params: (string | number | null)[] = [];
  if (since) {
    clauses.push("ts >= ?");
    params.push(since);
  }
  if (until) {
    clauses.push("ts <= ?");
    params.push(until);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = db
    .query<
      Record<string, unknown>,
      (string | number | null)[]
    >(`SELECT details_json, ts, actor FROM audit_log ${where} ORDER BY id`)
    .all(...(params as (string | number | null)[]));

  const totals = {
    calls: 0,
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    web_search_requests: 0,
    cost_usd: 0,
  };
  const byDay = new Map<string, typeof totals>();
  const byModel = new Map<string, typeof totals>();
  const bySource = new Map<string, typeof totals>();

  const toInt = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  };
  const toFloat = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };

  for (const row of rows) {
    const details = parseJson(row["details_json"] as string | null) ?? {};
    const day = String(row["ts"] ?? "").slice(0, 10) || "unknown";
    const model = (details["model"] as string) ?? "unknown";
    const source = (row["actor"] as string) ?? "unknown";
    const cost = toFloat(details["cost_usd"]);

    totals.calls += 1;
    totals.input_tokens += toInt(details["input_tokens"]);
    totals.cache_read_input_tokens += toInt(details["cache_read_input_tokens"]);
    totals.cache_creation_input_tokens += toInt(
      details["cache_creation_input_tokens"],
    );
    totals.output_tokens += toInt(details["output_tokens"]);
    totals.web_search_requests += toInt(details["web_search_requests"]);
    totals.cost_usd += cost;

    for (const [map, key] of [
      [byDay, day],
      [byModel, model],
      [bySource, source],
    ] as const) {
      const m = map as Map<string, typeof totals>;
      if (!m.has(key))
        m.set(key, {
          calls: 0,
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
          web_search_requests: 0,
          cost_usd: 0,
        });
      const acc = m.get(key) as typeof totals;
      acc.calls += 1;
      acc.input_tokens += toInt(details["input_tokens"]);
      acc.cache_read_input_tokens += toInt(details["cache_read_input_tokens"]);
      acc.cache_creation_input_tokens += toInt(
        details["cache_creation_input_tokens"],
      );
      acc.output_tokens += toInt(details["output_tokens"]);
      acc.web_search_requests += toInt(details["web_search_requests"]);
      acc.cost_usd += cost;
    }
  }

  return {
    totals,
    by_day: [...byDay.entries()].map(([day, v]) => ({ day, ...v })),
    by_model: [...byModel.entries()].map(([model, v]) => ({ model, ...v })),
    by_source: [...bySource.entries()].map(([source, v]) => ({ source, ...v })),
  };
}
