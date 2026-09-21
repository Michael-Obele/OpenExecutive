import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
function fakeProvider(): Provider { return { name: "fake", defaultModel: "fake-model", async chat() { return "ok"; } }; }
function fakeSettings(): Settings { return { dbPath: ":memory:", port: 8787, publicServerUrl: "", allowedOrigins: [], morningBriefTime: "08:00", scheduledAdminToken: "", provider: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-chat", reasoningModel: "deepseek-reasoner", routingModel: "deepseek-chat", headers: {} } }; }
function appWith(db: ReturnType<typeof openDb>) { return createApp({ settings: fakeSettings(), db, provider: fakeProvider() }); }
async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) { const res = await app(new Request(`http://localhost${path}`, init)); const body: unknown = await res.json().catch(() => null); return { res, body }; }

describe("architecture", () => {
  test("list sections", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/architecture/sections");
    expect(res.status).toBe(200);
    expect(((body as { sections: unknown[] }).sections).length).toBeGreaterThan(0);
  });
  test("get section", async () => {
    const db = openDb(); const app = appWith(db);
    const { body } = await req(app, "/architecture/sections/overview");
    expect((body as { section_id: string }).section_id).toBe("overview");
  });
  test("404 for unknown section", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/architecture/sections/does-not-exist-xyz");
    expect(res.status).toBe(404);
  });
});

describe("guide", () => {
  test("list guide sections", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/guide/sections");
    expect(res.status).toBe(200);
    expect(((body as { sections: unknown[] }).sections).length).toBeGreaterThan(0);
  });
  test("get guide section", async () => {
    const db = openDb(); const app = appWith(db);
    const { body } = await req(app, "/guide/sections/chat");
    expect((body as { section_id: string }).section_id).toBe("chat");
  });
  test("404 for unknown guide section", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/guide/sections/does-not-exist-xyz");
    expect(res.status).toBe(404);
  });
});

describe("health", () => {
  test("GET /health", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/health");
    expect(res.status).toBe(200);
    expect((body as { status: string }).status).toBe("ok");
  });
  test("GET /health/honcho", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/health/honcho");
    expect(res.status).toBe(200);
    expect((body as { status: string }).status).toBe("disabled");
  });
});
