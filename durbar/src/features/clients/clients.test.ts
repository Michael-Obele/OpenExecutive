import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
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
  return createApp({ settings: fakeSettings(), db, provider: fakeProvider() });
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

describe("clients", () => {
  test("create and get client", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Acme Corp" }),
    });
    expect(res.status).toBe(201);
    const slug = (body as { slug: string }).slug;
    const { body: fetched } = await req(app, `/clients/${slug}`);
    expect((fetched as { display_name: string }).display_name).toBe(
      "Acme Corp",
    );
  });
  test("list clients", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Client A" }),
    });
    await req(app, "/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Client B" }),
    });
    const { body } = await req(app, "/clients");
    expect((body as { clients: unknown[] }).clients.length).toBe(2);
  });
  test("404 for unknown client", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/clients/does-not-exist");
    expect(res.status).toBe(404);
  });
  test("validation: display_name required", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
  test("409 on duplicate slug", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Dup", slug: "dup-client" }),
    });
    const { res } = await req(app, "/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Dup2", slug: "dup-client" }),
    });
    expect(res.status).toBe(409);
  });
  test("patch client meta", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "PatchMe" }),
    });
    const slug = (created as { slug: string }).slug;
    const { body: patched } = await req(app, `/clients/${slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "Fractional CFO" }),
    });
    expect((patched as { role: string }).role).toBe("Fractional CFO");
  });
  test("cockpit returns cards", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Cockpit Client" }),
    });
    const { body } = await req(app, "/clients/cockpit");
    expect((body as { clients: unknown[] }).clients.length).toBeGreaterThan(0);
  });
  test("activate client", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Activate Me" }),
    });
    const slug = (created as { slug: string }).slug;
    const { res } = await req(app, `/clients/${slug}/activate`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
  });
  test("delete client", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Delete Me" }),
    });
    const slug = (created as { slug: string }).slug;
    const { res } = await req(app, `/clients/${slug}`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });
  test("generate requires description", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/clients/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
