import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";

function fakeProvider(): Provider {
  return { name: "fake", defaultModel: "fake-model", async chat() { return "ok"; } };
}
function fakeSettings(): Settings {
  return { dbPath: ":memory:", port: 8787, publicServerUrl: "", allowedOrigins: [], morningBriefTime: "08:00", scheduledAdminToken: "", provider: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-chat", reasoningModel: "deepseek-reasoner", routingModel: "deepseek-chat", headers: {} } };
}
function appWith(db: ReturnType<typeof openDb>) {
  return createApp({ settings: fakeSettings(), db, provider: fakeProvider() });
}
async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app(new Request(`http://localhost${path}`, init));
  const body: unknown = await res.json().catch(() => null);
  return { res, body };
}

describe("talent — engagements", () => {
  test("create and get engagement", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "CTO" }) });
    expect(res.status).toBe(201);
    const eng = body as { id: number; role_title: string };
    expect(eng.role_title).toBe("CTO");
    const { body: fetched } = await req(app, `/engagements/${eng.id}`);
    expect((fetched as { role_title: string }).role_title).toBe("CTO");
  });
  test("list engagements", async () => {
    const db = openDb(); const app = appWith(db);
    await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "Eng A" }) });
    await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "Eng B" }) });
    const { body } = await req(app, "/engagements");
    expect((body as unknown[]).length).toBe(2);
  });
  test("404 for unknown engagement", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/engagements/9999");
    expect(res.status).toBe(404);
  });
  test("validation: role_title required", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(res.status).toBe(422);
  });
  test("patch engagement", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: created } = await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "Old" }) });
    const id = (created as { id: number }).id;
    const { body: patched } = await req(app, `/engagements/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "New" }) });
    expect((patched as { role_title: string }).role_title).toBe("New");
  });
  test("archive engagement", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: created } = await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "ToArchive" }) });
    const id = (created as { id: number }).id;
    const { res } = await req(app, `/engagements/${id}/archive`, { method: "POST" });
    expect(res.status).toBe(204);
    const { body: list } = await req(app, "/engagements");
    expect((list as unknown[]).length).toBe(0);
    const { body: withArchived } = await req(app, "/engagements?include_archived=true");
    expect((withArchived as unknown[]).length).toBe(1);
  });
  test("matches stub returns empty", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: created } = await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "MatchMe" }) });
    const id = (created as { id: number }).id;
    const { body } = await req(app, `/engagements/${id}/matches`);
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("talent — candidates", () => {
  test("create candidate requires engagement", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Alice", engagement_id: 9999 }) });
    expect(res.status).toBe(404);
  });
  test("create and list candidates", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: eng } = await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "Dev" }) });
    const eid = (eng as { id: number }).id;
    await req(app, "/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Alice", engagement_id: eid }) });
    await req(app, "/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Bob", engagement_id: eid }) });
    const { body } = await req(app, "/candidates");
    expect((body as unknown[]).length).toBe(2);
  });
  test("get candidate 404", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/candidates/9999");
    expect(res.status).toBe(404);
  });
  test("patch candidate", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: eng } = await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "Dev" }) });
    const eid = (eng as { id: number }).id;
    const { body: cand } = await req(app, "/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Alice", engagement_id: eid }) });
    const cid = (cand as { id: number }).id;
    const { body: patched } = await req(app, `/candidates/${cid}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Alicia" }) });
    expect((patched as { full_name: string }).full_name).toBe("Alicia");
  });
  test("stage transition", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: eng } = await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "Dev" }) });
    const eid = (eng as { id: number }).id;
    const { body: cand } = await req(app, "/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Alice", engagement_id: eid }) });
    const cid = (cand as { id: number }).id;
    const { body: staged } = await req(app, `/candidates/${cid}/stage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "screened" }) });
    expect((staged as { stage: string }).stage).toBe("screened");
  });
  test("archive candidate", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: eng } = await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "Dev" }) });
    const eid = (eng as { id: number }).id;
    const { body: cand } = await req(app, "/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Alice", engagement_id: eid }) });
    const cid = (cand as { id: number }).id;
    const { res } = await req(app, `/candidates/${cid}/archive`, { method: "POST" });
    expect(res.status).toBe(204);
  });
  test("similar stub", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: eng } = await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "Dev" }) });
    const eid = (eng as { id: number }).id;
    const { body: cand } = await req(app, "/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Alice", engagement_id: eid }) });
    const cid = (cand as { id: number }).id;
    const { body } = await req(app, `/candidates/${cid}/similar`);
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("talent — offers", () => {
  test("create offer and enforce one-open invariant", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: eng } = await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "Dev" }) });
    const eid = (eng as { id: number }).id;
    const { body: cand } = await req(app, "/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Alice", engagement_id: eid }) });
    const cid = (cand as { id: number }).id;
    const { res: r1 } = await req(app, "/offers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidate_id: cid, comp_summary: "100k" }) });
    expect(r1.status).toBe(201);
    const { res: r2 } = await req(app, "/offers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidate_id: cid, comp_summary: "120k" }) });
    expect(r2.status).toBe(409);
  });
  test("extend and decide offer", async () => {
    const db = openDb(); const app = appWith(db);
    const { body: eng } = await req(app, "/engagements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role_title: "Dev" }) });
    const eid = (eng as { id: number }).id;
    const { body: cand } = await req(app, "/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Alice", engagement_id: eid }) });
    const cid = (cand as { id: number }).id;
    const { body: offer } = await req(app, "/offers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidate_id: cid, comp_summary: "100k" }) });
    const oid = (offer as { id: number }).id;
    const { body: extended } = await req(app, `/offers/${oid}/extend`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect((extended as { offer: { status: string } }).offer.status).toBe("extended");
    const { body: decided } = await req(app, `/offers/${oid}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "accepted" }) });
    expect((decided as { offer: { status: string } }).offer.status).toBe("accepted");
  });
  test("404 for unknown offer", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/offers/9999");
    expect(res.status).toBe(404);
  });
});
