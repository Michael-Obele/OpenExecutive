/**
 * Spec for documents — CRUD, domain validation, filename guards.
 *
 * Ported from `tests/unit/test_documents_upload.py`: domain from form field,
 * defaults to general, get/delete, reupload upsert, unknown domain rejected.
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

async function uploadJson(app: ReturnType<typeof createApp>, filename: string, domain = "general", content = "# Plan\nGrow revenue 30%.") {
  return req(app, "/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename, domain, content }),
  });
}

// ── POST /documents ────────────────────────────────────────────────────

describe("POST /documents", () => {
  test("creates a document", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await uploadJson(app, "plan.md", "finance");
    expect(res.status).toBe(200);
    expect((body as Record<string, unknown>)["domain"]).toBe("finance");
    expect((body as Record<string, unknown>)["status"]).toBe("indexed");
  });

  test("defaults domain to general", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "plan.md", content: "hello" }),
    });
    expect(res.status).toBe(200);
    expect((body as Record<string, unknown>)["domain"]).toBe("general");
  });

  test("reupload upserts (same filename, no duplicate)", async () => {
    const db = openDb();
    const app = appWith(db);
    await uploadJson(app, "plan.md", "finance", "v1");
    await uploadJson(app, "plan.md", "finance", "v2");
    const { body } = await req(app, "/documents");
    const docs = (body as Record<string, unknown>)["documents"] as unknown[];
    expect(docs.length).toBe(1);
  });

  test("unknown domain rejected", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await uploadJson(app, "plan.md", "finanace");
    expect(res.status).toBe(400);
  });

  test("unsupported extension rejected", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await uploadJson(app, "plan.exe", "general");
    expect(res.status).toBe(400);
  });

  test("multipart upload honored", async () => {
    const db = openDb();
    const app = appWith(db);
    const form = new FormData();
    form.set("file", new File(["# Plan\nGrow"], "plan.md", { type: "text/markdown" }));
    form.set("domain", "finance");
    const res = await app(new Request("http://localhost/documents", { method: "POST", body: form }));
    const body: unknown = await res.json().catch(() => null);
    expect(res.status).toBe(200);
    expect((body as Record<string, unknown>)["domain"]).toBe("finance");
  });
});

// ── GET /documents ─────────────────────────────────────────────────────

describe("GET /documents", () => {
  test("lists documents", async () => {
    const db = openDb();
    const app = appWith(db);
    await uploadJson(app, "plan.md");
    await uploadJson(app, "other.md");
    const { body } = await req(app, "/documents");
    const docs = (body as Record<string, unknown>)["documents"] as Array<Record<string, unknown>>;
    expect(docs.length).toBe(2);
  });

  test("empty when none", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body } = await req(app, "/documents");
    expect(((body as Record<string, unknown>)["documents"] as unknown[]).length).toBe(0);
  });
});

// ── GET /documents/{filename} ──────────────────────────────────────────

describe("GET /documents/{filename}", () => {
  test("returns content", async () => {
    const db = openDb();
    const app = appWith(db);
    await uploadJson(app, "plan.md", "general", "# Plan\nGrow revenue 30%.");
    const { res, body } = await req(app, "/documents/plan.md");
    expect(res.status).toBe(200);
    expect((body as Record<string, unknown>)["content"]).toContain("Grow revenue 30%.");
  });

  test("404 for missing document", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/documents/missing.md");
    expect(res.status).toBe(404);
  });

  test("400 for dotfile", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/documents/.env");
    expect(res.status).toBe(400);
  });
});

// ── DELETE /documents/{filename} ───────────────────────────────────────

describe("DELETE /documents/{filename}", () => {
  test("deletes a document", async () => {
    const db = openDb();
    const app = appWith(db);
    await uploadJson(app, "plan.md");
    const { res, body } = await req(app, "/documents/plan.md", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((body as Record<string, unknown>)["deleted"]).toBe("plan.md");
    const { body: listBody } = await req(app, "/documents");
    expect(((listBody as Record<string, unknown>)["documents"] as unknown[]).length).toBe(0);
  });

  test("404 for missing document", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/documents/missing.md", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("leaves other documents", async () => {
    const db = openDb();
    const app = appWith(db);
    await uploadJson(app, "plan.md");
    await uploadJson(app, "other.md");
    await req(app, "/documents/plan.md", { method: "DELETE" });
    const { body } = await req(app, "/documents");
    const docs = (body as Record<string, unknown>)["documents"] as Array<Record<string, unknown>>;
    expect(docs.length).toBe(1);
    expect(docs[0]!["filename"]).toBe("other.md");
  });
});
