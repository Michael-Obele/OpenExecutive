/**
 * Spec for audit — logs, session timeline, usage.
 *
 * Mirrors `api/routes/audit.py` contract: filter, pagination, validation,
 * session graph, and usage aggregation.
 */

import { describe, expect, test } from "bun:test";
import { openDb, type Db } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";

function fakeProvider(): Provider {
  return { name: "fake", defaultModel: "fake-model", async chat() { return "ok"; } };
}

function fakeSettings(): Settings {
  return {
    dbPath: ":memory:",
    port: 8787,
    publicServerUrl: "",
    allowedOrigins: [],
    morningBriefTime: "08:00",
    eodDigestTime: "18:00",
    reflectionTime: "07:30",
    scheduledAdminToken: "",
    provider: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-chat", reasoningModel: "deepseek-reasoner", routingModel: "deepseek-chat", headers: {} },
  };
}

function appWith(db: ReturnType<typeof openDb>) {
  return createApp({ settings: fakeSettings(), db, provider: fakeProvider() });
}

async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app(new Request(`http://localhost${path}`, init));
  const body: unknown = await res.json().catch(() => null);
  return { res, body };
}

function insertAudit(db: Db, overrides: Partial<{ event_type: string; session_id: string; actor: string; summary: string; ts: string }> = {}): number {
  const result = db.run(
    `INSERT INTO audit_log (ts, event_type, session_id, turn_id, actor, summary, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      overrides.ts ?? new Date().toISOString(),
      overrides.event_type ?? "chat_turn",
      overrides.session_id ?? null,
      null,
      overrides.actor ?? "test",
      overrides.summary ?? "test event",
      null,
    ],
  );
  return Number(result.lastInsertRowid);
}

describe("GET /audit/logs", () => {
  test("returns logs with pagination", async () => {
    const db = openDb();
    insertAudit(db, { summary: "event one" });
    insertAudit(db, { summary: "event two" });
    const app = appWith(db);
    const { res, body } = await req(app, "/audit/logs");
    expect(res.status).toBe(200);
    const b = body as { items: unknown[]; total: number; event_types: unknown[] };
    expect(b.items).toHaveLength(2);
    expect(b.total).toBe(2);
    expect(b.event_types.length).toBeGreaterThan(0);
  });

  test("filters by event_type", async () => {
    const db = openDb();
    insertAudit(db, { event_type: "chat_turn" });
    insertAudit(db, { event_type: "alert" });
    const app = appWith(db);
    const { body } = await req(app, "/audit/logs?event_type=alert");
    const b = body as { items: Array<{ event_type: string }> };
    expect(b.items.every((i) => i.event_type === "alert")).toBe(true);
  });

  test("filters by session_id", async () => {
    const db = openDb();
    insertAudit(db, { session_id: "sess:1" });
    insertAudit(db, { session_id: "sess:2" });
    const app = appWith(db);
    const { body } = await req(app, "/audit/logs?session_id=sess:1");
    const b = body as { items: Array<{ session_id: string }> };
    expect(b.items.every((i) => i.session_id === "sess:1")).toBe(true);
  });

  test("searches by q", async () => {
    const db = openDb();
    insertAudit(db, { summary: "hello world" });
    insertAudit(db, { summary: "goodbye" });
    const app = appWith(db);
    const { body } = await req(app, "/audit/logs?q=hello");
    const b = body as { items: Array<{ summary: string }> };
    expect(b.items.some((i) => i.summary.includes("hello"))).toBe(true);
  });

  test("422 for unknown event_type", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/audit/logs?event_type=bogus_type");
    expect(res.status).toBe(422);
  });

  test("pagination with limit and offset", async () => {
    const db = openDb();
    for (let i = 0; i < 5; i += 1) insertAudit(db, { summary: `event ${i}` });
    const app = appWith(db);
    const { body } = await req(app, "/audit/logs?limit=2&offset=1");
    const b = body as { items: unknown[]; total: number; limit: number; offset: number };
    expect(b.items).toHaveLength(2);
    expect(b.total).toBe(5);
    expect(b.limit).toBe(2);
    expect(b.offset).toBe(1);
  });
});

describe("GET /audit/logs/{id}", () => {
  test("returns the event", async () => {
    const db = openDb();
    const id = insertAudit(db, { summary: "detail test" });
    const app = appWith(db);
    const { res, body } = await req(app, `/audit/logs/${id}`);
    expect(res.status).toBe(200);
    expect((body as { id: number }).id).toBe(id);
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/audit/logs/99999");
    expect(res.status).toBe(404);
  });
});

describe("GET /audit/sessions/{session_id}", () => {
  test("returns timeline and graph", async () => {
    const db = openDb();
    insertAudit(db, { session_id: "sess:abc", event_type: "chat_turn", summary: "turn 1" });
    insertAudit(db, { session_id: "sess:abc", event_type: "chat_turn", summary: "turn 2" });
    const app = appWith(db);
    const { res, body } = await req(app, "/audit/sessions/sess:abc");
    expect(res.status).toBe(200);
    const b = body as { session_id: string; events: unknown[]; graph: { nodes: unknown[] } };
    expect(b.session_id).toBe("sess:abc");
    expect(b.events).toHaveLength(2);
    expect(b.graph.nodes.length).toBe(2);
  });

  test("400 for invalid session_id format", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/audit/sessions/invalid!@#");
    expect(res.status).toBe(400);
  });

  test("404 when no events for session", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/audit/sessions/sess:nonexistent");
    expect(res.status).toBe(404);
  });

  test("includes cost_summary when cache_event present", async () => {
    const db = openDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO audit_log (ts, event_type, session_id, turn_id, actor, summary, details_json)
       VALUES (?, 'cache_event', 'sess:cost', 'turn:1', 'test', 'cache', ?)`,
      [now, JSON.stringify({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, web_search_requests: 0 })],
    );
    const app = appWith(db);
    const { body } = await req(app, "/audit/sessions/sess:cost");
    const b = body as { cost_summary: { calls: number } | null };
    expect(b.cost_summary).not.toBeNull();
    expect(b.cost_summary?.calls).toBe(1);
  });
});

