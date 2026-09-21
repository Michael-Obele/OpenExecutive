import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
function fakeProvider(): Provider { return { name: "fake", defaultModel: "fake-model", async chat() { return "ok"; } }; }
function fakeSettings(): Settings { return { dbPath: ":memory:", port: 8787, publicServerUrl: "", allowedOrigins: [], morningBriefTime: "08:00", scheduledAdminToken: "", provider: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-chat", reasoningModel: "deepseek-reasoner", routingModel: "deepseek-chat", headers: {} } }; }
function appWith(db: ReturnType<typeof openDb>) { return createApp({ settings: fakeSettings(), db, provider: fakeProvider() }); }
async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) { const res = await app(new Request(`http://localhost${path}`, init)); const body: unknown = await res.json().catch(() => null); return { res, body }; }

describe("agents", () => {
  test("list agents", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/agents");
    expect(res.status).toBe(200);
    expect((body as unknown[]).length).toBeGreaterThan(5);
  });
  test("get agent detail", async () => {
    const db = openDb(); const app = appWith(db);
    const { body } = await req(app, "/agents/cfo");
    expect((body as { name: string }).name).toBe("cfo");
  });
  test("404 for unknown agent", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/agents/unknown_agent_xyz");
    expect(res.status).toBe(404);
  });
  test("override and clear", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: patched } = await req(app, "/agents/cfo/override", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "Custom CFO" }) });
    expect((patched as { role: string }).role).toBe("Custom CFO");
    const { res } = await req(app, "/agents/cfo/override", { method: "DELETE" });
    expect(res.status).toBe(204);
    const { body: after } = await req(app, "/agents/cfo");
    expect((after as { has_override: boolean }).has_override).toBe(false);
  });
  test("history", async () => {
    const db = openDb(); const app = appWith(db);
    await req(app, "/agents/cfo/override", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "V1" }) });
    await req(app, "/agents/cfo/override", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "V2" }) });
    const { body } = await req(app, "/agents/cfo/history");
    expect((body as unknown[]).length).toBeGreaterThan(0);
  });
  test("models list", async () => {
    const db = openDb(); const app = appWith(db);
    const { body } = await req(app, "/agents/models");
    expect(Array.isArray(body)).toBe(true);
  });
  test("test agent", async () => {
    const db = openDb(); const app = appWith(db);
    const { body } = await req(app, "/agents/cfo/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "What is EBITDA?" }) });
    expect((body as { response: string }).response).toContain("cfo");
  });
});
