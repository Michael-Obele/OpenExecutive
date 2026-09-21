/**
 * Spec for alerts.
 *
 * Ported from `tests/unit/test_alerts_routes.py` + `test_alerts_pipeline.py`
 * + `test_alerts_store.py`: review queue, ack/reopen/bulk-ack, dedup,
 * quiet hours, severity threshold, category filtering, and validation.
 * Uses the HTTP layer so the contract is exercised end-to-end.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp, type AppContext } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
import {
  categorize,
  coalesceAlert,
  insertAlert,
  isInQuietHours,
  matchesMute,
  resolveChannels,
} from "./alerts.ts";

function fakeProvider(): Provider {
  return {
    name: "fake",
    defaultModel: "fake-model",
    async chat() {
      return "ok";
    },
  };
}

function fakeSettings(): Settings {
  return {
    dbPath: ":memory:",
    port: 8787,
    publicServerUrl: "",
    allowedOrigins: [],
    morningBriefTime: "08:00",
    scheduledAdminToken: "",
    provider: {
      name: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "test",
      model: "deepseek-chat",
      reasoningModel: "deepseek-reasoner",
      routingModel: "deepseek-chat",
      headers: {},
    },
  };
}

function appWith(db: ReturnType<typeof openDb>) {
  const context: AppContext = {
    settings: fakeSettings(),
    db,
    provider: fakeProvider(),
  };
  return createApp(context);
}

async function req(
  app: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit,
) {
  const res = await app(new Request(`http://localhost${path}`, init));
  const body: unknown = await res.json().catch(() => null);
  return { res, body };
}

function insert(
  db: ReturnType<typeof openDb>,
  headline: string,
  overrides: Record<string, unknown> = {},
): number {
  const id = insertAlert(db, {
    source: (overrides["source"] as string) ?? "triage",
    external_id: (overrides["external_id"] as string) ?? `ext-${headline}`,
    severity: (overrides["severity"] as "low" | "medium" | "high" | "urgent") ?? "medium",
    headline,
    body: (overrides["body"] as string) ?? "body",
    ...(overrides["dedup_key"] ? { dedup_key: overrides["dedup_key"] as string } : {}),
    ...(overrides["topic_tags"] ? { topic_tags: overrides["topic_tags"] as string[] } : {}),
  });
  if (id === null) throw new Error(`insertAlert returned null for ${headline}`);
  return id;
}

// ── GET /alerts/review ─────────────────────────────────────────────────

describe("GET /alerts/review", () => {
  test("empty when no alerts", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/alerts/review");
    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  test("returns live unread alerts", async () => {
    const db = openDb();
    const app = appWith(db);
    insert(db, "hello");
    const { body } = await req(app, "/alerts/review");
    expect((body as unknown[]).length).toBe(1);
    expect((body as Array<{ headline: string }>)[0]!.headline).toBe("hello");
  });

  test("excludes dismissed alerts", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insert(db, "to dismiss");
    await req(app, `/alerts/${id}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "dismissed" }),
    });
    const { body } = await req(app, "/alerts/review");
    expect((body as unknown[]).length).toBe(0);
  });
});

describe("POST /alerts/review", () => {
  test("returns zero counts (deferred model review)", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/alerts/review", { method: "POST" });
    expect(res.status).toBe(200);
    const b = body as Record<string, number>;
    expect(b["reviewed"]).toBe(0);
    expect(b["closed"]).toBe(0);
  });
});

// ── POST /alerts/{id}/ack ──────────────────────────────────────────────

describe("POST /alerts/{id}/ack", () => {
  test("acks an alert", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insert(db, "ack me");
    const { res, body } = await req(app, `/alerts/${id}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ack" }),
    });
    expect(res.status).toBe(200);
    expect((body as { status: string }).status).toBe("ack");
  });

  test("dismisses an alert", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insert(db, "dismiss me");
    const { res } = await req(app, `/alerts/${id}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "dismissed" }),
    });
    expect(res.status).toBe(200);
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/alerts/9999/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ack" }),
    });
    expect(res.status).toBe(404);
  });

  test("422 for invalid status", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insert(db, "bad status");
    const { res } = await req(app, `/alerts/${id}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "expired" }),
    });
    expect(res.status).toBe(422);
  });

  test("422 for non-object body", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insert(db, "bad body");
    const { res } = await req(app, `/alerts/${id}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify("not an object"),
    });
    expect(res.status).toBe(422);
  });
});

// ── POST /alerts/{id}/reopen ───────────────────────────────────────────

describe("POST /alerts/{id}/reopen", () => {
  test("reopens a dismissed alert", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insert(db, "reopen me");
    await req(app, `/alerts/${id}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "dismissed" }),
    });
    const { res, body } = await req(app, `/alerts/${id}/reopen`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((body as { status: string }).status).toBe("unread");
  });

  test("reopens an expired alert", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insert(db, "expired one");
    // Directly set to expired (no HTTP path for it, but the store allows it).
    db.run("UPDATE alerts SET status = 'expired' WHERE id = ?", [id]);
    const { res } = await req(app, `/alerts/${id}/reopen`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("409 when alert is still unread", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insert(db, "still unread");
    const { res } = await req(app, `/alerts/${id}/reopen`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  test("409 when alert is acked", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insert(db, "acked");
    await req(app, `/alerts/${id}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ack" }),
    });
    const { res } = await req(app, `/alerts/${id}/reopen`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  test("409 for artifact source (exempt)", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insert(db, "artifact one", { source: "artifact" });
    db.run("UPDATE alerts SET status = 'dismissed' WHERE id = ?", [id]);
    const { res } = await req(app, `/alerts/${id}/reopen`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/alerts/9999/reopen", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ── POST /alerts/bulk-ack ──────────────────────────────────────────────

describe("POST /alerts/bulk-ack", () => {
  test("bulk ack by ids", async () => {
    const db = openDb();
    const app = appWith(db);
    const a = insert(db, "a");
    const b = insert(db, "b");
    const { res, body } = await req(app, "/alerts/bulk-ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "dismissed", alert_ids: [a, b] }),
    });
    expect(res.status).toBe(200);
    expect((body as { count: number }).count).toBe(2);
  });

  test("bulk ack by age", async () => {
    const db = openDb();
    const app = appWith(db);
    const old = insert(db, "old one");
    // Make it 10 days old.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE alerts SET created_at = ? WHERE id = ?", [tenDaysAgo, old]);
    insert(db, "new one");

    const { body } = await req(app, "/alerts/bulk-ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "dismissed", older_than_days: 7 }),
    });
    expect((body as { count: number }).count).toBe(1);
  });

  test("exempt sources not bulk-closed by age sweep", async () => {
    const db = openDb();
    const app = appWith(db);
    const art = insert(db, "old artifact", { source: "artifact" });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE alerts SET created_at = ? WHERE id = ?", [tenDaysAgo, art]);

    const { body } = await req(app, "/alerts/bulk-ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "dismissed", older_than_days: 7 }),
    });
    expect((body as { count: number }).count).toBe(0);
  });

  test("400 when neither alert_ids nor older_than_days", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/alerts/bulk-ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ack" }),
    });
    expect(res.status).toBe(400);
  });

  test("422 for invalid status", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/alerts/bulk-ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "read", alert_ids: [1] }),
    });
    expect(res.status).toBe(422);
  });

  test("422 for older_than_days < 1", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/alerts/bulk-ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "dismissed", older_than_days: 0 }),
    });
    expect(res.status).toBe(422);
  });

  test("422 for alert_ids > 500", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/alerts/bulk-ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ack", alert_ids: Array.from({ length: 501 }, (_, i) => i + 1) }),
    });
    expect(res.status).toBe(422);
  });

  test("empty alert_ids returns count 0", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body } = await req(app, "/alerts/bulk-ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ack", alert_ids: [] }),
    });
    expect((body as { count: number }).count).toBe(0);
  });

  test("category filter", async () => {
    const db = openDb();
    const app = appWith(db);
    // monitoring: external signal, low severity, no routing
    const mon = insert(db, "monitoring one", { source: "rss", severity: "low", topic_tags: ["external:rss"] });
    // action: non-external source
    const act = insert(db, "action one", { source: "triage", severity: "medium" });

    const { body } = await req(app, "/alerts/bulk-ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "dismissed", alert_ids: [mon, act], category: "monitoring" }),
    });
    expect((body as { count: number }).count).toBe(1);
  });
});

// ── dedup / coalesce ───────────────────────────────────────────────────

describe("coalesceAlert", () => {
  test("coalesces a repeat into the existing row", () => {
    const db = openDb();
    insert(db, "first", { dedup_key: "watch:acme", source: "rss" });
    const result = coalesceAlert(db, { source: "rss", dedup_key: "watch:acme", severity: "medium", body: "updated" });
    expect(result).not.toBeNull();
    expect(result!.raised).toBe(false);
    // No new row was created — still one alert.
    const { body } = (() => {
      const rows = db.query<Record<string, unknown>, []>("SELECT * FROM alerts").all();
      return { body: rows };
    })();
    expect(body.length).toBe(1);
  });

  test("raises severity when repeat is graver", () => {
    const db = openDb();
    const id = insert(db, "first", { dedup_key: "watch:acme", source: "rss", severity: "low" });
    const result = coalesceAlert(db, { source: "rss", dedup_key: "watch:acme", severity: "high", body: "worse" });
    expect(result!.raised).toBe(true);
    const row = db.query<Record<string, unknown>, [number]>("SELECT severity FROM alerts WHERE id = ?").get(id);
    expect(row!["severity"]).toBe("high");
  });

  test("never lowers severity", () => {
    const db = openDb();
    const id = insert(db, "first", { dedup_key: "watch:acme", source: "rss", severity: "high" });
    coalesceAlert(db, { source: "rss", dedup_key: "watch:acme", severity: "low", body: "minor" });
    const row = db.query<Record<string, unknown>, [number]>("SELECT severity FROM alerts WHERE id = ?").get(id);
    expect(row!["severity"]).toBe("high");
  });

  test("returns null for empty dedup_key", () => {
    const db = openDb();
    insert(db, "first", { source: "rss" });
    expect(coalesceAlert(db, { source: "rss", dedup_key: "", severity: "medium", body: "x" })).toBeNull();
  });

  test("returns null when no open row", () => {
    const db = openDb();
    expect(coalesceAlert(db, { source: "rss", dedup_key: "watch:acme", severity: "medium", body: "x" })).toBeNull();
  });

  test("bumps occurrence_count", () => {
    const db = openDb();
    const id = insert(db, "first", { dedup_key: "watch:acme", source: "rss" });
    coalesceAlert(db, { source: "rss", dedup_key: "watch:acme", severity: "medium", body: "again" });
    coalesceAlert(db, { source: "rss", dedup_key: "watch:acme", severity: "medium", body: "again2" });
    const row = db.query<Record<string, unknown>, [number]>("SELECT occurrence_count FROM alerts WHERE id = ?").get(id);
    expect(row!["occurrence_count"]).toBe(3);
  });
});

// ── quiet hours ────────────────────────────────────────────────────────

describe("isInQuietHours", () => {
  test("inside window", () => {
    const prefs = {
      severity_threshold: "low" as const,
      quiet_hours_start: "22:00",
      quiet_hours_end: "07:00",
      quiet_hours_tz: "UTC",
      channels_enabled: ["web" as const],
    };
    // 23:00 UTC — inside.
    expect(isInQuietHours(prefs, new Date("2030-01-01T23:00:00.000Z"))).toBe(true);
    // 03:00 UTC — inside.
    expect(isInQuietHours(prefs, new Date("2030-01-01T03:00:00.000Z"))).toBe(true);
    // 12:00 UTC — outside.
    expect(isInQuietHours(prefs, new Date("2030-01-01T12:00:00.000Z"))).toBe(false);
  });

  test("non-wrapping window", () => {
    const prefs = {
      severity_threshold: "low" as const,
      quiet_hours_start: "09:00",
      quiet_hours_end: "17:00",
      quiet_hours_tz: "UTC",
      channels_enabled: ["web" as const],
    };
    expect(isInQuietHours(prefs, new Date("2030-01-01T10:00:00.000Z"))).toBe(true);
    expect(isInQuietHours(prefs, new Date("2030-01-01T18:00:00.000Z"))).toBe(false);
  });

  test("empty window means not in quiet hours", () => {
    const prefs = {
      severity_threshold: "low" as const,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "UTC",
      channels_enabled: ["web" as const],
    };
    expect(isInQuietHours(prefs, new Date("2030-01-01T23:00:00.000Z"))).toBe(false);
  });
});

// ── severity threshold ─────────────────────────────────────────────────

describe("resolveChannels", () => {
  test("drops below threshold to persisted only", () => {
    const prefs = {
      severity_threshold: "high" as const,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "UTC",
      channels_enabled: ["web" as const, "persisted" as const],
    };
    const out = resolveChannels(["web", "persisted"], "medium", prefs);
    expect(out).toEqual(["persisted"]);
  });

  test("urgent punches through quiet hours", () => {
    const prefs = {
      severity_threshold: "low" as const,
      quiet_hours_start: "00:00",
      quiet_hours_end: "23:59",
      quiet_hours_tz: "UTC",
      channels_enabled: ["web" as const, "persisted" as const],
    };
    const out = resolveChannels(["web", "persisted"], "urgent", prefs);
    expect(out).toContain("web");
  });

  test("quiet hours suppresses non-urgent", () => {
    const prefs = {
      severity_threshold: "low" as const,
      quiet_hours_start: "00:00",
      quiet_hours_end: "23:59",
      quiet_hours_tz: "UTC",
      channels_enabled: ["web" as const, "persisted" as const],
    };
    const out = resolveChannels(["web", "persisted"], "high", prefs);
    expect(out).toEqual(["persisted"]);
  });

  test("always includes persisted", () => {
    const prefs = {
      severity_threshold: "low" as const,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "UTC",
      channels_enabled: ["web" as const],
    };
    const out = resolveChannels(["web"], "high", prefs);
    expect(out).toContain("persisted");
  });
});

// ── categorize ─────────────────────────────────────────────────────────

describe("categorize", () => {
  test("external low signal is monitoring", () => {
    expect(categorize({ source: "rss", severity: "low", routed_to_person_id: null, topic_tags: ["external:rss"] })).toBe("monitoring");
  });

  test("routed external is action", () => {
    expect(categorize({ source: "rss", severity: "low", routed_to_person_id: 1, topic_tags: ["external:rss"] })).toBe("action");
  });

  test("high external is action", () => {
    expect(categorize({ source: "rss", severity: "high", routed_to_person_id: null, topic_tags: ["external:rss"] })).toBe("action");
  });

  test("non-external medium is action", () => {
    expect(categorize({ source: "triage", severity: "medium", routed_to_person_id: null, topic_tags: [] })).toBe("action");
  });
});

// ── matchesMute ────────────────────────────────────────────────────────

describe("matchesMute", () => {
  test("substring case-insensitive", () => {
    expect(matchesMute(["customer", "churn"], ["CHURN"])).toBe(true);
    expect(matchesMute(["hiring-pipeline"], ["hiring"])).toBe(true);
    expect(matchesMute(["finance"], ["legal"])).toBe(false);
    expect(matchesMute([], ["anything"])).toBe(false);
    expect(matchesMute(["a"], [])).toBe(false);
  });
});
