/**
 * Spec for review queue — items, stats, annotations.
 *
 * Mirrors `api/routes/review.py` contract: list/get/patch, bulk-approve,
 * annotation CRUD, validation, 404s.
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

function seedItem(db: Db, itemId = "builtin:finance:test.md", status = "pending", domain = "finance"): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO review_items (item_id, content_type, domain, filename, status, priority, registered_at, last_modified_at)
     VALUES (?, 'builtin', ?, 'test.md', ?, 'normal', ?, ?)`,
    [itemId, domain, status, now, now],
  );
}

describe("GET /review/items", () => {
  test("returns empty when no items", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/review/items");
    expect(res.status).toBe(200);
    expect(body as unknown[]).toHaveLength(0);
  });

  test("lists items", async () => {
    const db = openDb();
    seedItem(db);
    const app = appWith(db);
    const { body } = await req(app, "/review/items");
    expect((body as unknown[]).length).toBe(1);
  });

  test("filters by status", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:a.md", "pending");
    seedItem(db, "builtin:finance:b.md", "approved");
    const app = appWith(db);
    const { body } = await req(app, "/review/items?status=approved");
    const rows = body as Array<{ status: string }>;
    expect(rows.every((r) => r.status === "approved")).toBe(true);
  });

  test("400 for invalid status", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/review/items?status=bogus");
    expect(res.status).toBe(400);
  });
});

describe("GET /review/items/{id}", () => {
  test("returns item with annotations", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:x.md");
    const app = appWith(db);
    const { res, body } = await req(app, "/review/items/builtin:finance:x.md");
    expect(res.status).toBe(200);
    const b = body as { item: { item_id: string }; annotations: unknown[] };
    expect(b.item.item_id).toBe("builtin:finance:x.md");
    expect(b.annotations).toHaveLength(0);
  });

  test("404 for unknown item", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/review/items/unknown:id");
    expect(res.status).toBe(404);
  });
});

describe("GET /review/stats", () => {
  test("returns counts by status", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:a.md", "pending");
    seedItem(db, "builtin:finance:b.md", "approved");
    const app = appWith(db);
    const { res, body } = await req(app, "/review/stats");
    expect(res.status).toBe(200);
    const stats = body as { pending: number; approved: number; total: number };
    expect(stats.pending).toBe(1);
    expect(stats.approved).toBe(1);
    expect(stats.total).toBe(2);
  });
});

describe("PATCH /review/items/{id}", () => {
  test("updates status", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:patch.md");
    const app = appWith(db);
    const { res, body } = await req(app, "/review/items/builtin:finance:patch.md", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(200);
    expect((body as { status: string }).status).toBe("approved");
  });

  test("updates priority", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:prio.md");
    const app = appWith(db);
    const { body } = await req(app, "/review/items/builtin:finance:prio.md", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: "high" }),
    });
    expect((body as { priority: string }).priority).toBe("high");
  });

  test("404 for unknown item", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/review/items/unknown:id", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(404);
  });

  test("400 for invalid status", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:bad.md");
    const app = appWith(db);
    const { res } = await req(app, "/review/items/builtin:finance:bad.md", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "bogus" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /review/bulk-approve", () => {
  test("approves all pending", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:a.md", "pending");
    seedItem(db, "builtin:finance:b.md", "pending");
    const app = appWith(db);
    const { body } = await req(app, "/review/bulk-approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect((body as { approved_count: number }).approved_count).toBe(2);
  });

  test("filters by domain", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:a.md", "pending", "finance");
    seedItem(db, "builtin:hr:b.md", "pending", "hr");
    const app = appWith(db);
    const { body } = await req(app, "/review/bulk-approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "finance" }),
    });
    expect((body as { approved_count: number }).approved_count).toBe(1);
  });
});

describe("annotations", () => {
  test("POST /review/items/{id}/annotations creates", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:annot.md");
    const app = appWith(db);
    const { res, body } = await req(app, "/review/items/builtin:finance:annot.md/annotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "fix this" }),
    });
    expect(res.status).toBe(200);
    expect((body as { correction: string }).correction).toBe("fix this");
  });

  test("POST 404 for unknown item", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/review/items/unknown:id/annotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "x" }),
    });
    expect(res.status).toBe(404);
  });

  test("POST 400 when correction missing", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:annot2.md");
    const app = appWith(db);
    const { res } = await req(app, "/review/items/builtin:finance:annot2.md/annotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("GET /review/items/{id}/annotations lists", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:list.md");
    const app = appWith(db);
    await req(app, "/review/items/builtin:finance:list.md/annotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "c1" }),
    });
    const { body } = await req(app, "/review/items/builtin:finance:list.md/annotations");
    expect((body as unknown[]).length).toBe(1);
  });

  test("GET /review/annotations lists all", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:all.md");
    const app = appWith(db);
    await req(app, "/review/items/builtin:finance:all.md/annotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "c1" }),
    });
    const { body } = await req(app, "/review/annotations");
    expect((body as unknown[]).length).toBe(1);
  });

  test("PATCH /review/annotations/{id} updates", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:patch_annot.md");
    const app = appWith(db);
    const { body: created } = await req(app, "/review/items/builtin:finance:patch_annot.md/annotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "orig" }),
    });
    const annotId = (created as { annotation_id: string }).annotation_id;
    const { res, body } = await req(app, `/review/annotations/${annotId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "updated" }),
    });
    expect(res.status).toBe(200);
    expect((body as { updated: string }).updated).toBe(annotId);
  });

  test("DELETE /review/annotations/{id} deletes", async () => {
    const db = openDb();
    seedItem(db, "builtin:finance:del.md");
    const app = appWith(db);
    const { body: created } = await req(app, "/review/items/builtin:finance:del.md/annotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correction: "to delete" }),
    });
    const annotId = (created as { annotation_id: string }).annotation_id;
    const { res } = await req(app, `/review/annotations/${annotId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});
