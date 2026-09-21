/**
 * Spec for chat — SSE streaming, upload, suggested prompts.
 *
 * Ported from `tests/unit/test_chat_route_*.py`: streaming contract,
 * session persistence, upload validation, suggested prompts fallback.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";

function fakeProvider(reply = "Hello from the Executive."): Provider {
  return { name: "fake", defaultModel: "fake-model", async chat() { return reply; } };
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

function appWith(db: ReturnType<typeof openDb>, provider?: Provider) {
  return createApp({ settings: fakeSettings(), db, provider: provider ?? fakeProvider() });
}

async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app(new Request(`http://localhost${path}`, init));
  const body: unknown = await res.json().catch(() => null);
  return { res, body };
}

// ── POST /chat ─────────────────────────────────────────────────────────

describe("POST /chat", () => {
  test("streams SSE events", async () => {
    const db = openDb();
    const app = appWith(db);
    const res = await app(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain('"type":"chunk"');
    expect(text).toContain('"type":"done"');
  });

  test("400 when message missing", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("persists session and messages", async () => {
    const db = openDb();
    const app = appWith(db);
    const res = await app(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      }),
    );
    // Drain stream.
    await res.text();
    const sessions = db.query<{ session_id: string }, []>("SELECT session_id FROM sessions").all();
    expect(sessions.length).toBe(1);
    const msgs = db.query<{ role: string; content: string }, [string]>("SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id").all(sessions[0]!.session_id);
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[1]!.role).toBe("assistant");
  });

  test("reuses session_id when provided", async () => {
    const db = openDb();
    const app = appWith(db);
    const sid = "test-session-123";
    // First turn creates session.
    const res1 = await app(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "First", session_id: sid }),
      }),
    );
    await res1.text();
    // Second turn reuses it.
    const res2 = await app(
      new Request("http://localhost/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Second", session_id: sid }),
      }),
    );
    await res2.text();
    const sessions = db.query<{ session_id: string }, []>("SELECT session_id FROM sessions").all();
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.session_id).toBe(sid);
  });
});

// ── POST /chat/upload ──────────────────────────────────────────────────

describe("POST /chat/upload", () => {
  test("400 when no files", async () => {
    const db = openDb();
    const app = appWith(db);
    const form = new FormData();
    form.set("message", "Hello");
    const { res } = await req(app, "/chat/upload", { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  test("streams with file attachment", async () => {
    const db = openDb();
    const app = appWith(db);
    const form = new FormData();
    form.set("message", "Summarize this");
    form.set("file", new File(["# Notes\nSome content"], "notes.md", { type: "text/markdown" }));
    const res = await app(new Request("http://localhost/chat/upload", { method: "POST", body: form }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"type":"done"');
  });
});

// ── GET /chat/suggested-prompts ────────────────────────────────────────

describe("GET /chat/suggested-prompts", () => {
  test("returns fallback when no profile or sessions", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/chat/suggested-prompts");
    expect(res.status).toBe(200);
    const data = body as Record<string, unknown>;
    expect(Array.isArray(data["prompts"])).toBe(true);
    expect((data["prompts"] as unknown[]).length).toBe(4);
    expect(typeof data["subtitle"]).toBe("string");
    expect(data["context_quality"]).toBe("empty");
  });

  test("returns prompts with profile", async () => {
    const db = openDb();
    db.run("INSERT INTO company_profile (id, data, updated_at) VALUES (1, ?, ?)", [JSON.stringify({ name: "Acme", industry: "SaaS" }), new Date().toISOString()]);
    const app = appWith(db);
    const { body } = await req(app, "/chat/suggested-prompts");
    const data = body as Record<string, unknown>;
    expect(data["context_quality"]).toBe("thin");
    expect((data["prompts"] as unknown[]).length).toBe(4);
  });
});