describe("GET /audit/usage", () => {
  test("returns usage summary", async () => {
    const db = openDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO audit_log (ts, event_type, session_id, actor, summary, details_json)
       VALUES (?, 'cache_event', 'sess:1', 'executive', 'cache', ?)`,
      [now, JSON.stringify({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, web_search_requests: 1, cost_usd: 0.01, model: "test-model" })],
    );
    const app = appWith(db);
    const { res, body } = await req(app, "/audit/usage");
    expect(res.status).toBe(200);
    const b = body as { totals: { calls: number; cost_usd: number }; by_day: unknown[]; by_model: unknown[] };
    expect(b.totals.calls).toBe(1);
    expect(b.by_day.length).toBe(1);
    expect(b.by_model.length).toBe(1);
  });

  test("filters by since/until", async () => {
    const db = openDb();
    db.run(
      `INSERT INTO audit_log (ts, event_type, session_id, actor, summary, details_json)
       VALUES ('2020-01-01T00:00:00.000Z', 'cache_event', 'sess:1', 'executive', 'cache', ?)`,
      [JSON.stringify({ input_tokens: 10 })],
    );
    db.run(
      `INSERT INTO audit_log (ts, event_type, session_id, actor, summary, details_json)
       VALUES ('2026-09-21T00:00:00.000Z', 'cache_event', 'sess:1', 'executive', 'cache', ?)`,
      [JSON.stringify({ input_tokens: 20 })],
    );
    const app = appWith(db);
    const { body } = await req(app, "/audit/usage?since=2026-01-01T00:00:00.000Z");
    const b = body as { totals: { calls: number } };
    expect(b.totals.calls).toBe(1);
  });
});
