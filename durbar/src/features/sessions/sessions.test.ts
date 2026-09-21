/**
 * Spec for sessions.
 *
 * Ported from `api/routes/sessions.py` + `memory/session_store.py`:
 * list, get, messages, delete, 404s. Uses the HTTP layer end-to-end.
 * Durbar returns all sessions (no auth scoping yet) — noted for multiuser.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp, type AppContext } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
import { createSession, saveMessage } from "./sessions.ts";

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
    eodDigestTime: "18:00",
    reflectionTime: "07:30",
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

// ── GET /sessions ──────────────────────────────────────────────────────

describe("GET /sessions", () => {
  test("empty when no sessions", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/sessions");
    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  test("lists sessions newest first", async () => {
    const db = openDb();
    const app = appWith(db);
    createSession(db, { session_id: "sess-1", title: "First" });
    // Ensure second has later updated_at.
    await new Promise((r) => setTimeout(r, 10));
    createSession(db, { session_id: "sess-2", title: "Second" });

    const { body } = await req(app, "/sessions");
    const list = body as Array<{ session_id: string }>;
    expect(list).toHaveLength(2);
    // Newest first — sess-2 should be first.
    expect(list[0]!.session_id).toBe("sess-2");
  });

  test("includes message_count", async () => {
    const db = openDb();
    const app = appWith(db);
    createSession(db, { session_id: "sess-1", title: "Chat" });
    saveMessage(db, "sess-1", "user", "hello");
    saveMessage(db, "sess-1", "assistant", "hi there");

    const { body } = await req(app, "/sessions");
    const list = body as Array<{ message_count: number }>;
    expect(list[0]!.message_count).toBe(2);
  });
});

// ── GET /sessions/{id} ─────────────────────────────────────────────────

describe("GET /sessions/{id}", () => {
  test("returns a session", async () => {
    const db = openDb();
    const app = appWith(db);
    createSession(db, { session_id: "sess-1", title: "My Chat" });

    const { res, body } = await req(app, "/sessions/sess-1");
    expect(res.status).toBe(200);
    expect((body as { session_id: string }).session_id).toBe("sess-1");
    expect((body as { title: string }).title).toBe("My Chat");
  });

  test("404 for unknown session", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/sessions/does-not-exist");
    expect(res.status).toBe(404);
  });

  test("includes message_count", async () => {
    const db = openDb();
    const app = appWith(db);
    createSession(db, { session_id: "sess-1", title: "Chat" });
    saveMessage(db, "sess-1", "user", "hello");

    const { body } = await req(app, "/sessions/sess-1");
    expect((body as { message_count: number }).message_count).toBe(1);
  });
});

// ── GET /sessions/{id}/messages ────────────────────────────────────────

describe("GET /sessions/{id}/messages", () => {
  test("returns messages in order", async () => {
    const db = openDb();
    const app = appWith(db);
    createSession(db, { session_id: "sess-1", title: "Chat" });
    saveMessage(db, "sess-1", "user", "hello");
    saveMessage(db, "sess-1", "assistant", "hi");

    const { res, body } = await req(app, "/sessions/sess-1/messages");
    expect(res.status).toBe(200);
    const msgs = body as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toBe("hello");
    expect(msgs[1]!.role).toBe("assistant");
  });

  test("empty when no messages", async () => {
    const db = openDb();
    const app = appWith(db);
    createSession(db, { session_id: "sess-1", title: "Chat" });

    const { body } = await req(app, "/sessions/sess-1/messages");
    expect(body).toEqual([]);
  });

  test("404 for unknown session", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/sessions/unknown/messages");
    expect(res.status).toBe(404);
  });

  test("restores action_chips as actions", async () => {
    const db = openDb();
    const app = appWith(db);
    createSession(db, { session_id: "sess-1", title: "Chat" });
    saveMessage(db, "sess-1", "assistant", "did a thing", JSON.stringify([{ tool: "test" }]));

    const { body } = await req(app, "/sessions/sess-1/messages");
    const msgs = body as Array<{ actions?: unknown }>;
    expect(msgs[0]!.actions).toEqual([{ tool: "test" }]);
  });
});

// ── DELETE /sessions/{id} ──────────────────────────────────────────────

describe("DELETE /sessions/{id}", () => {
  test("deletes a session and its messages", async () => {
    const db = openDb();
    const app = appWith(db);
    createSession(db, { session_id: "sess-1", title: "Chat" });
    saveMessage(db, "sess-1", "user", "hello");

    const { res } = await req(app, "/sessions/sess-1", { method: "DELETE" });
    expect(res.status).toBe(204);

    const { res: getRes } = await req(app, "/sessions/sess-1");
    expect(getRes.status).toBe(404);

    const { res: msgRes } = await req(app, "/sessions/sess-1/messages");
    expect(msgRes.status).toBe(404);
  });

  test("404 for unknown session", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/sessions/unknown", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
