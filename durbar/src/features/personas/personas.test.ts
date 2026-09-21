import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
function fakeProvider(): Provider { return { name: "fake", defaultModel: "fake-model", async chat() { return "ok"; } }; }
function fakeSettings(): Settings { return { dbPath: ":memory:", port: 8787, publicServerUrl: "", allowedOrigins: [], morningBriefTime: "08:00", eodDigestTime: "18:00", reflectionTime: "07:30", scheduledAdminToken: "", provider: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-chat", reasoningModel: "deepseek-reasoner", routingModel: "deepseek-chat", headers: {} } }; }
function appWith(db: ReturnType<typeof openDb>) { return createApp({ settings: fakeSettings(), db, provider: fakeProvider() }); }
async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) { const res = await app(new Request(`http://localhost${path}`, init)); const body: unknown = await res.json().catch(() => null); return { res, body }; }

describe("personas", () => {
  test("list personas", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/personas");
    expect(res.status).toBe(200);
    expect((body as unknown[]).length).toBeGreaterThan(0);
  });
  test("get persona", async () => {
    const db = openDb(); const app = appWith(db);
    const { body } = await req(app, "/personas/default");
    expect((body as { slug: string }).slug).toBe("default");
  });
  test("404 for unknown persona", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/personas/does-not-exist-xyz");
    expect(res.status).toBe(404);
  });
  test("create custom persona", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/personas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: "My Persona", body: "Custom body" }) });
    expect(res.status).toBe(201);
    expect((body as { display_name: string }).display_name).toBe("My Persona");
  });
  test("upsert persona", async () => {
    const db = openDb(); const app = appWith(db);
    const { body } = await req(app, "/personas/custom-test", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: "Custom Test", body: "Hello" }) });
    expect((body as { slug: string }).slug).toBe("custom-test");
  });
  test("reset builtin", async () => {
    const db = openDb(); const app = appWith(db);
    await req(app, "/personas/default", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: "Default", body: "Modified" }) });
    const { body } = await req(app, "/personas/default/reset", { method: "POST" });
    expect((body as { slug: string }).slug).toBe("default");
  });
  test("delete custom persona", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: created } = await req(app, "/personas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: "Delete Me Persona", body: "Body" }) });
    const slug = (created as { slug: string }).slug;
    const { res } = await req(app, `/personas/${slug}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });
  test("cannot delete builtin", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/personas/default", { method: "DELETE" });
    expect(res.status).toBe(400);
  });
});
