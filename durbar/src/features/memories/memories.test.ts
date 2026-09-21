/**
 * Spec for memories.
 *
 * Ported from `api/routes/episodic.py` + `memory/episodic.py`:
 * list, patch, delete for decisions / initiatives / advice.
 * Uses the HTTP layer so the contract is exercised end-to-end.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp, type AppContext } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
import { insertAdvice, insertDecision, insertInitiative } from "./memories.ts";

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

// ── decisions ──────────────────────────────────────────────────────────

describe("GET /memories/decisions", () => {
  test("empty when none", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/memories/decisions");
    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  test("lists decisions", async () => {
    const db = openDb();
    const app = appWith(db);
    insertDecision(db, { domain: "finance", summary: "We decided X" });
    insertDecision(db, { domain: "hr", summary: "We decided Y" });
    const { body } = await req(app, "/memories/decisions");
    expect((body as unknown[]).length).toBe(2);
  });
});

describe("PATCH /memories/decisions/{id}", () => {
  test("patches a decision", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertDecision(db, { domain: "finance", summary: "old" });
    const { res, body } = await req(app, `/memories/decisions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: "new summary" }),
    });
    expect(res.status).toBe(200);
    expect((body as { summary: string }).summary).toBe("new summary");
  });

  test("patches multiple fields", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertDecision(db, { domain: "finance", summary: "old", rationale: "old rationale" });
    const { body } = await req(app, `/memories/decisions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: "new", rationale: "new rationale", outcome: "done" }),
    });
    expect((body as { summary: string }).summary).toBe("new");
    expect((body as { rationale: string }).rationale).toBe("new rationale");
    expect((body as { outcome: string }).outcome).toBe("done");
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/memories/decisions/9999", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: "x" }),
    });
    expect(res.status).toBe(404);
  });

  test("422 for non-string field", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertDecision(db, { domain: "finance", summary: "old" });
    const { res } = await req(app, `/memories/decisions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: 123 }),
    });
    expect(res.status).toBe(422);
  });

  test("empty patch returns existing", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertDecision(db, { domain: "finance", summary: "keep" });
    const { res, body } = await req(app, `/memories/decisions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((body as { summary: string }).summary).toBe("keep");
  });
});

describe("DELETE /memories/decisions/{id}", () => {
  test("deletes a decision", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertDecision(db, { domain: "finance", summary: "to delete" });
    const { res } = await req(app, `/memories/decisions/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    const { body } = await req(app, "/memories/decisions");
    expect((body as unknown[]).length).toBe(0);
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/memories/decisions/9999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ── initiatives ────────────────────────────────────────────────────────

describe("GET /memories/initiatives", () => {
  test("lists initiatives", async () => {
    const db = openDb();
    const app = appWith(db);
    insertInitiative(db, { title: "Launch X", status: "active" });
    const { body } = await req(app, "/memories/initiatives");
    expect((body as unknown[]).length).toBe(1);
  });
});

describe("PATCH /memories/initiatives/{id}", () => {
  test("patches an initiative", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertInitiative(db, { title: "Old Title", status: "active" });
    const { res, body } = await req(app, `/memories/initiatives/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New Title", status: "completed" }),
    });
    expect(res.status).toBe(200);
    expect((body as { title: string }).title).toBe("New Title");
    expect((body as { status: string }).status).toBe("completed");
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/memories/initiatives/9999", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /memories/initiatives/{id}", () => {
  test("deletes an initiative", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertInitiative(db, { title: "To Delete", status: "active" });
    const { res } = await req(app, `/memories/initiatives/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/memories/initiatives/9999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ── advice ─────────────────────────────────────────────────────────────

describe("GET /memories/advice", () => {
  test("lists advice", async () => {
    const db = openDb();
    const app = appWith(db);
    insertAdvice(db, { domain: "finance", query_summary: "Q", advice_summary: "A" });
    const { body } = await req(app, "/memories/advice");
    expect((body as unknown[]).length).toBe(1);
  });
});

describe("PATCH /memories/advice/{id}", () => {
  test("patches advice", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertAdvice(db, { domain: "finance", query_summary: "Q", advice_summary: "old" });
    const { res, body } = await req(app, `/memories/advice/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ advice_summary: "new advice" }),
    });
    expect(res.status).toBe(200);
    expect((body as { advice_summary: string }).advice_summary).toBe("new advice");
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/memories/advice/9999", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ advice_summary: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /memories/advice/{id}", () => {
  test("deletes advice", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertAdvice(db, { domain: "finance", query_summary: "Q", advice_summary: "A" });
    const { res } = await req(app, `/memories/advice/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/memories/advice/9999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
