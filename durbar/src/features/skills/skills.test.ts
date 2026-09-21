import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
function fakeProvider(): Provider { return { name: "fake", defaultModel: "fake-model", async chat() { return "ok"; } }; }
function fakeSettings(): Settings { return { dbPath: ":memory:", port: 8787, publicServerUrl: "", allowedOrigins: [], morningBriefTime: "08:00", eodDigestTime: "18:00", reflectionTime: "07:30", scheduledAdminToken: "", provider: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-chat", reasoningModel: "deepseek-reasoner", routingModel: "deepseek-chat", headers: {} } }; }
function appWith(db: ReturnType<typeof openDb>) { return createApp({ settings: fakeSettings(), db, provider: fakeProvider() }); }
async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) { const res = await app(new Request(`http://localhost${path}`, init)); const body: unknown = await res.json().catch(() => null); return { res, body }; }

describe("skills", () => {
  test("list skills", async () => {
    const db = openDb(); const app = appWith(db);
    const { res, body } = await req(app, "/skills");
    expect(res.status).toBe(200);
    expect(((body as { skills: unknown[] }).skills).length).toBeGreaterThan(0);
  });
  test("get skill", async () => {
    const db = openDb(); const app = appWith(db);
    const { body } = await req(app, "/skills/anvil");
    expect((body as { name: string }).name).toBe("anvil");
  });
  test("404 for unknown skill", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/skills/does-not-exist-xyz");
    expect(res.status).toBe(404);
  });
  test("search skills", async () => {
    const db = openDb(); const app = appWith(db);
    const { body } = await req(app, "/skills/search?q=anvil");
    expect(((body as { results: unknown[] }).results).length).toBeGreaterThan(0);
  });
  test("search requires q", async () => {
    const db = openDb(); const app = appWith(db);
    const { res } = await req(app, "/skills/search");
    expect(res.status).toBe(400);
  });
});
