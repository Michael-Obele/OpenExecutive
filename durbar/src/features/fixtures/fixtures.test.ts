import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
function fakeProvider(): Provider { return { name: "fake", defaultModel: "fake-model", async chat() { return "ok"; } }; }
function fakeSettings(): Settings { return { dbPath: ":memory:", port: 8787, publicServerUrl: "", allowedOrigins: [], morningBriefTime: "08:00", eodDigestTime: "18:00", reflectionTime: "07:30", scheduledAdminToken: "", provider: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-chat", reasoningModel: "deepseek-reasoner", routingModel: "deepseek-chat", headers: {} } }; }
function appWith(db: ReturnType<typeof openDb>) { return createApp({ settings: fakeSettings(), db, provider: fakeProvider() }); }
async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) { const res = await app(new Request(`http://localhost${path}`, init)); const body: unknown = await res.json().catch(() => null); return { res, body }; }

describe("fixtures", () => {
  test("list fixtures", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/fixtures");
    expect(res.status).toBe(200);
    expect((body as { fixtures: unknown[] }).fixtures).toBeDefined();
  });
  test("status", async () => {
    const db = openDb(); const app = appWith(db);
    const { body } = await req(app, "/fixtures/status");
    expect((body as { active_fixture: unknown }).active_fixture).toBeNull();
  });
  test("generate requires description", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/fixtures/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });
  test("create generated fixture", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/fixtures", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle: { profile: { name: "Test Fixture Co" } } }) });
    expect(res.status).toBe(200);
    expect((body as { name: string }).name).toBeDefined();
  });
  test("load unknown fixture 404", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/fixtures/does-not-exist-xyz/load", { method: "POST" });
    expect(res.status).toBe(404);
  });
  test("invalid fixture name 400", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/fixtures/BadName!/load", { method: "POST" });
    expect(res.status).toBe(400);
  });
});
