/**
 * Spec for briefing — today, activity, daily, morning-brief alias.
 *
 * Ported from `tests/unit/test_today_route.py`: empty state, goal counts,
 * attention goals, proposals, activity feeds, deprecated alias.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
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

function seedDepartment(db: ReturnType<typeof openDb>, slug: string, title: string): void {
  db.run("INSERT INTO departments (slug, title, updated_at) VALUES (?, ?, ?)", [slug, title, new Date().toISOString()]);
}

function seedGoal(db: ReturnType<typeof openDb>, slug: string, keyResult: string, status = "on_track", current = ""): void {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO department_goals (department_slug, period_value, key_result, target, current, status, created_at, updated_at) VALUES (?, 'Q1', ?, 'target', ?, ?, ?, ?)",
    [slug, keyResult, current, status, now, now],
  );
}

function seedAlert(db: ReturnType<typeof openDb>, headline: string, overrides: Record<string, unknown> = {}): void {
  db.run(
    "INSERT INTO alerts (source, severity, headline, body, status, created_at, topic_tags) VALUES (?, ?, ?, ?, 'unread', ?, ?)",
    [
      (overrides["source"] as string) ?? "triage",
      (overrides["severity"] as string) ?? "medium",
      headline,
      (overrides["body"] as string) ?? "body",
      new Date().toISOString(),
      JSON.stringify((overrides["topic_tags"] as string[]) ?? []),
    ],
  );
}

// ── GET /today ─────────────────────────────────────────────────────────

describe("GET /today", () => {
  test("empty state returns departments, people, proposals", async () => {
    const db = openDb();
    // Seed departments so today has something to return.
    const { seedDefaultDepartments } = await import("../departments/departments.ts");
    seedDefaultDepartments(db);
    const app = appWith(db);
    const { res, body } = await req(app, "/today");
    expect(res.status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(Array.isArray(data["departments"])).toBe(true);
    expect(Array.isArray(data["people"])).toBe(true);
    expect(Array.isArray(data["proposals"])).toBe(true);
    expect((data["departments"] as unknown[]).length).toBe(8);
  });

  test("goal counts reflected", async () => {
    const db = openDb();
    seedDepartment(db, "finance", "Finance");
    seedGoal(db, "finance", "Healthy", "on_track");
    seedGoal(db, "finance", "Burn", "at_risk", "$612K");
    const app = appWith(db);
    const { body } = await req(app, "/today");
    const fin = ((body as Record<string, unknown>)["departments"] as Array<Record<string, unknown>>).find((d) => d["slug"] === "finance");
    expect(fin?.["goal_count"]).toBe(2);
    expect(fin?.["at_risk_count"]).toBe(1);
  });

  test("attention_goals surface off_track before at_risk", async () => {
    const db = openDb();
    seedDepartment(db, "finance", "Finance");
    seedGoal(db, "finance", "Healthy", "on_track");
    seedGoal(db, "finance", "Burn", "at_risk", "$612K");
    seedGoal(db, "finance", "Runway", "off_track", "7mo");
    const app = appWith(db);
    const { body } = await req(app, "/today");
    const fin = ((body as Record<string, unknown>)["departments"] as Array<Record<string, unknown>>).find((d) => d["slug"] === "finance");
    const attention = fin?.["attention_goals"] as Array<Record<string, string>>;
    expect(attention).toHaveLength(2);
    expect(attention.map((g) => g["key_result"])).toEqual(["Runway", "Burn"]);
  });

  test("proposals surface unread alerts", async () => {
    const db = openDb();
    seedAlert(db, "Approve vendor renegotiation");
    seedAlert(db, "General alert");
    const app = appWith(db);
    const { body } = await req(app, "/today");
    const proposals = (body as Record<string, unknown>)["proposals"] as Array<Record<string, unknown>>;
    expect(proposals.length).toBe(2);
  });

  test("monitoring alerts excluded from proposals", async () => {
    const db = openDb();
    seedAlert(db, "Monitoring noise", { source: "monitoring:watchlist" });
    seedAlert(db, "Real proposal", { source: "triage" });
    const app = appWith(db);
    const { body } = await req(app, "/today");
    const proposals = (body as Record<string, unknown>)["proposals"] as Array<Record<string, unknown>>;
    expect(proposals.length).toBe(1);
    expect(proposals[0]!["headline"]).toBe("Real proposal");
  });

  test("decision_instance_id parsed from topic_tags", async () => {
    const db = openDb();
    seedAlert(db, "Approve meeting", { topic_tags: ["decision_instance:42"] });
    const app = appWith(db);
    const { body } = await req(app, "/today");
    const proposals = (body as Record<string, unknown>)["proposals"] as Array<Record<string, unknown>>;
    expect(proposals[0]!["decision_instance_id"]).toBe(42);
  });

  test("caller_person_id resolved from header", async () => {
    const db = openDb();
    db.run("INSERT INTO people (full_name, email, created_at, updated_at) VALUES (?, ?, ?, ?)", ["Alice", "alice@example.com", new Date().toISOString(), new Date().toISOString()]);
    const row = db.query<{ id: number }, []>("SELECT id FROM people WHERE email = 'alice@example.com'").get();
    const app = appWith(db);
    const { body } = await req(app, "/today", { headers: { "x-caller-email": "alice@example.com" } });
    expect((body as Record<string, unknown>)["caller_person_id"]).toBe(row!.id);
  });

  test("caller_person_id null for unmatched header", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body } = await req(app, "/today", { headers: { "x-caller-email": "stranger@example.com" } });
    expect((body as Record<string, unknown>)["caller_person_id"]).toBeNull();
  });
});

// ── GET /today/activity ────────────────────────────────────────────────

describe("GET /today/activity", () => {
  test("empty store returns empty items", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/today/activity");
    expect(res.status).toBe(200);
    expect((body as Record<string, unknown>)["items"]).toEqual([]);
  });

  test("limit clamped to [1, 100]", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/today/activity?limit=0");
    expect(res.status).toBe(400);
    const { res: res2 } = await req(app, "/today/activity?limit=101");
    expect(res2.status).toBe(400);
  });

  test("includes audit log entries", async () => {
    const db = openDb();
    // Seed a briefing narrative so watermark is set, then add audit entry after it.
    const now = new Date();
    const past = new Date(now.getTime() - 1000).toISOString();
    db.run("INSERT INTO briefing_narrative (scope, input_hash, narrative_text, generated_at) VALUES (?, '0', 'x', ?)", ["principal_brief_morning", past]);
    db.run("INSERT INTO audit_log (ts, event_type, summary) VALUES (?, 'tool_invocation', 'Did something')", [new Date().toISOString()]);
    const app = appWith(db);
    const { body } = await req(app, "/today/activity");
    const items = (body as Record<string, unknown>)["items"] as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((i) => i["summary"] === "Did something")).toBe(true);
  });
});

// ── GET /today/activity/daily ──────────────────────────────────────────

describe("GET /today/activity/daily", () => {
  test("returns dense per-day counts", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/today/activity/daily?days=3");
    expect(res.status).toBe(200);
    const days = (body as Record<string, unknown>)["days"] as Array<Record<string, unknown>>;
    expect(days).toHaveLength(3);
    for (const d of days) {
      expect(typeof d["date"]).toBe("string");
      expect(typeof d["count"]).toBe("number");
    }
  });

  test("days clamped to [1, 365]", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/today/activity/daily?days=0");
    expect(res.status).toBe(400);
    const { res: res2 } = await req(app, "/today/activity/daily?days=366");
    expect(res2.status).toBe(400);
  });
});

// ── GET /morning-brief (deprecated alias) ───────────────────────────────

describe("GET /morning-brief", () => {
  test("returns same body as /today with deprecation headers", async () => {
    const db = openDb();
    const { seedDefaultDepartments } = await import("../departments/departments.ts");
    seedDefaultDepartments(db);
    const app = appWith(db);
    const { body: todayBody } = await req(app, "/today");
    const { res, body } = await req(app, "/morning-brief");
    expect(res.status).toBe(200);
    expect(res.headers.get("deprecation")).toBe("true");
    expect(res.headers.get("link")).toContain("/today");
    expect(body).toEqual(todayBody);
  });
});
