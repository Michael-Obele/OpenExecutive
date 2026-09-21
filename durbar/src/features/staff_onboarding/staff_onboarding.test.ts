import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
function fakeProvider(): Provider { return { name: "fake", defaultModel: "fake-model", async chat() { return "ok"; } }; }
function fakeSettings(): Settings { return { dbPath: ":memory:", port: 8787, publicServerUrl: "", allowedOrigins: [], morningBriefTime: "08:00", scheduledAdminToken: "", provider: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-chat", reasoningModel: "deepseek-reasoner", routingModel: "deepseek-chat", headers: {} } }; }
function appWith(db: ReturnType<typeof openDb>) { return createApp({ settings: fakeSettings(), db, provider: fakeProvider() }); }
async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) { const res = await app(new Request(`http://localhost${path}`, init)); const body: unknown = await res.json().catch(() => null); return { res, body }; }

describe("staff onboarding — templates", () => {
  test("create and get template", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/onboarding-templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "eng_onboarding", title: "Eng Onboarding" }) });
    expect(res.status).toBe(200);
    const { body } = await req(app, "/onboarding-templates/eng_onboarding");
    expect((body as { name: string }).name).toBe("eng_onboarding");
  });
  test("list templates", async () => {
    const db = openDb(); const app = appWith(db);
    await req(app, "/onboarding-templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "tmpl_a", title: "A" }) });
    await req(app, "/onboarding-templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "tmpl_b", title: "B" }) });
    const { body } = await req(app, "/onboarding-templates");
    expect((body as unknown[]).length).toBe(2);
  });
  test("404 for unknown template", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/onboarding-templates/nope");
    expect(res.status).toBe(404);
  });
  test("validation: name required", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/onboarding-templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "No Name" }) });
    expect(res.status).toBe(422);
  });
  test("delete template", async () => {
    const db = openDb(); const app = appWith(db);
    await req(app, "/onboarding-templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "to_delete", title: "Delete Me" }) });
    const { res } = await req(app, "/onboarding-templates/to_delete", { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});

describe("staff onboarding — plans", () => {
  test("create and get plan", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/onboarding-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Alice", start_date: "2026-10-01" }) });
    expect(res.status).toBe(201);
    const id = (body as { id: number }).id;
    const { body: fetched } = await req(app, `/onboarding-plans/${id}`);
    expect((fetched as { full_name: string }).full_name).toBe("Alice");
  });
  test("advance and activate plan", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: created } = await req(app, "/onboarding-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Bob", start_date: "2026-10-01" }) });
    const id = (created as { id: number }).id;
    const { body: advanced } = await req(app, `/onboarding-plans/${id}/advance`, { method: "POST" });
    expect((advanced as { current_phase: string }).current_phase).toBe("week_1");
    const { body: activated } = await req(app, `/onboarding-plans/${id}/activate`, { method: "POST" });
    expect((activated as { status: string }).status).toBe("active");
  });
  test("404 for unknown plan", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/onboarding-plans/9999");
    expect(res.status).toBe(404);
  });
  test("archive plan", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: created } = await req(app, "/onboarding-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Carol", start_date: "2026-10-01" }) });
    const id = (created as { id: number }).id;
    const { res } = await req(app, `/onboarding-plans/${id}/archive`, { method: "POST" });
    expect(res.status).toBe(204);
  });
});

describe("staff onboarding — tasks", () => {
  test("add and list tasks", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: plan } = await req(app, "/onboarding-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Dave", start_date: "2026-10-01" }) });
    const pid = (plan as { id: number }).id;
    await req(app, `/onboarding-plans/${pid}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Setup laptop" }) });
    const { body } = await req(app, `/onboarding-plans/${pid}/tasks`);
    expect((body as unknown[]).length).toBe(1);
  });
  test("task status update", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: plan } = await req(app, "/onboarding-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Eve", start_date: "2026-10-01" }) });
    const pid = (plan as { id: number }).id;
    const { body: task } = await req(app, `/onboarding-plans/${pid}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Task 1" }) });
    const tid = (task as { id: number }).id;
    const { body: updated } = await req(app, `/onboarding-tasks/${tid}/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done" }) });
    expect((updated as { status: string }).status).toBe("done");
  });
  test("activate and archive task", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: plan } = await req(app, "/onboarding-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Frank", start_date: "2026-10-01" }) });
    const pid = (plan as { id: number }).id;
    const { body: task } = await req(app, `/onboarding-plans/${pid}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Task X" }) });
    const tid = (task as { id: number }).id;
    const { body: activated } = await req(app, `/onboarding-tasks/${tid}/activate`, { method: "POST" });
    expect((activated as { status: string }).status).toBe("in_progress");
    const { res } = await req(app, `/onboarding-tasks/${tid}/archive`, { method: "POST" });
    expect(res.status).toBe(204);
  });
});
