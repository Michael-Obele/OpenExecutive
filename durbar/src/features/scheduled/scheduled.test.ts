/**
 * Spec for scheduled actions — list, get, cancel with admin token logic.
 *
 * Mirrors `api/routes/scheduled.py` contract: filter by status, limit, order,
 * validation, 404s, and the admin token loopback gate.
 */

import { describe, expect, test } from "bun:test";
import { openDb, type Db } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";

function fakeProvider(): Provider {
  return { name: "fake", defaultModel: "fake-model", async chat() { return "ok"; } };
}

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
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
    ...overrides,
  };
}

function appWith(db: ReturnType<typeof openDb>, settingsOverrides: Partial<Settings> = {}) {
  return createApp({ settings: fakeSettings(settingsOverrides), db, provider: fakeProvider() });
}

async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app(new Request(`http://localhost${path}`, init));
  const body: unknown = await res.json().catch(() => null);
  return { res, body };
}

function insertScheduled(db: Db, overrides: Partial<{ run_at: string; status: string }> = {}): number {
  const now = new Date().toISOString();
  const runAt = overrides.run_at ?? "2026-09-21T00:00:00.000Z";
  const status = overrides.status ?? "pending";
  const result = db.run(
    `INSERT INTO scheduled_actions (created_at, run_at, channel, channel_ref, intent_text, status, attempts)
     VALUES (?, ?, 'test', 'ref', 'intent', ?, 0)`,
    [now, runAt, status],
  );
  return Number(result.lastInsertRowid);
}

describe("GET /scheduled", () => {
  test("returns pending by default", async () => {
    const db = openDb();
    insertScheduled(db, { status: "pending" });
    insertScheduled(db, { status: "done" });
    const app = appWith(db);
    const { res, body } = await req(app, "/scheduled");
    expect(res.status).toBe(200);
    const rows = body as Array<{ status: string }>;
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows).toHaveLength(1);
  });

  test("status=all returns all", async () => {
    const db = openDb();
    insertScheduled(db, { status: "pending" });
    insertScheduled(db, { status: "done" });
    const app = appWith(db);
    const { body } = await req(app, "/scheduled?status=all");
    expect((body as unknown[]).length).toBe(2);
  });

  test("400 for invalid status", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/scheduled?status=bogus");
    expect(res.status).toBe(400);
  });

  test("400 for invalid limit", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/scheduled?limit=0");
    expect(res.status).toBe(400);
  });

  test("400 for invalid order", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/scheduled?order=sideways");
    expect(res.status).toBe(400);
  });

  test("order=desc returns newest first", async () => {
    const db = openDb();
    insertScheduled(db, { run_at: "2026-01-01T00:00:00.000Z" });
    insertScheduled(db, { run_at: "2026-06-01T00:00:00.000Z" });
    const app = appWith(db);
    const { body } = await req(app, "/scheduled?status=all&order=desc");
    const rows = body as Array<{ run_at: string }>;
    expect(rows[0]?.run_at).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("GET /scheduled/{id}", () => {
  test("returns the action", async () => {
    const db = openDb();
    const id = insertScheduled(db);
    const app = appWith(db);
    const { res, body } = await req(app, `/scheduled/${id}`);
    expect(res.status).toBe(200);
    expect((body as { id: number }).id).toBe(id);
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/scheduled/99999");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /scheduled/{id}", () => {
  test("cancels a pending action (loopback, no token)", async () => {
    const db = openDb();
    const id = insertScheduled(db, { status: "pending" });
    const app = appWith(db);
    const { res, body } = await req(app, `/scheduled/${id}`, {
      method: "DELETE",
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(200);
    expect((body as { status: string }).status).toBe("cancelled");
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/scheduled/99999", {
      method: "DELETE",
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(404);
  });

  test("409 when not cancellable (already done)", async () => {
    const db = openDb();
    const id = insertScheduled(db, { status: "done" });
    const app = appWith(db);
    const { res } = await req(app, `/scheduled/${id}`, {
      method: "DELETE",
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    expect(res.status).toBe(409);
  });

  test("401 when token is required and missing", async () => {
    const db = openDb();
    const id = insertScheduled(db);
    const app = appWith(db, { scheduledAdminToken: "secret123" });
    const { res } = await req(app, `/scheduled/${id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  test("401 when token is wrong", async () => {
    const db = openDb();
    const id = insertScheduled(db);
    const app = appWith(db, { scheduledAdminToken: "secret123" });
    const { res } = await req(app, `/scheduled/${id}`, {
      method: "DELETE",
      headers: { "x-admin-token": "wrong" },
    });
    expect(res.status).toBe(401);
  });

  test("200 when token is correct", async () => {
    const db = openDb();
    const id = insertScheduled(db);
    const app = appWith(db, { scheduledAdminToken: "secret123" });
    const { res } = await req(app, `/scheduled/${id}`, {
      method: "DELETE",
      headers: { "x-admin-token": "secret123" },
    });
    expect(res.status).toBe(200);
  });

  test("503 for remote without token", async () => {
    const db = openDb();
    const id = insertScheduled(db);
    const app = appWith(db);
    // Simulate remote by setting X-Forwarded-For to a non-loopback IP.
    const { res } = await req(app, `/scheduled/${id}`, {
      method: "DELETE",
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(res.status).toBe(503);
  });

  test("503 when no X-Forwarded-For and no token (fail-closed)", async () => {
    const db = openDb();
    const id = insertScheduled(db);
    const app = appWith(db);
    const { res } = await req(app, `/scheduled/${id}`, { method: "DELETE" });
    expect(res.status).toBe(503);
  });

  test("handles comma-separated X-Forwarded-For taking first IP", async () => {
    const db = openDb();
    const id = insertScheduled(db);
    const app = appWith(db);
    const { res } = await req(app, `/scheduled/${id}`, {
      method: "DELETE",
      headers: { "x-forwarded-for": "127.0.0.1, 10.0.0.1" },
    });
    expect(res.status).toBe(200);
  });
});
