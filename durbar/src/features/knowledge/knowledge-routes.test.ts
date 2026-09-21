/**
 * Spec for knowledge routes — builtin, search, failures, external.
 *
 * Ported from `tests/unit/test_knowledge_search_and_failures.py`:
 * search partitioning, specialist filtering, include filter, failures CRUD.
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

// ── GET /knowledge/builtin ─────────────────────────────────────────────

describe("GET /knowledge/builtin", () => {
  test("returns files", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/knowledge/builtin");
    expect(res.status).toBe(200);
    const files = (body as Record<string, unknown>)["files"] as unknown[];
    expect(files.length).toBeGreaterThan(0);
  });
});

// ── POST /knowledge/search ─────────────────────────────────────────────

describe("POST /knowledge/search", () => {
  test("rejects empty query", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/knowledge/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "   " }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects unknown specialist", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/knowledge/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "pricing", specialist: "ghost" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid include", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/knowledge/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x", include: ["bogus"] }),
    });
    expect(res.status).toBe(400);
  });

  test("specialist filters to domains", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/knowledge/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "pricing", specialist: "cfo" }),
    });
    expect(res.status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data["effective_domains"]).toEqual(["finance"]);
    expect((data["specialists_that_would_see_this"] as string[])).toContain("cfo");
  });

  test("include filter skips collections", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/knowledge/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "strategy", include: ["failures"] }),
    });
    expect(res.status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(data["builtin"]).toEqual([]);
    expect(data["company"]).toEqual([]);
  });

  test("accepts general domain", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/knowledge/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "pricing", domain_filter: ["general"] }),
    });
    expect(res.status).toBe(200);
  });

  test("rejects unknown domain", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/knowledge/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "pricing", domain_filter: ["finanace"] }),
    });
    expect(res.status).toBe(400);
  });
});

// ── GET /knowledge/failures ────────────────────────────────────────────

describe("GET /knowledge/failures", () => {
  test("returns files", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/knowledge/failures");
    expect(res.status).toBe(200);
    const files = (body as Record<string, unknown>)["files"] as unknown[];
    expect(files.length).toBeGreaterThan(0);
  });
});

// ── GET /knowledge/external ────────────────────────────────────────────

describe("GET /knowledge/external", () => {
  test("returns sources", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/knowledge/external");
    expect(res.status).toBe(200);
    expect(Array.isArray((body as Record<string, unknown>)["sources"])).toBe(true);
  });
});
