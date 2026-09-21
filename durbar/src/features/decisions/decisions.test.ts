/**
 * Spec for decisions — list, get, approve, reject, reliability.
 *
 * Mirrors `api/routes/decisions.py` contract: filter, validation, 404s, 409s,
 * and reliability card.
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

function insertDecision(db: Db, overrides: Partial<{ decision_class: string; status: string }> = {}): number {
  const now = new Date().toISOString();
  const result = db.run(
    `INSERT INTO decision_instances (decision_class, created_at, proposed_payload_json, status)
     VALUES (?, ?, '{}', ?)`,
    [overrides.decision_class ?? "meeting_scheduling", now, overrides.status ?? "proposed"],
  );
  return Number(result.lastInsertRowid);
}

describe("GET /decisions", () => {
  test("returns decisions for the default class", async () => {
    const db = openDb();
    insertDecision(db);
    const app = appWith(db);
    const { res, body } = await req(app, "/decisions");
    expect(res.status).toBe(200);
    expect((body as unknown[]).length).toBe(1);
  });

  test("filters by status", async () => {
    const db = openDb();
    insertDecision(db, { status: "proposed" });
    insertDecision(db, { status: "approved_unchanged" });
    const app = appWith(db);
    const { body } = await req(app, "/decisions?status=proposed");
    const rows = body as Array<{ status: string }>;
    expect(rows.every((r) => r.status === "proposed")).toBe(true);
  });

  test("400 for invalid limit", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/decisions?limit=0");
    expect(res.status).toBe(400);
  });
});

describe("GET /decisions/{id}", () => {
  test("returns the instance", async () => {
    const db = openDb();
    const id = insertDecision(db);
    const app = appWith(db);
    const { res, body } = await req(app, `/decisions/${id}`);
    expect(res.status).toBe(200);
    expect((body as { id: number }).id).toBe(id);
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/decisions/99999");
    expect(res.status).toBe(404);
  });
});

describe("POST /decisions/{id}/approve", () => {
  test("approves a proposed decision", async () => {
    const db = openDb();
    const id = insertDecision(db, { status: "proposed" });
    const app = appWith(db);
    const { res, body } = await req(app, `/decisions/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((body as { status: string }).status).toBe("approved_unchanged");
  });

  test("approve with edits yields approved_with_edit", async () => {
    const db = openDb();
    const now = new Date().toISOString();
    const id = Number(
      db.run(
        `INSERT INTO decision_instances (decision_class, created_at, proposed_payload_json, status)
         VALUES ('meeting_scheduling', ?, ?, 'proposed')`,
        [now, JSON.stringify({ title: "Orig", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" })],
      ).lastInsertRowid,
    );
    const app = appWith(db);
    const { body } = await req(app, `/decisions/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edits: { title: "Edited" } }),
    });
    expect((body as { status: string }).status).toBe("approved_with_edit");
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/decisions/99999/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  test("409 when already resolved", async () => {
    const db = openDb();
    const id = insertDecision(db, { status: "approved_unchanged" });
    const app = appWith(db);
    const { res } = await req(app, `/decisions/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /decisions/{id}/reject", () => {
  test("rejects a proposed decision", async () => {
    const db = openDb();
    const id = insertDecision(db, { status: "proposed" });
    const app = appWith(db);
    const { res, body } = await req(app, `/decisions/${id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((body as { status: string }).status).toBe("rejected");
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/decisions/99999/reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  test("409 when already resolved", async () => {
    const db = openDb();
    const id = insertDecision(db, { status: "rejected" });
    const app = appWith(db);
    const { res } = await req(app, `/decisions/${id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });
});

describe("GET /audit/reliability", () => {
  test("returns a reliability card", async () => {
    const db = openDb();
    insertDecision(db, { status: "approved_unchanged" });
    insertDecision(db, { status: "rejected" });
    const app = appWith(db);
    const { res, body } = await req(app, "/audit/reliability?decision_class=meeting_scheduling&days=30");
    expect(res.status).toBe(200);
    const card = body as { volume: number; decision_class: string };
    expect(card.volume).toBe(2);
    expect(card.decision_class).toBe("meeting_scheduling");
  });

  test("400 for invalid days", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/audit/reliability?days=0");
    expect(res.status).toBe(400);
  });
});
