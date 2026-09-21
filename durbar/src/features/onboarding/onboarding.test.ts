import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
function fakeProvider(): Provider { return { name: "fake", defaultModel: "fake-model", async chat() { return "ok"; } }; }
function fakeSettings(): Settings { return { dbPath: ":memory:", port: 8787, publicServerUrl: "", allowedOrigins: [], morningBriefTime: "08:00", scheduledAdminToken: "", provider: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-chat", reasoningModel: "deepseek-reasoner", routingModel: "deepseek-chat", headers: {} } }; }
function appWith(db: ReturnType<typeof openDb>) { return createApp({ settings: fakeSettings(), db, provider: fakeProvider() }); }
async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) { const res = await app(new Request(`http://localhost${path}`, init)); const body: unknown = await res.json().catch(() => null); return { res, body }; }

describe("onboarding", () => {
  test("start creates session", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/onboard/start", { method: "POST" });
    expect(res.status).toBe(200);
    expect((body as { session_id: string }).session_id).toBeDefined();
    expect((body as { phase: string }).phase).toBe("question");
  });
  test("message advances session", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: started } = await req(app, "/onboard/start", { method: "POST" });
    const sid = (started as { session_id: string }).session_id;
    const { body } = await req(app, "/onboard/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid, message: "We are a fintech startup" }) });
    expect((body as { session_id: string }).session_id).toBe(sid);
  });
  test("404 for unknown session", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/onboard/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: "nope", message: "hi" }) });
    expect(res.status).toBe(404);
  });
  test("force draft and commit", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: started } = await req(app, "/onboard/start", { method: "POST" });
    const sid = (started as { session_id: string }).session_id;
    await req(app, "/onboard/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid, message: "We build rockets" }) });
    await req(app, "/onboard/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid, message: "Team of 10" }) });
    await req(app, "/onboard/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid, message: "Series A" }) });
    const { body: drafted } = await req(app, "/onboard/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid }) });
    expect((drafted as { phase: string }).phase).toBe("draft");
    const { res } = await req(app, "/onboard/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid }) });
    expect(res.status).toBe(200);
  });
  test("get session", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: started } = await req(app, "/onboard/start", { method: "POST" });
    const sid = (started as { session_id: string }).session_id;
    const { body } = await req(app, `/onboard/session/${sid}`);
    expect((body as { session_id: string }).session_id).toBe(sid);
  });
  test("validation: message required", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: started } = await req(app, "/onboard/start", { method: "POST" });
    const sid = (started as { session_id: string }).session_id;
    const { res } = await req(app, "/onboard/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid, message: "" }) });
    expect(res.status).toBe(400);
  });
});
