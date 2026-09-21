import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
function fakeProvider(): Provider { return { name: "fake", defaultModel: "fake-model", async chat() { return "ok"; } }; }
function fakeSettings(): Settings { return { dbPath: ":memory:", port: 8787, publicServerUrl: "", allowedOrigins: [], morningBriefTime: "08:00", scheduledAdminToken: "", provider: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-chat", reasoningModel: "deepseek-reasoner", routingModel: "deepseek-chat", headers: {} } }; }
function appWith(db: ReturnType<typeof openDb>) { return createApp({ settings: fakeSettings(), db, provider: fakeProvider() }); }
async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) { const res = await app(new Request(`http://localhost${path}`, init)); const body: unknown = await res.json().catch(() => null); return { res, body }; }

describe("evals", () => {
  test("list scenarios empty", async () => {
    const db = openDb(); const app = appWith(db);
    const { body } = await req(app, "/evals/scenarios");
    expect((body as { total: number }).total).toBe(0);
  });
  test("create scenario", async () => {
    const db = openDb(); const app = appWith(db);
    const yaml = "id: test_001\nkind: chat\ndescription: test";
    const { res, body } = await req(app, "/evals/scenarios", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ yaml }) });
    expect(res.status).toBe(200);
    expect((body as { id: string }).id).toBe("test_001");
  });
  test("get scenario", async () => {
    const db = openDb(); const app = appWith(db);
    const yaml = "id: get_test\nkind: chat\ndescription: test";
    await req(app, "/evals/scenarios", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ yaml }) });
    const { body } = await req(app, "/evals/scenarios/get_test");
    expect((body as { id: string }).id).toBe("get_test");
  });
  test("404 for unknown scenario", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/evals/scenarios/nope");
    expect(res.status).toBe(404);
  });
  test("create run", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/evals/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "chat" }) });
    expect(res.status).toBe(201);
    expect((body as { run_id: string }).run_id).toBeDefined();
  });
  test("list runs", async () => {
    const db = openDb(); const app = appWith(db);
    await req(app, "/evals/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "chat" }) });
    const { body } = await req(app, "/evals/runs");
    expect(((body as { runs: unknown[] }).runs).length).toBeGreaterThan(0);
  });
  test("get run", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: created } = await req(app, "/evals/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "chat" }) });
    const rid = (created as { run_id: string }).run_id;
    const { body } = await req(app, `/evals/runs/${rid}`);
    expect((body as { run_id: string }).run_id).toBe(rid);
  });
  test("delete run", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: created } = await req(app, "/evals/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "chat" }) });
    const rid = (created as { run_id: string }).run_id;
    const { res } = await req(app, `/evals/runs/${rid}`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});
